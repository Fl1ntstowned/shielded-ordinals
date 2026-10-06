// Launch prep: the artist's files -> a shuffled, 0-based art folder + per-piece metadata.
//
//   node tools/prepare-art.mjs <artistDir> <outDir> --name "Shielded NAKAS" [--seed <hex>]
//
// <artistDir> holds images/<n>.png and json/<n>.json (n = 1..supply, the artist's numbering; each
// json is [{ meta: { name, attributes } }]). Matched BY FILE NUMBER, never by order.
// Output:
//   <outDir>/art/<assetId>.png       assetId 0..supply-1 in shuffled order (what artRoot commits to)
//   <outDir>/metadata.json           { "<assetId>": { name: "<name> #<assetId+1>", attributes } }
//   <outDir>/PRIVATE-shuffle.json    seed + assetId -> artist file number. Keep private until mint-out:
//                                    with it anyone could tell which piece is which before it's minted.
// Prints the artRoot for the parent's rules. Same seed = same shuffle (re-runnable).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artRoot, fileHash } from '../src/v1/art.mjs';

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const [artistDir, outDir] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const name = flag('--name');
if (!artistDir || !outDir || !name) throw new Error('usage: prepare-art.mjs <artistDir> <outDir> --name "<collection name>" [--seed <hex>]');
const seed = flag('--seed') ?? crypto.randomBytes(32).toString('hex');

const imgDir = path.join(artistDir, 'images');
const jsonDir = path.join(artistDir, 'json');
const nums = fs.readdirSync(imgDir).filter((f) => /^\d+\.png$/i.test(f)).map((f) => Number(f.split('.')[0])).sort((a, b) => a - b);
const supply = nums.length;
if (!supply || nums[0] !== 1 || nums[supply - 1] !== supply) throw new Error(`images must be 1..N with no gaps (found ${supply}, ${nums[0]}..${nums[supply - 1]})`);

// every image has its own json, and the attributes are well formed
const traitsOf = new Map();
for (const n of nums) {
  const raw = JSON.parse(fs.readFileSync(path.join(jsonDir, `${n}.json`), 'utf8'));
  const meta = (Array.isArray(raw) ? raw[0] : raw)?.meta ?? raw;
  if (!meta || !Array.isArray(meta.attributes) || !meta.attributes.length) throw new Error(`json/${n}.json has no attributes`);
  if (meta.name && !new RegExp(`#${n}$`).test(String(meta.name).trim())) throw new Error(`json/${n}.json is named "${meta.name}", expected #${n}`);
  for (const a of meta.attributes) if (typeof a.trait_type !== 'string' || typeof a.value !== 'string') throw new Error(`json/${n}.json has a malformed attribute`);
  traitsOf.set(n, meta.attributes.map((a) => ({ trait_type: a.trait_type, value: a.value })));
}

// Fisher-Yates driven by HMAC(seed, counter): deterministic for a given seed, unbiased (rejection sampling)
let ctr = 0;
const rand = (bound) => {
  const limit = Math.floor(2 ** 32 / bound) * bound;
  for (;;) {
    const v = crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update(String(ctr++)).digest().readUInt32BE(0);
    if (v < limit) return v % bound;
  }
};
const order = [...nums];
for (let i = order.length - 1; i > 0; i--) { const j = rand(i + 1); [order[i], order[j]] = [order[j], order[i]]; }

const artOut = path.join(outDir, 'art');
if (fs.existsSync(artOut) && fs.readdirSync(artOut).length) throw new Error(`${artOut} is not empty; use a fresh outDir`);
fs.mkdirSync(artOut, { recursive: true });
const metadata = {};
const hashes = [];
order.forEach((n, assetId) => {
  const bytes = fs.readFileSync(path.join(imgDir, `${n}.png`));
  fs.writeFileSync(path.join(artOut, `${assetId}.png`), bytes);
  hashes.push(fileHash(bytes));
  metadata[assetId] = { name: `${name} #${assetId + 1}`, attributes: traitsOf.get(n) };
});
fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 1));
fs.writeFileSync(path.join(outDir, 'PRIVATE-shuffle.json'), JSON.stringify({ seed, assetIdToArtistFile: order }, null, 1));

const root = artRoot(hashes).toString('hex');
console.log(JSON.stringify({ supply, contentType: 'image/png', artRoot: root, outDir, seedSaved: 'PRIVATE-shuffle.json' }, null, 2));
