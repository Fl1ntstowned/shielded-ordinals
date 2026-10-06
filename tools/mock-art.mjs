// Mock Nakapunks for signet testing: N unique 48x48 pixel "punks" as ~1.5 KB JPEGs.
//   node tools/mock-art.mjs <outDir> [count=3333]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const sharp = createRequire(import.meta.url)('../../ord-drop/node_modules/sharp');
const [out = 'test-art/naka', count = '3333'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
let seed = 1337;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const skins = [[219, 177, 128], [174, 139, 97], [113, 63, 29], [234, 217, 217], [125, 162, 105], [150, 200, 220]];
const bgs = [[99, 133, 150], [162, 125, 190], [230, 200, 120], [120, 170, 140], [60, 60, 80]];
const hair = [[40, 30, 20], [200, 60, 40], [230, 220, 90], [30, 30, 30], [120, 60, 160], [240, 240, 240]];
const S = 48, sizes = [];
for (let n = 0; n < Number(count); n++) {
  const px = Buffer.alloc(S * S * 3);
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < S && y < S) px.set(c, (y * S + x) * 3); };
  const rect = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c); };
  rect(0, 0, S, S, pick(bgs));
  const skin = pick(skins), h = pick(hair);
  rect(14, 12, 20, 26, skin); rect(18, 38, 12, 10, skin); // head, neck
  const style = Math.floor(rnd() * 4);
  if (style === 0) rect(12, 6, 24, 8, h); else if (style === 1) rect(20, 2, 8, 12, h); else if (style === 2) { rect(12, 8, 24, 6, h); rect(12, 14, 4, 14, h); }
  const eyeY = 20 + Math.floor(rnd() * 3);
  if (rnd() < 0.3) rect(16, eyeY - 1, 18, 4, [20, 20, 20]); else { rect(18, eyeY, 3, 3, [20, 20, 20]); rect(27, eyeY, 3, 3, [20, 20, 20]); }
  rect(21, 31, 7, 2, [110, 40, 40]);
  // unique id pattern so no two files are identical
  for (let b = 0; b < 12; b++) if ((n >> b) & 1) set(2 + b * 3, 45, [255, 255, 255]);
  for (let i = 0; i < 40; i++) set(Math.floor(rnd() * S), Math.floor(rnd() * 10) + 38, pick(hair));
  const jpg = await sharp(px, { raw: { width: S, height: S, channels: 3 } }).resize(96, 96, { kernel: 'nearest' }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  fs.writeFileSync(path.join(out, `${n}.jpg`), jpg);
  sizes.push(jpg.length);
}
sizes.sort((a, b) => a - b);
console.log(`${sizes.length} files in ${out}: min ${sizes[0]} B, median ${sizes[sizes.length >> 1]} B, max ${sizes[sizes.length - 1]} B, total ${(sizes.reduce((s, x) => s + x, 0) / 1e6).toFixed(2)} MB`);
