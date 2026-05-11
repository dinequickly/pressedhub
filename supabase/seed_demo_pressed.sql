-- Idempotent demo seed: Maya Chen, Head of FP&A at Pressed Juicery.
-- Targets the most-recently created profile (the user who just signed up).
-- Re-running drops anything tagged with the marker and recreates from scratch.

do $$
declare
  v_user uuid;
  v_marker text := 'pressed_demo_v1';

  s_close uuid := gen_random_uuid();
  s_kpis uuid := gen_random_uuid();
  s_vendor uuid := gen_random_uuid();
  s_forecast uuid := gen_random_uuid();

  a_treasury uuid := gen_random_uuid();
  a_vendor uuid := gen_random_uuid();
  a_flux uuid := gen_random_uuid();
  a_close uuid := gen_random_uuid();
  a_board uuid := gen_random_uuid();
  a_cohort uuid := gen_random_uuid();

  e_finance uuid := gen_random_uuid();
  e_ops uuid := gen_random_uuid();

  f_board uuid := gen_random_uuid();
  f_close uuid := gen_random_uuid();
  f_vendor uuid := gen_random_uuid();
  f_daily uuid := gen_random_uuid();
  f_models uuid := gen_random_uuid();

  ss1 uuid := gen_random_uuid();
  ss2 uuid := gen_random_uuid();
  ss3 uuid := gen_random_uuid();
  ss4 uuid := gen_random_uuid();

  app_daily uuid := gen_random_uuid();
  app_vendor uuid := gen_random_uuid();
  app_close uuid := gen_random_uuid();
  app_board uuid := gen_random_uuid();
  app_cohort uuid := gen_random_uuid();
begin
  select id into v_user from public.profiles order by created_at desc limit 1;
  if v_user is null then raise exception 'Sign in once before seeding.'; end if;

  -- 1) Profile: rename to Maya Chen, Pressed brand greens.
  update public.profiles
     set name = 'Maya Chen',
         initial = 'M',
         tint = 'from-emerald-400 to-teal-400',
         role = 'admin'
   where id = v_user;

  -- 2) Wipe any previous run of this seed.
  delete from public.dreams       where instructions like '%[' || v_marker || ']%';
  delete from public.memory_documents where store_id in (select id from public.memory_stores where description like '%[' || v_marker || ']%');
  delete from public.memory_tables    where store_id in (select id from public.memory_stores where description like '%[' || v_marker || ']%');
  delete from public.memory_stores    where description like '%[' || v_marker || ']%';
  delete from public.session_events   where session_id in (select id from public.sessions where trigger_summary like '%[' || v_marker || ']%');
  delete from public.sessions         where trigger_summary like '%[' || v_marker || ']%';
  delete from public.kb_chunks        where file_id in (select id from public.kb_files where snippet like '%[' || v_marker || ']%');
  delete from public.kb_files         where snippet like '%[' || v_marker || ']%';
  delete from public.kb_folders       where name like 'pressed_%';
  delete from public.app_deployments  where app_id in (select id from public.apps where description like '%[' || v_marker || ']%');
  delete from public.apps             where description like '%[' || v_marker || ']%';
  delete from public.vault_connections where account_label like '%@pressedjuicery.com' or account_label like '#%@pressed';
  delete from public.skills           where description like '%[' || v_marker || ']%';
  -- Also wipe any same-id Anthropic skills left behind by earlier smoke tests.
  delete from public.skills           where type = 'anthropic' and anthropic_skill_id in ('xlsx','pdf','docx');
  delete from public.mcp_servers      where description like '%[' || v_marker || ']%';
  delete from public.agents           where instructions like '%[' || v_marker || ']%';
  delete from public.environments     where name like 'pressed-%';

  -- 3) Memory stores.
  insert into public.memory_stores (id, name, description, scope, owner_id, total_versions) values
    (s_close,    'Q3 close memo',         'Drafts, checklists, and flux narratives for the Q3 2026 close. [' || v_marker || ']', 'workflow', v_user, 12),
    (s_kpis,     'Investor KPIs',         'Canonical KPI definitions used across the board deck and IR Q&A. [' || v_marker || ']', 'shared',   v_user, 8),
    (s_vendor,   'Vendor playbook',       'Per-supplier heuristics: pricing tiers, payment terms, fallback options. [' || v_marker || ']', 'user', v_user, 5),
    (s_forecast, 'Forecast assumptions',  'The master assumption set behind the 5-year LRP. [' || v_marker || ']', 'shared', v_user, 9);

  -- 4) Memory documents.
  insert into public.memory_documents (store_id, path, content, size_bytes, version_count) values
    (s_close, 'close-checklist.md',
     E'# Q3 close checklist\n\n- [x] Bank recs (treasury)\n- [x] Inventory cutoff @ store level\n- [x] Royalty accrual — partner fee true-up\n- [ ] AR aging review with collections\n- [ ] Lease accounting — Topic 842 reconciliation\n- [ ] Tax provision draft to Deloitte\n- [ ] Audit committee pre-read\n\n_Owner: Maya · Due: 2026-10-14_',
     420, 4),
    (s_close, 'q3-narrative-draft.md',
     E'# Q3 2026 narrative — draft v3\n\nRevenue grew **8.4% YoY** to $42.1M, ahead of the +6.0% plan. Same-store sales contributed +5.1pp; net new doors contributed +3.3pp.\n\nGross margin landed at 56.8%, 80bps below plan, driven by higher cold-press cost (organic kale up 14% YoY in Q3).\n\nOpex came in $0.4M favorable to plan from delayed mobile-app rollout. Adjusted EBITDA $7.1M, +12% YoY, 16.8% margin.\n\n_Note: replace placeholder cohort retention chart before send to board._',
     560, 7),
    (s_close, 'flux-explanations.md',
     E'# Flux vs plan ($k)\n\n| Line | Var | Driver |\n|---|---|---|\n| Revenue | +1,180 | Catering + walk-in mix |\n| COGS | (650) | Organic produce inflation |\n| Marketing | (420) | Brand campaign pushed into Q4 |\n| G&A | (90) | One-time severance, dept reorg |\n| Total EBIT | +20 | Mix shift saved gross margin |',
     280, 2),
    (s_kpis, 'kpi-definitions.md',
     E'# KPI definitions\n\n- **SSS (same-store sales)**: stores open ≥13 months, comparable basis, excluding closures and remodels >30 days.\n- **AOV**: gross revenue ÷ orders, before discounts and refunds.\n- **Door count**: signed leases minus permanently shuttered, end-of-period.\n- **Subscription churn**: lapsed subs ÷ start-of-period active subs (logo, not revenue).\n- **Adj. EBITDA**: GAAP EBITDA + stock-comp + non-recurring.',
     410, 3),
    (s_kpis, 'same-store-sales.md',
     E'# Same-store sales — Q3 2026\n\n| Region | YoY | Driver |\n|---|---|---|\n| West | +6.8% | Catering surge, LA + SF |\n| Northeast | +4.1% | Cold-press SKU launch |\n| Texas | +2.9% | New flavors, AOV +5% |\n| Southeast | (1.2%) | Hurricane disruption (FL) |',
     230, 2),
    (s_kpis, 'cohort-retention.md',
     E'# Cohort retention\n\nM12 retention for the 2025-Q3 acquisition cohort: **38%**, up from 34% in 2024-Q3.\nKey driver: subscription tier migration to weekly delivery.\n\nNet revenue retention for active subs: 112%.',
     220, 1),
    (s_vendor, 'cold-press-suppliers.md',
     E'# Cold-press produce suppliers\n\n- **Earthbound Organics** — primary kale, $/lb tier 1 at >50k lb/wk; net-30; backup: Driscoll fields.\n- **Sun-Pacific** — citrus, contract through 2027-Q2; index-linked to USDA West.\n- **Thomson Intl.** — root veg + ginger; spot pricing only; quality issues 2x in 2026.\n- **Mission Produce** — avocado, used for the new "Greens+ avo" line.',
     360, 5),
    (s_vendor, 'bottle-vendor-history.md',
     E'# Glass bottle vendors\n\nPrimary: **O-I Glass** (Toledo). 16oz price/unit $0.42 (locked through 2027).\nBackup: **Ardagh** — 12% premium, 8wk lead time. Avoid for new SKUs.\n\n_Risk note: O-I labor contract negotiations Feb 2027. Lock secondary by Q4._',
     280, 2),
    (s_vendor, 'distribution-rates.md',
     E'# Distribution\n\n- DSD partner: **Lineage Logistics** in West; **Americold** in NE/SE.\n- Cold-chain breakage rate: 0.6% (vs 1.2% with prior carrier).\n- Per-case landed cost decreasing 3% YoY from route density.',
     230, 2),
    (s_forecast, 'revenue-drivers.md',
     E'# Revenue drivers (LRP base case)\n\n- 18 net new doors / year, ramping to mature in month 14\n- Mature-store AUV: $1.35M (vs. $1.22M in 2026)\n- Subscription mix to 22% of total by 2028 (from 14% today)\n- AOV growth +3.5% / yr',
     310, 4),
    (s_forecast, 'cogs-assumptions.md',
     E'# COGS assumptions\n\n- Produce inflation: **4% / yr blended** (organic premium ~7%)\n- Bottle unit cost: flat through 2027 (locked contract)\n- Distribution: 1.8% of net revenue, declining as mix shifts to subscription',
     280, 3),
    (s_forecast, 'opex-assumptions.md',
     E'# Opex assumptions\n\n- Marketing: 8% of revenue, weighted to Q1 + Q3 promo windows\n- Tech: $4.2M / yr capex, half in mobile-app modernization\n- G&A: 6% of revenue, declining 50bps / yr from leverage',
     250, 2);

  -- 5) Memory tables.
  insert into public.memory_tables (store_id, name, schema) values
    (s_kpis,   'kpi_targets', '{"columns":[{"name":"kpi","type":"text"},{"name":"q3_actual","type":"number"},{"name":"q3_plan","type":"number"},{"name":"fy_target","type":"number"}]}'),
    (s_vendor, 'price_history', '{"columns":[{"name":"vendor","type":"text"},{"name":"sku","type":"text"},{"name":"price_per_lb","type":"number"},{"name":"effective","type":"date"}]}');

  -- 6) Environments (visual only — no anthropic_id since we'd need a key).
  insert into public.environments (id, name, config, created_by) values
    (e_finance, 'pressed-finance-py',
     '{"type":"cloud","networking":{"type":"unrestricted"},"packages":{"pip":["pandas","numpy","openpyxl","scikit-learn","matplotlib"]}}',
     v_user),
    (e_ops, 'pressed-ops-node',
     '{"type":"cloud","networking":{"type":"limited","allowed_hosts":["api.snowflake.com","api.linear.app","api.stripe.com"],"allow_mcp_servers":true,"allow_package_managers":true},"packages":{"npm":["@octokit/rest"]}}',
     v_user);

  -- 7) Agents.
  insert into public.agents (id, name, role, emoji, accent, model, system_prompt, instructions, created_by, outcome) values
    (a_treasury, 'Treasury Bot', 'Daily cash + AP runway', '🏦', 'sky', 'claude-sonnet-4-6',
     'You are a treasury analyst at Pressed Juicery. Run the daily cash position report, flag AP > $250k due in the next 7 days, and post a one-paragraph summary to #finance.',
     'Read /mnt/session/inputs/cash_balances.csv, sum by entity, compare against the 4-week forecast in s3://pressed-finance/cash_forecast.parquet, and write the summary to /mnt/session/outputs/daily_cash.md. [' || v_marker || ']',
     v_user, null),
    (a_vendor, 'Vendor Hawk', 'Pricing anomaly hunter', '🦅', 'amber', 'claude-opus-4-7',
     'You are a strategic-sourcing analyst. Watch for price moves > 4% week-over-week on any tracked SKU. Cross-reference contract terms before flagging.',
     'Pull this week''s prices from Snowflake table `vendor_prices`, compare to the 13-week trailing avg, and write a flagged anomalies report. [' || v_marker || ']',
     v_user, '{"description":"Identify and rank top 5 pricing anomalies for the week with contract context","rubric_md":"# Vendor anomaly rubric\n- All flagged anomalies are >4% WoW\n- Each cites the relevant contract clause\n- Top 5 ranked by $ impact\n- Output is a single markdown table","max_iterations":3}'),
    (a_flux, 'Flux Explainer', 'Variance analysis', '📊', 'violet', 'claude-opus-4-7',
     'You are an FP&A analyst. Given an actuals vs plan P&L, produce a flux narrative grouped by driver category, never by line item alone.',
     'Use Q3 actuals from /mnt/session/inputs/q3_actuals.xlsx and the LRP base case from /mnt/session/inputs/lrp_base.xlsx. Output: /mnt/session/outputs/q3_flux_narrative.md. [' || v_marker || ']',
     v_user, null),
    (a_close, 'Close Coordinator', 'Month-end orchestrator', '🗂', 'emerald', 'claude-sonnet-4-6',
     'You are the close manager. Walk through the close-checklist memory doc, verify each completed item against the underlying system, and surface blockers.',
     'Pull the latest close-checklist.md from the Q3 close memo store. For each [x] item, verify in QuickBooks/Snowflake. For each [ ] item, ping the owner. [' || v_marker || ']',
     v_user, null),
    (a_board, 'Board Drafter', 'Narrative first drafts', '📝', 'fuchsia', 'claude-opus-4-7',
     'You draft the quarterly board narrative in Pressed''s house voice: confident, specific, no hedging adverbs.',
     'Use Q3 actuals + Investor KPIs store + same-store-sales doc. Output a 5-paragraph narrative + one sidebar callout per region. [' || v_marker || ']',
     v_user, '{"description":"Q3 2026 board narrative draft","rubric_md":"# Narrative rubric\n- 5 paragraphs, ~600 words total\n- Every claim has a number\n- No hedging adverbs (probably, somewhat, fairly, etc.)\n- Includes per-region callout","max_iterations":4}'),
    (a_cohort, 'Cohort Crawler', 'Customer retention deep dives', '🔬', 'rose', 'claude-opus-4-7',
     'You explore subscription cohort behavior. Always segment by acquisition channel before drawing conclusions.',
     'Query BigQuery `subs.cohort_monthly`, run the standard 12-month curves segmented by channel, and write a memo to the Investor KPIs store. [' || v_marker || ']',
     v_user, null);

  -- 8) Skills.
  insert into public.skills (type, name, description, content_md, anthropic_skill_id, pinned, created_by) values
    ('anthropic', 'Excel (xlsx)', 'Anthropic prebuilt for spreadsheet operations. [' || v_marker || ']', '', 'xlsx', true, v_user),
    ('anthropic', 'PDF',          'Anthropic prebuilt for PDF parse + render. [' || v_marker || ']', '', 'pdf', false, v_user),
    ('anthropic', 'Word (docx)',  'Anthropic prebuilt for Word docs. [' || v_marker || ']', '', 'docx', false, v_user),
    ('custom',    'DCF rubric',   'Self-grading rubric for any DCF deliverable. [' || v_marker || ']',
     E'# DCF rubric\n## Revenue projections\n- Uses ≥5 years of historical revenue\n- Forward projections ≥5 years\n## Cost structure\n- COGS and OPEX modelled separately\n## Discount rate\n- WACC stated with cost of equity + cost of debt\n## Terminal value\n- Either perpetuity or exit multiple, stated which\n## Output\n- Single .xlsx with sheets: Inputs, Outputs, Sensitivity', null, true, v_user),
    ('custom',    'Variance analysis playbook', 'House style for flux explanations. [' || v_marker || ']',
     E'# Variance playbook\n## Always group by driver\n- Mix vs price vs volume\n- Drop the line-item view; nobody cares which GL account\n## Use ranges, not point estimates\n- Always cite a "X to Y" range with a midpoint\n## Format\n- Markdown table with: line, var($k), driver, owner', null, true, v_user),
    ('custom',    'Board deck QC', 'Pre-board sanity checks. [' || v_marker || ']',
     E'# Board QC\n- Every chart has a footer source\n- All YoY % match the underlying data tab\n- KPI definitions reference the canonical doc\n- No placeholder text (TKTK, lorem, …)\n- Spell-check passed', null, false, v_user),
    ('custom',    'Quarterly close runbook', 'Step-by-step for month-end / quarter-end. [' || v_marker || ']',
     E'# Close runbook\n## Day -3\n- Bank recs\n- Inventory cutoff\n## Day -1\n- Royalty accruals\n- AR aging review\n## Day 0\n- Lease reconciliation\n- Tax provision draft\n## Day +2\n- Audit committee pre-read', null, false, v_user);

  -- 9) MCP servers.
  insert into public.mcp_servers (name, url, description, created_by) values
    ('snowflake-mcp', 'https://mcp.snowflake.com/mcp', 'Snowflake MCP for warehouse queries. [' || v_marker || ']', v_user),
    ('linear-mcp',    'https://mcp.linear.app/mcp',     'Linear MCP for project tracking. [' || v_marker || ']', v_user),
    ('notion-mcp',    'https://mcp.notion.com/mcp',     'Notion MCP for the IR knowledge base. [' || v_marker || ']', v_user);

  -- 10) Vault connections (visual only — no anthropic ids; status=connected).
  insert into public.vault_connections
    (user_id, connector_id, account_label, status, scopes, mcp_server_url, connected_at, last_used_at)
  values
    (v_user, 'quickbooks', 'ap@pressedjuicery.com',          'connected',
       array['accounting:read','accounting:write'],          null,
       now() - interval '12 days',  now() - interval '6 hours'),
    (v_user, 'snowflake',  'maya@pressedjuicery.com',         'connected',
       array['warehouse:read'],                              'https://mcp.snowflake.com/mcp',
       now() - interval '40 days',  now() - interval '2 hours'),
    (v_user, 'bigquery',   'maya@pressedjuicery.com',         'connected',
       array['bigquery.dataViewer'],                         null,
       now() - interval '60 days',  now() - interval '1 day'),
    (v_user, 'stripe',     'finance@pressedjuicery.com',      'connected',
       array['rak_read'],                                    null,
       now() - interval '210 days', now() - interval '3 days'),
    (v_user, 'salesforce', 'catering@pressedjuicery.com',     'expired',
       array['api','refresh_token'],                         null,
       now() - interval '90 days',  now() - interval '5 days'),
    (v_user, 'slack',      '#finance@pressedjuicery.com',     'connected',
       array['chat:write','channels:read'],                  'https://mcp.slack.com/mcp',
       now() - interval '300 days', now() - interval '4 hours'),
    (v_user, 'gmail',      'maya@pressedjuicery.com',         'connected',
       array['gmail.readonly','gmail.send'],                 null,
       now() - interval '365 days', now() - interval '1 hour'),
    (v_user, 'google_drive','maya@pressedjuicery.com',        'connected',
       array['drive.file'],                                  null,
       now() - interval '365 days', now() - interval '12 hours'),
    (v_user, 'github',     'pressed-finance bot',             'connected',
       array['repo'],                                        null,
       now() - interval '180 days', now() - interval '8 days'),
    (v_user, 'notion',     'maya@pressedjuicery.com',         'never',
       array[]::text[],                                      null, null, null);

  -- 11) KB folders + files. The storage object isn't actually present so
  --     downloads won't work, but the rows + chunks light up the UI.
  insert into public.kb_folders (id, parent_id, name, path, created_by) values
    (f_board,  null, 'pressed_board',     'pressed_board',     v_user),
    (f_close,  null, 'pressed_close',     'pressed_close',     v_user),
    (f_vendor, null, 'pressed_vendors',   'pressed_vendors',   v_user),
    (f_daily,  null, 'pressed_daily',     'pressed_daily',     v_user),
    (f_models, null, 'pressed_models',    'pressed_models',    v_user);

  insert into public.kb_files
    (folder_id, name, storage_path, mime, size_bytes, kind, status, snippet, tags, uploaded_by)
  values
    (f_board, 'Q3 2026 Board Deck — final.pdf', 'demo/q3_board.pdf', 'application/pdf', 4120320, 'pdf', 'embedded',
     E'Q3 2026 Board of Directors meeting · Oct 22 2026\nRevenue $42.1M (+8.4% YoY) · Adj. EBITDA $7.1M (16.8% margin) · 312 doors · M12 cohort retention 38%. [' || v_marker || ']',
     array['board','q3','final'], v_user),
    (f_board, 'Audit committee minutes — Aug 2026.pdf', 'demo/ac_aug.pdf', 'application/pdf', 612000, 'pdf', 'embedded',
     E'Audit committee · Aug 18 · Reviewed: revenue recognition (subscription deferral), lease accounting (Topic 842 walk), going-concern memo. [' || v_marker || ']',
     array['audit','minutes'], v_user),
    (f_close, 'Q3 close memo — v4.docx', 'demo/q3_close_memo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 86500, 'doc', 'embedded',
     E'Q3 close memo, draft v4. Outstanding items: AR aging review, lease reconciliation, tax provision draft. Owner: Maya Chen. [' || v_marker || ']',
     array['close','q3','memo'], v_user),
    (f_close, 'Cold-press cost analysis 2026.xlsx', 'demo/coldpress_cost.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 248960, 'sheet', 'embedded',
     E'Cold-press cost waterfall. Organic kale +14% YoY, citrus flat (locked Sun-Pacific), beet -3% (commodity). Net 80bps gross margin headwind in Q3. [' || v_marker || ']',
     array['cogs','margin','q3'], v_user),
    (f_vendor, 'Vendor RFP — bottle suppliers 2026.xlsx', 'demo/bottle_rfp.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 142000, 'sheet', 'embedded',
     E'Bottle RFP scoring. O-I Glass primary (locked through 2027). Ardagh secondary at 12% premium. Berlin Packaging eliminated (lead time 12wk). [' || v_marker || ']',
     array['vendor','bottles','rfp'], v_user),
    (f_vendor, 'Cold-press supplier scorecard.xlsx', 'demo/supplier_scorecard.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 88000, 'sheet', 'embedded',
     E'Earthbound A · Sun-Pacific A- · Thomson Intl C+ (quality misses) · Mission Produce B+. Recommendations attached. [' || v_marker || ']',
     array['vendor','scorecard'], v_user),
    (f_daily, 'Same-store sales by region — Sept 2026.csv', 'demo/sss_sept.csv', 'text/csv', 21400, 'sheet', 'embedded',
     E'region,sss_yoy,driver\nWest,+6.8%,catering\nNortheast,+4.1%,cold-press launch\nTexas,+2.9%,new flavors\nSoutheast,-1.2%,hurricane (FL). [' || v_marker || ']',
     array['sss','daily'], v_user),
    (f_daily, 'Daily cash position — 2026-10-12.md', 'demo/cash_1012.md', 'text/markdown', 4200, 'report', 'embedded',
     E'Daily cash $24.6M total (op $18.1M, restricted $6.5M). 4-week AP commitments $9.2M. No flags. Generated by Treasury Bot at 06:14 PT. [' || v_marker || ']',
     array['treasury','daily'], v_user),
    (f_models, 'Store unit economics — model v7.xlsx', 'demo/store_unit_econ.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 412500, 'sheet', 'embedded',
     E'Mature AUV $1.35M, 4-wall margin 22%, payback 27 months base / 21 months upside. Sensitivity on rent + labor. [' || v_marker || ']',
     array['model','unit-econ'], v_user),
    (f_models, '5-year LRP — base case.xlsx', 'demo/lrp_base.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 768900, 'sheet', 'embedded',
     E'5-year LRP base case. 18 net new doors / yr. Subscription mix 14% → 22% by 2028. EBITDA margin 16.8% → 19.2%. [' || v_marker || ']',
     array['lrp','model','base'], v_user),
    (f_models, 'DCF — Pressed Series F valuation.xlsx', 'demo/dcf_seriesf.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 540000, 'sheet', 'embedded',
     E'DCF for Series F priced round. WACC 11.2%, terminal growth 2.5%, exit multiple 14x EBITDA. Equity value range $720M – $890M. [' || v_marker || ']',
     array['dcf','valuation','seriesf'], v_user);

  -- 12) KB chunks (so /kb/search returns hits for 'cohort', 'kale', 'WACC', etc.).
  insert into public.kb_chunks (file_id, ord, text)
  select id, 0, snippet from public.kb_files where snippet like '%[' || v_marker || ']%';

  -- 13) Apps.
  insert into public.apps (id, name, tagline, description, icon, color, status, content_md, created_by) values
    (app_daily, 'Daily Store Report', 'Yesterday at every door',
     'Per-store sales, AOV, and labor pacing, refreshed at 6am PT. Backed by a Snowflake materialized view + Treasury Bot. [' || v_marker || ']',
     'gauge', 'emerald', 'deployed',
     E'# Daily Store Report\n\nGood morning. Yesterday at a glance:\n\n- **Total sales:** $1.42M (+5.2% vs prior Wed)\n- **AOV:** $13.20 (+1.1%)\n- **Door count:** 312 trading\n- **Top region:** West, +7.4% comp\n\n[Full report →](#)\n\n## Flags\n- 4 stores ran cold-press out of stock before noon (LA-WeHo, NY-FiDi, NY-UWS, MIA-Brickell)\n- Labor pacing > 28% at 11 stores; opening manager nudged via Slack\n', v_user),
    (app_vendor, 'Vendor Watchlist', 'Anomalies before they hit COGS',
     'Weekly pricing anomalies across cold-press inputs and packaging. Powered by Vendor Hawk. [' || v_marker || ']',
     'megaphone', 'amber', 'deployed',
     E'# Vendor Watchlist\n\n## This week''s flags\n\n| Vendor | SKU | $/unit | WoW | Note |\n|---|---|---|---|---|\n| Thomson Intl. | Ginger root | $2.85/lb | +9.4% | Spot price; renegotiate or switch |\n| Mission Produce | Hass avocado | $1.42/each | +5.1% | Mexican harvest variability |\n| Sun-Pacific | Valencia orange | $0.31/lb | -2.8% | Within contract band |\n', v_user),
    (app_close, 'Close Calendar', 'Where are we in the close',
     'Live view of the Q3 close-checklist memory doc with system-of-record verification. [' || v_marker || ']',
     'calendar', 'sky', 'draft',
     E'# Close calendar — Q3 2026\n\n- [x] Bank recs · _Verified in QuickBooks_\n- [x] Inventory cutoff · _Verified in NetSuite_\n- [x] Royalty accrual\n- [ ] AR aging review · _Owner: Sam K · Due tomorrow_\n- [ ] Lease reconciliation · _Owner: Maya · Due Fri_\n- [ ] Tax provision draft · _Owner: Deloitte · Due Mon_\n- [ ] Audit committee pre-read · _Owner: Maya · Due Tue_', v_user),
    (app_board, 'Board Snapshot', 'One screen for the whole board',
     'Quarterly KPIs, narrative draft, and the audit committee pre-read pulled into a single page. [' || v_marker || ']',
     'trophy', 'violet', 'deployed',
     E'# Board snapshot — Q3 2026\n\n**Revenue** $42.1M (+8.4%) · **EBITDA** $7.1M (16.8%) · **Doors** 312 · **M12 retention** 38%\n\n## Narrative draft\nRevenue grew 8.4% YoY to $42.1M, ahead of plan. Same-store sales contributed +5.1pp, net new doors +3.3pp. Gross margin landed 80bps below plan from organic kale inflation.\n\n[Full deck →](#) · [Audit committee minutes →](#)', v_user),
    (app_cohort, 'Cohort Pulse', 'Subscription cohort retention',
     'M1–M24 retention curves segmented by acquisition channel. Refreshed weekly. [' || v_marker || ']',
     'heart', 'rose', 'deployed',
     E'# Cohort Pulse\n\nM12 retention by channel:\n\n| Channel | M12 | vs prior cohort |\n|---|---|---|\n| Paid social (Meta) | 31% | +2pp |\n| In-store conversion | 47% | +5pp |\n| Catering upsell | 52% | +3pp |\n| Affiliate | 24% | -1pp |\n\nNet revenue retention 112%. ARPU $42 / month.', v_user);

  insert into public.app_deployments (app_id, user_id) values
    (app_daily, v_user), (app_vendor, v_user), (app_board, v_user), (app_cohort, v_user);

  -- 14) Sessions (runs gallery).
  insert into public.sessions
    (id, workflow_id, agent_id, environment_id, title, status, iteration_count, usage,
     trigger_summary, started_by, started_at, finished_at)
  values
    (ss1, null, a_close, e_finance, 'Q3 close — Wednesday checklist sweep', 'idle', 1,
     '{"input_tokens":4128,"output_tokens":1340,"cache_read_input_tokens":12030}'::jsonb,
     'schedule [' || v_marker || ']', v_user, now() - interval '6 hours', now() - interval '5 hours 51 minutes'),
    (ss2, null, a_vendor, e_finance, 'Vendor Hawk — weekly anomaly scan', 'running', 0,
     '{"input_tokens":2960,"output_tokens":410}'::jsonb,
     'schedule [' || v_marker || ']', v_user, now() - interval '12 minutes', null),
    (ss3, null, a_flux, e_finance, 'Flux narrative — Q3 actuals vs LRP', 'idle', 3,
     '{"input_tokens":18450,"output_tokens":4220,"cache_read_input_tokens":24080}'::jsonb,
     'manual [' || v_marker || ']', v_user, now() - interval '1 day', now() - interval '23 hours 38 minutes'),
    (ss4, null, a_treasury, e_finance, 'Treasury Bot · daily cash', 'terminated', 0,
     '{"input_tokens":1820,"output_tokens":540}'::jsonb,
     'schedule [' || v_marker || ']', v_user, now() - interval '2 days', now() - interval '1 day 23 hours');

  -- 15) Session events (mix so the timeline renders varied icons + tints).
  insert into public.session_events (session_id, event_type, payload, processed_at) values
    (ss1, 'user.message',
     '{"type":"user.message","content":[{"type":"text","text":"Walk the Q3 close checklist and verify each completed item against QuickBooks + NetSuite."}]}',
     now() - interval '6 hours'),
    (ss1, 'agent.tool_use',
     '{"type":"agent.tool_use","name":"read","input":{"path":"/mnt/session/inputs/close-checklist.md"}}',
     now() - interval '5 hours 59 minutes'),
    (ss1, 'agent.tool_use',
     '{"type":"agent.tool_use","name":"bash","input":{"command":"qb-cli reconcile --status"}}',
     now() - interval '5 hours 58 minutes'),
    (ss1, 'agent.message',
     E'{"type":"agent.message","content":[{"type":"text","text":"All 3 completed items verified. Bank recs match QB. Inventory cutoff confirmed in NetSuite. Royalty accrual posted. Open items: AR aging (Sam, tomorrow), lease recon (Maya, Friday), tax provision (Deloitte, Monday)."}]}',
     now() - interval '5 hours 52 minutes'),
    (ss1, 'session.status_idle',
     '{"type":"session.status_idle","stop_reason":{"type":"end_turn"}}',
     now() - interval '5 hours 51 minutes'),

    (ss2, 'user.message',
     '{"type":"user.message","content":[{"type":"text","text":"Run the weekly vendor pricing anomaly scan."}]}',
     now() - interval '12 minutes'),
    (ss2, 'agent.mcp_tool_use',
     '{"type":"agent.mcp_tool_use","server_name":"snowflake","name":"query","input":{"sql":"select * from vendor_prices where week >= dateadd(week,-13,current_date())"}}',
     now() - interval '11 minutes'),
    (ss2, 'agent.message',
     E'{"type":"agent.message","content":[{"type":"text","text":"Pulled 14 weeks of vendor pricing across 86 SKUs. Computing 13-week trailing avg and flagging WoW > 4%…"}]}',
     now() - interval '8 minutes'),
    (ss2, 'agent.tool_use',
     '{"type":"agent.tool_use","name":"bash","input":{"command":"python anomalies.py --threshold 0.04"}}',
     now() - interval '4 minutes'),

    (ss3, 'user.define_outcome',
     '{"type":"user.define_outcome","description":"Q3 flux narrative vs LRP base case","rubric":{"type":"text","content":"# Rubric\\n- Group by driver category\\n- Always provide $ impact range\\n- ≤ 600 words"},"max_iterations":4}',
     now() - interval '1 day'),
    (ss3, 'agent.tool_use',
     '{"type":"agent.tool_use","name":"read","input":{"path":"/mnt/session/inputs/q3_actuals.xlsx"}}',
     now() - interval '23 hours 56 minutes'),
    (ss3, 'agent.message',
     E'{"type":"agent.message","content":[{"type":"text","text":"Drafted v1 of the flux narrative grouped by mix/price/volume. Largest favorable: catering mix +$1.18M; largest unfavorable: organic kale +14% YoY drove COGS -$650k."}]}',
     now() - interval '23 hours 50 minutes'),
    (ss3, 'span.outcome_evaluation_start',
     '{"type":"span.outcome_evaluation_start","iteration":0}',
     now() - interval '23 hours 47 minutes'),
    (ss3, 'span.outcome_evaluation_end',
     E'{"type":"span.outcome_evaluation_end","result":"needs_revision","iteration":0,"explanation":"Revenue and COGS are addressed but marketing variance lacks driver attribution. Add the brand-campaign timing note."}',
     now() - interval '23 hours 45 minutes'),
    (ss3, 'agent.message',
     E'{"type":"agent.message","content":[{"type":"text","text":"Revising — added marketing flux paragraph noting the brand campaign was pushed into Q4."}]}',
     now() - interval '23 hours 43 minutes'),
    (ss3, 'span.outcome_evaluation_end',
     E'{"type":"span.outcome_evaluation_end","result":"satisfied","iteration":1,"explanation":"All 4 driver categories addressed with $ impact and attribution. Word count 568 (≤600)."}',
     now() - interval '23 hours 39 minutes'),
    (ss3, 'session.status_idle',
     '{"type":"session.status_idle","stop_reason":{"type":"end_turn"}}',
     now() - interval '23 hours 38 minutes'),

    (ss4, 'user.message',
     '{"type":"user.message","content":[{"type":"text","text":"Daily cash position."}]}',
     now() - interval '2 days'),
    (ss4, 'agent.tool_use',
     '{"type":"agent.tool_use","name":"bash","input":{"command":"qb-cli cash --date today"}}',
     now() - interval '1 day 23 hours 58 minutes'),
    (ss4, 'session.error',
     E'{"type":"session.error","error":{"message":"qb-cli: rate-limited at 06:14 PT","retry_status":"will_retry"}}',
     now() - interval '1 day 23 hours 56 minutes'),
    (ss4, 'session.status_terminated',
     '{"type":"session.status_terminated","reason":"max_retries_exceeded"}',
     now() - interval '1 day 23 hours');

  -- 16) Dreams. One pending (the diff shown when clicked); one approved.
  insert into public.dreams
    (store_id, status, old_snapshot, new_snapshot, diff, instructions, session_count, created_by, created_at, ended_at)
  values
    (s_close, 'pending',
     '[{"path":"close-checklist.md","content":"# Q3 close checklist\n\n- [x] Bank recs (treasury)\n- [x] Inventory cutoff @ store level\n- [x] Royalty accrual — partner fee true-up\n- [ ] AR aging review with collections\n- [ ] Lease accounting — Topic 842 reconciliation\n- [ ] Tax provision draft to Deloitte\n- [ ] Audit committee pre-read"},{"path":"q3-narrative-draft.md","content":"# Q3 2026 narrative — draft v3\n\nRevenue grew 8.4% YoY to $42.1M…"}]'::jsonb,
     '[{"path":"close-checklist.md","content":"# Q3 close checklist\n\n- [x] Bank recs (treasury)\n- [x] Inventory cutoff @ store level\n- [x] Royalty accrual — partner fee true-up\n- [x] AR aging review with collections\n- [ ] Lease accounting — Topic 842 reconciliation\n- [ ] Tax provision draft to Deloitte\n- [ ] Audit committee pre-read\n- [ ] AC follow-ups (revenue rec memo)"},{"path":"q3-narrative-draft.md","content":"# Q3 2026 narrative — draft v4\n\nRevenue grew 8.4% YoY to $42.1M, **ahead of consensus**. Same-store sales +5.1pp, doors +3.3pp. Gross margin 56.8% (-80bps), entirely from organic kale inflation. Adjusted EBITDA $7.1M (16.8%)."},{"path":"audit-committee-followups.md","content":"# AC follow-ups\n\n1. Revenue rec memo — subscription deferral methodology, owner Maya, due Oct 18.\n2. Going-concern memo update — owner Deloitte, due Oct 25.\n3. Lease accounting attestation — owner controller, due Nov 1."}]'::jsonb,
     E'{"added":[{"path":"audit-committee-followups.md","content":"# AC follow-ups\\n\\n1. Revenue rec memo — subscription deferral methodology, owner Maya, due Oct 18.\\n2. Going-concern memo update — owner Deloitte, due Oct 25.\\n3. Lease accounting attestation — owner controller, due Nov 1."}],"changed":[{"path":"close-checklist.md","before":"# Q3 close checklist\\n\\n- [x] Bank recs (treasury)\\n- [x] Inventory cutoff @ store level\\n- [x] Royalty accrual — partner fee true-up\\n- [ ] AR aging review with collections\\n- [ ] Lease accounting — Topic 842 reconciliation\\n- [ ] Tax provision draft to Deloitte\\n- [ ] Audit committee pre-read","after":"# Q3 close checklist\\n\\n- [x] Bank recs (treasury)\\n- [x] Inventory cutoff @ store level\\n- [x] Royalty accrual — partner fee true-up\\n- [x] AR aging review with collections\\n- [ ] Lease accounting — Topic 842 reconciliation\\n- [ ] Tax provision draft to Deloitte\\n- [ ] Audit committee pre-read\\n- [ ] AC follow-ups (revenue rec memo)"},{"path":"q3-narrative-draft.md","before":"# Q3 2026 narrative — draft v3\\n\\nRevenue grew 8.4% YoY to $42.1M…","after":"# Q3 2026 narrative — draft v4\\n\\nRevenue grew 8.4% YoY to $42.1M, **ahead of consensus**. Same-store sales +5.1pp, doors +3.3pp. Gross margin 56.8% (-80bps), entirely from organic kale inflation. Adjusted EBITDA $7.1M (16.8%)."}],"removed":[]}'::jsonb,
     'Roll the AC follow-ups into the close checklist; tighten the narrative draft. [' || v_marker || ']',
     2, v_user, now() - interval '3 hours', null),

    (s_vendor, 'approved',
     '[{"path":"cold-press-suppliers.md","content":"# Cold-press produce suppliers\n\n- Earthbound — kale\n- Sun-Pacific — citrus\n- Thomson Intl. — root veg"}]'::jsonb,
     '[{"path":"cold-press-suppliers.md","content":"# Cold-press produce suppliers\n\n- Earthbound — kale\n- Sun-Pacific — citrus (locked through 2027-Q2)\n- Thomson Intl. — root veg + ginger; quality issues 2x in 2026\n- Mission Produce — avocado, used for Greens+ avo line"}]'::jsonb,
     E'{"added":[],"changed":[{"path":"cold-press-suppliers.md","before":"…","after":"…added Mission Produce avocado supplier note"}],"removed":[]}'::jsonb,
     'Add Mission Produce note to vendor playbook. [' || v_marker || ']',
     1, v_user, now() - interval '5 days', now() - interval '5 days' + interval '14 minutes');

  raise notice 'Seed applied for user %', v_user;
end
$$;
