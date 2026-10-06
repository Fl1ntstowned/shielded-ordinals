// Shielded names: run your own index (src/v1/names.mjs). No account, no key, no Ord Dropz server:
// it reads Bitcoin blocks from your own node (through its esplora / mempool API, --api <url>)
// starting at NAMES_START, and keeps only the name inscriptions. Blocks are cached on disk, so
// a restart costs nothing and a new block costs one download.
//
//   node tools/names-indexer.mjs                          sync mainnet, print { height, count, digest }
//   node tools/names-indexer.mjs --network signet
//   node tools/names-indexer.mjs --api http://localhost:3000/api   your node
//   node tools/names-indexer.mjs --lookup obi.naka        the address a name points at
//   node tools/names-indexer.mjs --list                   every name, in order
//   node tools/names-indexer.mjs --compare https://<host>/api/shielded/names/info
//                                                         does another indexer hold the same names?
//   node tools/names-indexer.mjs --watch                  keep following (checks every 60 s)
//
// Two indexers at the same height with the same digest hold exactly the same names.
import fs from 'node:fs';
import path from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { NameIndex, NAMES_START } from '../src/v1/names.mjs';
import { scanBlock } from '../src/v1/registry.mjs';
import { makeApi, defaultApi } from '../src/v1/follow.mjs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const network = opt('network', 'mainnet');
if (network !== 'mainnet' && network !== 'signet') throw new Error('--network mainnet | signet');
const api = String(opt('api', defaultApi(network))).replace(/\/+$/, '');
const dir = path.resolve(String(opt('cache', '.names-cache')), network);
const start = NAMES_START[network];
const get = makeApi(api);

/** One block's names (cached by height and hash, so a reorged block is never reused). */
async function namesOf(height, hash) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${height}-${hash}.json`);
  if (fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); } }
  const raw = await get(`/block/${hash}/raw`, 'buf');
  const block = bitcoin.Block.fromBuffer(raw);
  // the block we were given is the block we asked for: its header hashes to `hash`
  if (block.getId() !== hash) throw new Error(`block ${height}: the API returned a different block`);
  if (!block.checkTxRoots()) throw new Error(`block ${height}: transactions do not match the header`);
  const names = scanBlock(block).names;
  fs.writeFileSync(file + '.tmp', JSON.stringify(names));
  fs.renameSync(file + '.tmp', file);
  return names;
}

let index = null;
let hashes = new Map();
async function sync() {
  const tip = Number(await get('/blocks/tip/height', 'text'));
  const hashAt = async (h) => String(await get(`/block-height/${h}`, 'text')).trim();
  // reorg: a block we applied is no longer in the chain -> replay (from the disk cache)
  if (index && index.height !== null) {
    for (let h = index.height; h >= Math.max(start, index.height - 6); h--) {
      if (hashes.get(h) !== (await hashAt(h))) { index = null; hashes = new Map(); break; }
    }
  }
  const work = index ?? new NameIndex(start);
  for (let h = work.height === null ? start : work.height + 1; h <= tip; h++) {
    const hash = await hashAt(h);
    work.apply(h, await namesOf(h, hash));
    hashes.set(h, hash);
    if ((h - start) % 500 === 0 && h !== tip) console.error(`  synced to ${h} / ${tip}`);
  }
  index = work;
  return work.state();
}

const show = (s) => console.log(JSON.stringify({ network, ...s }));
const state = await sync();
show(state);

if (opt('lookup')) {
  const rec = index.resolve(String(opt('lookup')).trim().toLowerCase());
  console.log(rec ? JSON.stringify({ name: rec.name, address: rec.to, id: rec.id, height: rec.height }) : 'nobody has that name');
}
if (opt('list')) for (const r of index.list) console.log(`${r.height}\t${r.name}\t${r.to}\t${r.id}`);
if (opt('compare')) {
  const r = await fetch(String(opt('compare')));
  const theirs = (await r.json())?.index;
  if (!theirs) { console.log('that address did not answer with an index state'); process.exit(2); }
  console.log('theirs', JSON.stringify(theirs));
  if (theirs.height !== state.height) console.log(`different heights (${state.height} here, ${theirs.height} there): run again in a minute`);
  else if (theirs.digest === state.digest && theirs.count === state.count) console.log('AGREE: the same names at the same height');
  else { console.log('DISAGREE: the two indexes hold different names at the same height'); process.exit(1); }
}
if (opt('watch')) {
  setInterval(() => sync().then(show).catch((e) => console.error('sync:', e.message)), 60_000);
}
