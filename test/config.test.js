import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Wrangler D1 binding uses automatic provisioning without a placeholder ID', async function () {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

  assert.match(config, /\[\[d1_databases\]\][\s\S]*binding = "DB"/);
  assert.doesNotMatch(config, /REPLACE_WITH|database_id\s*=\s*"[^\"]*PLACEHOLDER/i);
  assert.doesNotMatch(config, /^database_id\s*=/m);
});
