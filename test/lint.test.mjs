// No control bytes in the source or the docs. A tool once wrote "\b" in a regex as a literal
// backspace (0x08), and the indexer stopped sending gzip without any error. Tab, newline and
// carriage return are allowed; every other byte below 0x20 fails the build.
//   node test/lint.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const walk = (dir, ext, deep) => {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (deep && e.name !== 'node_modules' && !e.name.startsWith('.')) out.push(...walk(p, ext, deep)); }
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out;
};
const files = [
  ...['src', 'indexer', 'tools', 'test'].flatMap((d) => walk(path.join(root, d), '.mjs', true)),
  ...walk(root, '.md', false),
  ...walk(path.join(root, 'docs'), '.md', true),
];

let bad = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'latin1').split('\n');
  lines.forEach((line, i) => {
    const m = BAD.exec(line);
    if (!m) return;
    bad += line.split('').filter((c) => BAD.test(c)).length;
    const at = m.index;
    const shown = line.slice(Math.max(0, at - 20), at + 20).replace(/[\x00-\x1F]/g, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
    console.log(`FAIL  ${path.relative(root, f)}:${i + 1}:${at + 1}  byte 0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')}  ${shown}`);
  });
}
console.log(`${files.length} files checked, ${bad} control byte${bad === 1 ? '' : 's'} found`);
if (files.length < 10) { console.log('FAIL  too few files found: is the test in the right folder?'); process.exit(1); }
process.exit(bad ? 1 : 0);
