import { createClient } from '@supabase/supabase-js';

const LOCAL_URL = 'http://127.0.0.1:54321';
const LOCAL_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const CLOUD_URL = 'https://hrjrojyjqcyamwfjnyjb.supabase.co';
const CLOUD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyanJvanlqcWN5YW13ZmpueWpiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODE5Njk0OCwiZXhwIjoyMDkzNzcyOTQ4fQ.XoWeWIni5XzKRzi50P9hyG8DhUKcgZfeS4VERcf3Qb8';

const local = createClient(LOCAL_URL, LOCAL_KEY);
const cloud = createClient(CLOUD_URL, CLOUD_KEY);

async function listAll(client, bucket) {
  const out = [];
  async function walk(prefix) {
    let offset = 0;
    while (true) {
      const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000, offset });
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const item of data) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id) out.push({ path, size: item.metadata?.size, mime: item.metadata?.mimetype });
        else await walk(path);
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  await walk('');
  return out;
}

async function ensureBucket(name) {
  const { data } = await cloud.storage.getBucket(name);
  if (!data) {
    const { error } = await cloud.storage.createBucket(name, { public: false });
    if (error) throw error;
    console.log(`[cloud] created bucket ${name}`);
  }
}

async function migrateBucket(bucket) {
  console.log(`\n=== ${bucket} ===`);
  await ensureBucket(bucket);
  const items = await listAll(local, bucket);
  console.log(`[local] ${items.length} files`);

  let ok = 0, skipped = 0, failed = 0;
  for (const [i, item] of items.entries()) {
    try {
      const { data: blob, error: dlErr } = await local.storage.from(bucket).download(item.path);
      if (dlErr) throw dlErr;
      const buf = Buffer.from(await blob.arrayBuffer());
      const { error: upErr } = await cloud.storage.from(bucket).upload(item.path, buf, {
        contentType: item.mime || 'application/octet-stream',
        upsert: true,
      });
      if (upErr) throw upErr;
      ok++;
      if (i % 10 === 0 || i === items.length - 1) {
        process.stdout.write(`  [${i+1}/${items.length}] ${item.path.slice(0, 60)}\n`);
      }
    } catch (e) {
      failed++;
      console.error(`  FAIL ${item.path}: ${e.message}`);
    }
  }
  console.log(`[${bucket}] ok=${ok} failed=${failed} total=${items.length}`);
}

await migrateBucket('kb');
await migrateBucket('media');
console.log('\nDone.');
