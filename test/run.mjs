// npm test: test/api-keys.mjs, then every test/*.test.mjs in name order. Offline. Stops at the first
// failure. (test/node-source.mjs reads signet from mempool.space: npm run test:node.)
//   node test/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ['api-keys.mjs', ...fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()];
for (const f of files) {
  console.log(`\n=== test/${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log(`\ntest/${f} failed (${r.status ?? r.signal}); stopping`);
    process.exit(1);
  }
}
console.log(`\nall ${files.length} test files passed`);
