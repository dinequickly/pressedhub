#!/usr/bin/env node
// Stress-test simulation generator for the Pressed Image Creator + Director
// stack.
//
// Synthesizes a realistic-feeling marketing dataset:
//   - A "harness" admin user (created on first run; persisted to
//     scripts/.out/harness-credentials.json) that owns all simulated rows.
//   - Synthetic Pressed-style products + multi-channel campaign briefs.
//   - Campaign rows in `campaigns` with source='simulated' so they're
//     wipeable independent of the seed-timeline data (which uses source='seed').
//   - Daily metric rows (sessions / revenue / orders / ctr / conversion)
//     joined to each campaign window via dimensions.campaign_id.
//   - A pool of `media_assets` rows owned by the harness user, *cloned* (same
//     storage_path) from the real admin's pressed-asset library so the agent's
//     list_media / attach_media_as_reference tools surface believable refs
//     without re-uploading any bytes.
//   - N vibe_boards owned by the harness user, each pre-populated with a
//     campaign brief note, a couple of reference media items, and N prompt
//     cards with realistic image-direction text. These are what the load
//     runner (run-campaign-load.mjs) drives the Director agent against.
//
// Idempotent on re-run: every simulated row is keyed off either
// source='simulated' (campaigns/metrics) or tag 'simulated-clone' /
// 'simulated-board' (media_assets/vibe_boards). Re-running wipes those rows
// only — the real admin's data, the seed-timeline data, and any in-progress
// real board work are all preserved.
//
// Usage:
//   npm run simulate-campaigns -- [flags]
//
// Flags:
//   --products N             (default 12)   Synthetic SKUs to invent.
//   --campaigns-per-product N (default 4)   Campaigns per product.
//   --boards N               (default 20)   Vibe boards to create.
//   --prompts-per-board N    (default 6)    Prompt cards per board.
//   --refs-per-board N       (default 2)    Reference images per board.
//   --metric-days N          (default 14)   Daily metric points per campaign.
//   --harness-email <addr>   (default harness+stress@pressed.test)
//   --harness-password <pw>  (default randomly generated and cached)
//   --no-wipe                              Skip the destructive cleanup of
//                                          prior simulated rows.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const SCRIPT_DIR = import.meta.dirname;
const OUT_DIR = resolve(SCRIPT_DIR, ".out");
const ENV_PATH = resolve(SCRIPT_DIR, "..", ".env");
const CREDS_PATH = resolve(OUT_DIR, "harness-credentials.json");

const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const SUPABASE_URL = env.EXTERNAL_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  fail("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env");
}

const args = parseArgs(process.argv.slice(2));
const N_PRODUCTS = intArg("products", 12);
const N_CAMPAIGNS_PER_PRODUCT = intArg("campaigns-per-product", 4);
const N_BOARDS = intArg("boards", 20);
const N_PROMPTS_PER_BOARD = intArg("prompts-per-board", 6);
const N_REFS_PER_BOARD = intArg("refs-per-board", 2);
const METRIC_DAYS = intArg("metric-days", 14);
const NO_WIPE = !!args.bool["no-wipe"];
const HARNESS_EMAIL = args.flags["harness-email"] ?? "harness+stress@pressed.test";
const HARNESS_PASSWORD_FLAG = args.flags["harness-password"];

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Top-level rng is shared across generators so re-runs with the same flags
// produce deterministic output.
const rng = mulberry32(42);

async function main() {
  const startedAt = Date.now();

  log("─ harness simulation ─");
  log(`supabase:               ${SUPABASE_URL}`);
  log(`products:               ${N_PRODUCTS}`);
  log(`campaigns/product:      ${N_CAMPAIGNS_PER_PRODUCT}`);
  log(`boards:                 ${N_BOARDS}`);
  log(`prompts/board:          ${N_PROMPTS_PER_BOARD}`);
  log(`refs/board:             ${N_REFS_PER_BOARD}`);
  log(`metric days/campaign:   ${METRIC_DAYS}`);

  // ─ harness user ────────────────────────────────────────────────────────

  const harness = await ensureHarnessUser(HARNESS_EMAIL, HARNESS_PASSWORD_FLAG);
  log(`harness user:           ${harness.email}  (id=${harness.id.slice(0, 8)}…)`);

  // ─ wipe prior simulated rows ───────────────────────────────────────────

  if (!NO_WIPE) {
    log("\n─ wiping prior simulated rows ─");
    await wipeSimulated(harness.id);
  }

  // ─ products + campaigns + metrics ──────────────────────────────────────

  const products = generateProducts(N_PRODUCTS);
  log(`\n─ products: ${products.length} ─`);
  for (const p of products.slice(0, 4)) log(`  · ${p.name}  ${p.size}  [${p.category}]`);
  if (products.length > 4) log(`  · … ${products.length - 4} more`);

  const campaigns = generateCampaigns(products, N_CAMPAIGNS_PER_PRODUCT);
  log(`\n─ campaigns: ${campaigns.length} ─`);

  const insertedCampaigns = await insertCampaigns(campaigns);
  log(`  inserted ${insertedCampaigns.length} campaign rows`);

  const metrics = generateMetrics(insertedCampaigns, METRIC_DAYS);
  log(`\n─ metrics: ${metrics.length} rows ─`);
  await insertMetricsInBatches(metrics, 500);
  log(`  inserted in batches`);

  // ─ cloned media pool ───────────────────────────────────────────────────

  log(`\n─ cloning media_assets to harness user ─`);
  const mediaPool = await cloneMediaPool(harness.id);
  log(`  pool: ${mediaPool.length} cloned assets`);

  // ─ vibe boards ─────────────────────────────────────────────────────────

  log(`\n─ vibe boards: ${N_BOARDS} ─`);
  const boards = [];
  for (let i = 0; i < N_BOARDS; i++) {
    const brief = pickBoardBrief(insertedCampaigns, products, i);
    const items = buildBoardItems(brief, mediaPool, {
      nPrompts: N_PROMPTS_PER_BOARD,
      nRefs: N_REFS_PER_BOARD,
    });
    const board = await insertBoard(harness.id, brief, items);
    boards.push({ id: board.id, brief });
    if ((i + 1) % 5 === 0 || i === N_BOARDS - 1) {
      log(`  + ${i + 1}/${N_BOARDS} boards`);
    }
  }

  // ─ manifest ────────────────────────────────────────────────────────────

  const manifest = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    supabase_url: SUPABASE_URL,
    harness: { id: harness.id, email: harness.email },
    totals: {
      products: products.length,
      campaigns: insertedCampaigns.length,
      metrics: metrics.length,
      media_clones: mediaPool.length,
      boards: boards.length,
    },
    boards: boards.map((b) => ({
      id: b.id,
      name: b.brief.boardName,
      campaign_id: b.brief.campaign.id,
      campaign_name: b.brief.campaign.name,
      channel: b.brief.campaign.channel,
      product_slug: b.brief.product.slug,
    })),
  };
  writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`\nmanifest:  scripts/.out/manifest.json`);
  log(`done in ${(manifest.duration_ms / 1000).toFixed(1)}s`);
}

// ═════════════════════════════════════════════════════════════════════════
// HARNESS USER LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════

async function ensureHarnessUser(email, passwordArg) {
  // Load cached credentials if they exist and the password wasn't overridden.
  let cached;
  if (existsSync(CREDS_PATH)) {
    try {
      cached = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
    } catch { /* ignore */ }
  }

  const password = passwordArg
    || cached?.password
    || `Harness-${randomBytes(10).toString("base64url")}`;

  // Look up the existing profile by email via service-role REST.
  const matches = await rest("GET",
    `/profiles?email=eq.${encodeURIComponent(email)}&select=id,email,role`);
  let id;
  if (matches.length > 0) {
    id = matches[0].id;
    // Promote if not already admin (the agent endpoints don't strictly need
    // admin, but campaigns RLS writes do — we use service-role for writes,
    // so this is mostly a convenience).
    if (matches[0].role !== "admin") {
      await rest("PATCH",
        `/profiles?id=eq.${encodeURIComponent(id)}`, { role: "admin" });
    }
  } else {
    // Create via GoTrue admin API. The DB trigger auto-creates a profiles row.
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      fail(`create harness user failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    id = body.id;
    // Wait briefly for the on-signup trigger to materialize the profiles row.
    for (let i = 0; i < 10; i++) {
      const p = await rest("GET",
        `/profiles?id=eq.${encodeURIComponent(id)}&select=id,role`);
      if (p[0]) {
        if (p[0].role !== "admin") {
          await rest("PATCH",
            `/profiles?id=eq.${encodeURIComponent(id)}`, { role: "admin" });
        }
        break;
      }
      await sleep(150);
    }
  }

  // If we created a new password (different from cached), update via admin API
  // so the load runner can sign in.
  if (!cached || cached.password !== password || cached.email !== email) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${id}`,
      {
        method: "PUT",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password, email_confirm: true }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      // 422 here usually means we don't need to update (e.g. cached pw still works).
      if (res.status !== 422) {
        fail(`update harness password failed: ${res.status} ${text.slice(0, 200)}`);
      }
    }
  }

  // Verify by signing in.
  const tokenRes = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    fail(`harness sign-in failed: ${tokenRes.status} ${text.slice(0, 200)}`);
  }
  const tok = await tokenRes.json();

  writeFileSync(CREDS_PATH, JSON.stringify({
    id, email, password,
    written_at: new Date().toISOString(),
  }, null, 2));

  return { id, email, password, jwt: tok.access_token };
}

async function wipeSimulated(harnessId) {
  // The order matters because of FK refs — boards → sessions optional, but
  // delete boards before media clones so the canvas state stops referencing
  // them. metrics → no FK to campaigns yet (it's just a JSONB dimension), so
  // order between those two doesn't matter.
  const wipes = [
    [`/vibe_boards?owner_id=eq.${harnessId}&state-%3E%3E%27meta_source%27=eq.simulated-board`, "vibe_boards (state filter)"],
    [`/vibe_boards?owner_id=eq.${harnessId}`, "vibe_boards (owner)"],
    [`/media_assets?owner_id=eq.${harnessId}&tags=cs.%7Bsimulated-clone%7D`, "media_assets clones"],
    [`/campaigns?source=eq.simulated`, "campaigns"],
    [`/metrics?source=eq.simulated`, "metrics"],
  ];
  for (const [path, label] of wipes) {
    try {
      await rest("DELETE", path);
      log(`  ✓ wiped ${label}`);
    } catch (err) {
      log(`  ! wipe ${label} failed (continuing): ${err.message}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// PRODUCTS + CAMPAIGNS
// ═════════════════════════════════════════════════════════════════════════

// Pressed-flavored product vocabulary. Mixes cold-press juice, wellness shots,
// probiotic lemonades, smoothies. Names are believable but synthetic — they
// don't collide with the real SKUs.
const PRODUCT_LINES = [
  { line: "cold-press citrus",   sizes: ["10oz", "15.2oz"], modifiers: ["Sunrise", "Sunset", "Honey", "Tangerine", "Grapefruit"], notes: ["bright + tangy", "naked-citrus forward", "no-sugar-added"], palette: "warm-citrus" },
  { line: "wellness shot",       sizes: ["2oz"],            modifiers: ["Immunity+", "Recovery", "Glow", "Focus", "Clarity"],     notes: ["punchy + functional", "ginger-led", "antioxidant blend"],  palette: "high-saturation" },
  { line: "probiotic lemonade",  sizes: ["10oz", "15.2oz"], modifiers: ["Blackberry", "Elderberry", "Mango Turmeric", "Strawberry Basil"], notes: ["effervescent, gut-friendly", "fizzy + bright"], palette: "playful-pastel" },
  { line: "daily greens",        sizes: ["10oz", "15.2oz"], modifiers: ["Original", "Ginger", "Cucumber Lemon", "Pineapple Mint"], notes: ["chlorophyll-forward", "clean + grassy"], palette: "verdant" },
  { line: "wellness smoothie",   sizes: ["10oz"],           modifiers: ["Acai Berry", "Strawberry Orange Mango", "Tropical"],     notes: ["creamy, dessert-adjacent", "thicker mouthfeel"], palette: "berry-jewel" },
  { line: "hydration",           sizes: ["15.2oz"],         modifiers: ["Dragon Fruit", "Coconut Water", "Watermelon"],           notes: ["clean, electrolyte-rich"],                       palette: "tropical-cool" },
  { line: "cleanse",             sizes: ["set"],            modifiers: ["Express Cleanse", "1-Day Reset", "Founder's Cleanse"],   notes: ["editorial, story-led packaging"],                palette: "neutral-editorial" },
  { line: "limited-edition drop", sizes: ["10oz", "set"],   modifiers: ["Mother's Day Citrus", "Spring Floral", "Summer Sun"],    notes: ["seasonal hero", "narrative-led"],                palette: "seasonal-hero" },
];

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function generateProducts(n) {
  const out = [];
  let i = 0;
  while (out.length < n) {
    const line = PRODUCT_LINES[i % PRODUCT_LINES.length];
    const mod = line.modifiers[Math.floor(rng() * line.modifiers.length)];
    const size = line.sizes[Math.floor(rng() * line.sizes.length)];
    const name = `${mod} ${capitalize(line.line)}`;
    const slug = slugify(`${mod}-${line.line}-${size}`);
    // Dedup
    if (out.some((p) => p.slug === slug)) { i++; continue; }
    const note = line.notes[Math.floor(rng() * line.notes.length)];
    out.push({
      slug,
      name,
      size,
      category: line.line,
      palette: line.palette,
      tagline: `${capitalize(note)}. ${size}.`,
    });
    i++;
  }
  return out;
}

const CHANNELS = ["email", "paid", "organic", "in_store", "retail"];

const COHORTS = [
  "Tier 1 loyalty", "Tier 2+ loyalty", "lapsed Q4 buyers", "first-time DTC",
  "wellness-adjacent prospecting", "NYC + LA flagship walk-ins",
  "Pinterest discovery cohort", "weekly subscribers", "creator-seeded audiences",
];

const AESTHETICS = [
  "warm editorial", "high-key minimalist", "candid lifestyle", "studio-flat with hand props",
  "moody jewel-tone", "cinema-noir close-up", "golden-hour wellness", "soft-pink editorial",
  "1990s catalog still life", "playful pastel pop", "earthy + tactile", "luxe spa minimalism",
];

const PALETTE_BY_NAME = {
  "warm-citrus": "warm peach + sunlit cream + cadmium orange",
  "high-saturation": "neon yellow + tangerine + cobalt accent",
  "playful-pastel": "candy-floss pink + mint + butter-yellow",
  "verdant": "fresh basil + matte sage + chalk-white",
  "berry-jewel": "amethyst + ruby + soft cream",
  "tropical-cool": "aquamarine + watermelon + sand",
  "neutral-editorial": "warm cream + bone + bronze accents",
  "seasonal-hero": "rosy gold + ivory + soft shadow",
};

function generateCampaigns(products, perProduct) {
  const out = [];
  const start = new Date(Date.now() - 90 * 86400_000);
  for (const p of products) {
    for (let i = 0; i < perProduct; i++) {
      const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)];
      const cohort = COHORTS[Math.floor(rng() * COHORTS.length)];
      const aesthetic = AESTHETICS[Math.floor(rng() * AESTHETICS.length)];
      const dur = 4 + Math.floor(rng() * 14);
      const offsetDays = Math.floor(rng() * 120);
      const startedAt = new Date(start.getTime() + offsetDays * 86400_000);
      const endedAt = new Date(startedAt.getTime() + dur * 86400_000);
      const phase = i === 0 ? "teaser" : i === 1 ? "launch" : i === 2 ? "always-on" : "retro";
      const name = `${p.name} — ${capitalize(phase)} (${channel})`;
      const description = synthesizeBrief({ product: p, channel, cohort, aesthetic, phase });
      out.push({
        name, channel,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        description,
        source: "simulated",
        source_id: `sim:${p.slug}:${phase}:${i}`,
        metadata: {
          product_slug: p.slug,
          phase,
          cohort,
          aesthetic,
          palette: p.palette,
          palette_text: PALETTE_BY_NAME[p.palette] ?? "",
        },
      });
    }
  }
  return out;
}

function synthesizeBrief({ product, channel, cohort, aesthetic, phase }) {
  const channelHook = {
    email: "Hero email + 1 follow-up. Single, strong subject line.",
    paid: "Meta + TikTok creative variants (5x). Lower-funnel emphasis.",
    organic: "IG carousel + Reels cutdown + 2 TikToks; founder voice optional.",
    in_store: "Endcap + sampling kit for flagship + 60 partner stores.",
    retail: "Shelf-talker, FSI, retailer-co-branded display banners.",
  }[channel];
  return (
    `${capitalize(phase)} campaign for ${product.name} (${product.size}). ` +
    `Target ${cohort}. Visual direction: ${aesthetic}, ${PALETTE_BY_NAME[product.palette] ?? product.palette} palette. ` +
    `Channel deliverables: ${channelHook}`
  );
}

async function insertCampaigns(rows) {
  // Insert in one shot — campaigns are small.
  const inserted = await rest("POST", "/campaigns", rows);
  return inserted;
}

// ─ metrics ───────────────────────────────────────────────────────────────

function generateMetrics(campaigns, days) {
  const out = [];
  for (const c of campaigns) {
    const start = new Date(c.started_at);
    const end = new Date(c.ended_at);
    const window = Math.min(days, Math.max(1, Math.round((end - start) / 86400_000)));
    const seed = hashString(c.id);
    const r = mulberry32(seed);
    const baseSessions = 800 + Math.floor(r() * 6000);
    const baseRevenue = 350 + Math.floor(r() * 2400);
    const baseOrders = 12 + Math.floor(r() * 80);
    const baseCtr = 1.4 + r() * 2.6;
    const baseConv = 0.9 + r() * 2.2;
    for (let d = 0; d < window; d++) {
      const day = new Date(start.getTime() + d * 86400_000);
      const dayJitter = 0.7 + r() * 0.6;
      const occ = day.toISOString();
      const dim = { campaign_id: c.id, channel: c.channel, product_slug: c.metadata?.product_slug };
      out.push({ kind: "sessions",   occurred_at: occ, value: Math.round(baseSessions * dayJitter), dimensions: dim, source: "simulated" });
      out.push({ kind: "revenue",    occurred_at: occ, value: Number((baseRevenue * dayJitter).toFixed(2)), dimensions: dim, source: "simulated" });
      out.push({ kind: "orders",     occurred_at: occ, value: Math.round(baseOrders * dayJitter), dimensions: dim, source: "simulated" });
      out.push({ kind: "ctr",        occurred_at: occ, value: Number((baseCtr * dayJitter).toFixed(2)), dimensions: dim, source: "simulated" });
      out.push({ kind: "conversion", occurred_at: occ, value: Number((baseConv * dayJitter).toFixed(2)), dimensions: dim, source: "simulated" });
    }
  }
  return out;
}

async function insertMetricsInBatches(rows, size) {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    await rest("POST", "/metrics", slice, { silent: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// MEDIA CLONE POOL
// ═════════════════════════════════════════════════════════════════════════

// Pull a sample of pressed-asset media_assets owned by *anyone*, then clone
// the rows under the harness user — same storage_path (the service-role
// download in the agent's attach_media_as_reference tool reads bytes
// directly without RLS, so it doesn't matter that the storage object lives
// under a different user's prefix).
async function cloneMediaPool(harnessId) {
  // Already cloned? Skip re-cloning to keep ids stable across runs.
  const existing = await rest("GET",
    `/media_assets?owner_id=eq.${harnessId}&tags=cs.%7Bsimulated-clone%7D&select=id,name,tags&limit=200`);
  if (existing.length > 0) {
    log(`  reusing ${existing.length} prior clones (skip re-clone)`);
    return existing;
  }

  // Sample real pressed-assets — front-1400x1400 imagery + a smattering of
  // categorized images.
  const sources = await rest("GET",
    `/media_assets?tags=cs.%7Bpressed-assets%7D&select=id,name,mime,size_bytes,width,height,storage_path,tags&limit=200`);
  if (sources.length === 0) {
    log("  no pressed-assets found to clone — pool will be empty");
    return [];
  }

  // Insert clones in one batch.
  const toInsert = sources.map((s) => ({
    id: randomUUID(),
    owner_id: harnessId,
    name: s.name,
    storage_path: s.storage_path,
    mime: s.mime,
    size_bytes: s.size_bytes,
    width: s.width,
    height: s.height,
    tags: ["simulated-clone", ...(s.tags || []).filter((t) => t !== "pressed-assets")],
  }));
  const inserted = await rest("POST", "/media_assets", toInsert);
  return inserted;
}

// ═════════════════════════════════════════════════════════════════════════
// BOARDS
// ═════════════════════════════════════════════════════════════════════════

function pickBoardBrief(campaigns, products, i) {
  const c = campaigns[i % campaigns.length];
  const product = products.find((p) => p.slug === c.metadata?.product_slug) ?? products[0];
  const aesthetic = c.metadata?.aesthetic ?? "warm editorial";
  const palette = c.metadata?.palette_text ?? "";
  const cohort = c.metadata?.cohort ?? "Tier 1 loyalty";
  const boardName = `${c.name.replace(/\s*\(.+\)\s*$/, "")} — vibe board`;
  return { campaign: c, product, aesthetic, palette, cohort, boardName };
}

function buildBoardItems(brief, mediaPool, opts) {
  const items = [];
  // Match category tag where possible to keep references on-product.
  const categorySlug = slugify(brief.product.category);
  const refsForProduct = mediaPool.filter((m) =>
    (m.tags || []).some((t) => t.includes(categorySlug) || t === slugify(brief.product.name))
  );
  const refPool = refsForProduct.length >= opts.nRefs ? refsForProduct : mediaPool;
  const refs = sample(refPool, opts.nRefs);

  // The campaign brief as a note item (top-left).
  items.push({
    id: `it_${randomBytes(4).toString("hex")}`,
    type: "note",
    x: 60,
    y: 60,
    text: `Brief: ${brief.campaign.description}\n\nTarget cohort: ${brief.cohort}.\nAesthetic: ${brief.aesthetic}.\nPalette: ${brief.palette || brief.product.palette}.`,
  });

  // Reference images.
  refs.forEach((m, k) => {
    items.push({
      id: `it_${randomBytes(4).toString("hex")}`,
      type: "reference",
      x: 60 + k * 320,
      y: 280,
      // Note: anthropic_file_id is null until the agent attaches it via
      // attach_media_as_reference — the canvas + read_board accept either.
      media_asset_id: m.id,
      name: m.name,
      caption: `Reference: ${m.name}`,
    });
  });

  // Prompt cards. Vary by channel deliverable and aesthetic.
  const promptVariations = [
    `hero campaign shot of {product}, {aesthetic}, {palette}, magazine-grade composition`,
    `lifestyle still life with {product} in foreground, {aesthetic} mood, hand-styled props`,
    `editorial close-up macro of {product} label, {palette} color story, soft directional light`,
    `flat-lay variant for paid social, {product} + complementary props, {aesthetic} treatment`,
    `email hero crop 16:9, {product}, narrative-led, {palette}`,
    `in-store sampling kit hero, {product} on linen, {aesthetic}, retail-grade clarity`,
    `Reels thumbnail variant, {product}, motion-blur background, {palette} palette`,
    `subscriber-only loyalty hero, {product}, intimate framing, {aesthetic} mood`,
  ];

  for (let k = 0; k < opts.nPrompts; k++) {
    const tpl = promptVariations[k % promptVariations.length];
    const text = tpl
      .replaceAll("{product}", brief.product.name)
      .replaceAll("{aesthetic}", brief.aesthetic)
      .replaceAll("{palette}", brief.palette || brief.product.palette);
    items.push({
      id: `it_${randomBytes(4).toString("hex")}`,
      type: "prompt",
      x: 60 + (k % 4) * 320,
      y: 520 + Math.floor(k / 4) * 220,
      text,
      model: k % 3 === 0 ? "gemini-quality" : "gemini-fast",
    });
  }

  return items;
}

async function insertBoard(ownerId, brief, items) {
  const row = await rest("POST", "/vibe_boards", {
    owner_id: ownerId,
    name: brief.boardName,
    state: {
      // Custom marker so the wipe step can target simulated boards without
      // also nuking any hand-made boards owned by the harness user.
      meta_source: "simulated-board",
      campaign_id: brief.campaign.id,
      product_slug: brief.product.slug,
      channel: brief.campaign.channel,
      items,
    },
  });
  return row[0];
}

// ═════════════════════════════════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════════════════════════════════

async function rest(method, path, body, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" || method === "PATCH" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 250)}`);
  }
  if (res.status === 204 || method === "DELETE") return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[0].trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function parseArgs(argv) {
  const flags = {};
  const bool = {};
  const positional = [];
  for (const raw of argv) {
    if (!raw.startsWith("--")) { positional.push(raw); continue; }
    const eq = raw.indexOf("=");
    if (eq === -1) { bool[raw.slice(2)] = true; }
    else { flags[raw.slice(2, eq)] = raw.slice(eq + 1); }
  }
  return { flags, bool, positional };
}

function intArg(name, def) {
  const v = args.flags[name];
  if (v == null) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sample(arr, k) {
  if (!arr.length) return [];
  const out = [];
  const used = new Set();
  while (out.length < k && used.size < arr.length) {
    const i = Math.floor(rng() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]);
  }
  return out;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function log(s) { process.stdout.write(`${s}\n`); }
function fail(s) { process.stderr.write(`error: ${s}\n`); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Run last — top-level await is here so all const declarations above are
// fully initialized before main() reads them (otherwise PRODUCT_LINES et al.
// hit the temporal dead zone when called from a function-scoped reference).
await main();
