// The indexer's shared view of the chain (indexer/chainview.mjs) with its persistent, linked index of
// block hashes; the batched hashesFrom of both chain sources; and the header checks of verifiedBlock
// (src/v1/follow.mjs). Offline: a synthetic chain (test/lib/synth.mjs), its esplora API over HTTP, and
// a stand-in Bitcoin node.
//   node test/chainview.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { SynthChain, testRules, makeIndexer, serveEsplora, VKEY } from './lib/synth.mjs';
import { chainView, loadHashIndex } from '../indexer/chainview.mjs';
import { follower, makeSource, verifiedBlock, checkBlockHeader, linkedHashes, targetOf, MAINNET_MAX_TARGET } from '../src/v1/follow.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-chainview-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quiet = async (fn) => { const lines = []; const e = console.error, w = console.warn; console.error = (...a) => lines.push(a.join(' ')); console.warn = console.error; try { await fn(); } finally { console.error = e; console.warn = w; } return lines; };
const throwsLike = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const chain = new SynthChain({ start: 800000 });
const S0 = chain.start;
const P = chain.parent(testRules({ name: 'View Test' }).json);
chain.block([P.tx]);
for (let i = 0; i < 34; i++) chain.block(i % 4 === 0 ? [chain.mint(P, i / 4)] : []);
const T0 = chain.tipHeight(); // S0 + 34
const calls = chain.source.calls;
const count = () => calls.hash + calls.hashes;
const rowsOf = (from, to) => { const out = []; for (let h = from; h <= to; h++) out.push([h, chain.hashAt(h), chain.prevHashAt(h)]); return out; };

// ---- hashesFrom on both kinds of chain source, and its checks
{
  const esplora = await serveEsplora(chain);
  const api = makeSource({ api: esplora.url });
  const n = esplora.calls.blocks;
  const a = await api.hashesFrom(S0 + 5, T0);
  check('esplora hashesFrom: one GET /blocks/<h+9>, ten linked blocks ending there', esplora.calls.blocks - n === 1 && esplora.calls.hash === 0 && same(a, rowsOf(S0 + 5, S0 + 14)));
  const b = await api.hashesFrom(T0 - 3, T0);
  check('esplora hashesFrom: near the tip it asks for the tip and returns the ten blocks under it', same(b, rowsOf(T0 - 9, T0)) && esplora.heights.at(-1) === T0);
  await esplora.close();
  // a stand-in Bitcoin node: getblockhash and getblockheader only
  const asked = [];
  const node = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      asked.push(method);
      let result = null;
      if (method === 'getblockhash') result = chain.hashAt(params[0]);
      if (method === 'getblockheader') { const h = chain.blocks.get(params[0])?.height; result = { hash: params[0], height: h, ...(h > S0 ? { previousblockhash: chain.prevHashAt(h) } : {}) }; }
      res.end(JSON.stringify(result === null ? { result: null, error: { message: 'Method not found' }, id } : { result, error: null, id }));
    });
  });
  await new Promise((ok) => node.listen(0, '127.0.0.1', ok));
  const rpc = makeSource({ rpc: `http://127.0.0.1:${node.address().port}` });
  const c = await rpc.hashesFrom(S0 + 5, T0);
  check('node hashesFrom: getblockhash once, then getblockheader down the chain; the same ten blocks', same(c, rowsOf(S0 + 5, S0 + 14)) && asked[0] === 'getblockhash' && asked.filter((m) => m === 'getblockheader').length === 10);
  node.close();
  const good = rowsOf(S0 + 1, S0 + 4);
  check('linkedHashes: refuses a broken link, a missing top block and a malformed hash',
    throwsLike(() => linkedHashes([good[0], [good[1][0], good[1][1], 'ab'.repeat(32)], ...good.slice(2)], S0 + 4), /do not link/)
    && throwsLike(() => linkedHashes(good, S0 + 5), /did not return block/)
    && throwsLike(() => linkedHashes([...good.slice(0, 3), [S0 + 4, 'xyz', good[2][1]]], S0 + 4), /malformed/)
    && same(linkedHashes([...good].reverse(), S0 + 4), good));
}

// ---- the view: build, restart, idle rounds, new blocks
const file = path.join(tmp, 'signet-hashes.json');
const view = () => chainView({ source: chain.source, file, base: S0, log: () => {} });
{
  const v = view();
  const n0 = count();
  const h = await v.hashAt(T0);
  const built = count() - n0;
  check('view: an empty index is built in batches of 10 (4 calls for 35 blocks), none one by one', h === chain.hashAt(T0) && built === 4 && calls.hash === 0, { built, hash: calls.hash });
  const n1 = count();
  let all = true;
  for (let k = S0; k <= T0; k++) all &&= (await v.hashAt(k)) === chain.hashAt(k);
  check('view: every height is then answered from memory', all && count() === n1);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('view: the index file holds [height, hash, prevHash] from the base block, each one linked', same(rows, rowsOf(S0, T0)));
  check('view: above the tip it answers null; knownHash answers from memory', (await v.hashAt(T0 + 1)) === null && v.knownHash(S0 + 3) === chain.hashAt(S0 + 3) && v.knownHash(T0 + 1) === null && v.linked === true);
  v.newRound();
  const n2 = count();
  await v.hashAt(T0);
  check('view: an idle round asks one batch (the top block)', count() - n2 === 1);
}
{
  const v = view();
  const n = count();
  for (let k = S0; k <= T0; k++) await v.hashAt(k);
  check('view: a restart from the index file checks the last 12 blocks in at most 2 calls, then nothing', count() - n <= 2 && count() - n >= 1, count() - n);
  chain.block([]);
  chain.block([chain.mint(P, 9)]);
  chain.block([]);
  v.newRound();
  const m = count();
  check('view: new blocks are added in the same batch that checks the top', (await v.hashAt(T0 + 3)) === chain.hashAt(T0 + 3) && count() - m === 1 && v.index().top === T0 + 3);
}
const T1 = chain.tipHeight();
{
  // a reorg of the last 2 blocks, then a deep one (15 blocks back): the index drops what left the best chain
  const v = view();
  await v.hashAt(T1);
  const replaced = chain.source.fork(T1 - 1, [[], [chain.mint(P, 10)], []]);
  v.newRound();
  check('view: after a short reorg the new blocks are in the index', (await v.hashAt(T1)) === chain.hashAt(T1) && (await v.hashAt(T1 + 1)) === chain.hashAt(T1 + 1) && replaced.replaced[0] !== chain.hashAt(T1 - 1)
    && same(JSON.parse(fs.readFileSync(file, 'utf8')), rowsOf(S0, T1 + 1)));
  const lines = [];
  const v2 = chainView({ source: chain.source, file, base: S0, log: (m) => lines.push(m) });
  await v2.hashAt(S0);
  check('view: a restart after it agrees', v2.index().top === T1 + 1 && v2.knownHash(T1) === chain.hashAt(T1) && lines.length === 0, lines);
  chain.source.fork(T1 - 14, Array.from({ length: 16 }, (_, i) => (i === 3 ? [chain.mint(P, 11)] : [])));
  v.newRound();
  const deep = [];
  const v3 = chainView({ source: chain.source, file, base: S0, log: (m) => deep.push(m) });
  await v3.hashAt(chain.tipHeight());
  let ok = true;
  for (let k = S0; k <= chain.tipHeight(); k++) ok &&= v3.knownHash(k) === chain.hashAt(k);
  check('view: after a deep reorg (15 blocks) it walks back in batches to the fork and rebuilds above it', ok && deep.some((m) => /looking further back/.test(m)) && deep.some((m) => /changed after block/.test(m))
    && same(JSON.parse(fs.readFileSync(file, 'utf8')), rowsOf(S0, chain.tipHeight())), deep);
  await v.hashAt(S0);
  check('view: the older view object sees the same chain on its next round', v.knownHash(chain.tipHeight()) === chain.hashAt(chain.tipHeight()));
}
const T2 = chain.tipHeight();
{
  // an entry that does not link is refused: the index stops there and the rest comes from the source again
  const rows = rowsOf(S0, T2);
  rows[20] = [rows[20][0], rows[20][1], 'ee'.repeat(32)];
  fs.writeFileSync(file, JSON.stringify(rows));
  const said = [];
  const idx = loadHashIndex(file, S0, (m) => said.push(m));
  check('index: an entry whose prevHash is not the hash before it is refused (the index stops there)', idx.start === S0 && idx.hashes.length === 20 && said.length === 1 && /does not follow/.test(said[0]), said);
  const v = chainView({ source: chain.source, file, base: S0, log: () => {} });
  await v.hashAt(T2);
  check('index: the view rebuilds the rest from the source, linked', same(JSON.parse(fs.readFileSync(file, 'utf8')), rowsOf(S0, T2)));
  fs.writeFileSync(file, JSON.stringify(rowsOf(S0 + 5, T2)));
  check('index: a file that starts above the base block is not used', loadHashIndex(file, S0).hashes.length === 0 && loadHashIndex(file, S0 + 5).hashes.length === T2 - S0 - 4);
  fs.writeFileSync(file, '[[1,2');
  check('index: an unreadable file is an empty index', loadHashIndex(file, S0).start === null);
  fs.rmSync(file);
}
{
  // STOP_HEIGHT: the view never asks for, or answers, a block above it
  const tops = [];
  const src = { ...chain.source, hashesFrom: (h, tip) => { tops.push(Math.min(h + 9, tip)); return chain.source.hashesFrom(h, tip); } };
  const stop = S0 + 20;
  const v = chainView({ source: src, file: path.join(tmp, 'stop-hashes.json'), base: S0, stop, log: () => {} });
  check('view: with a stop height the tip is that block, nothing above it is asked or answered',
    (await v.tipHeight()) === stop && (await v.hashAt(stop)) === chain.hashAt(stop) && (await v.hashAt(stop + 1)) === null && tops.every((t) => t <= stop) && v.index().top === stop);
  const v2 = chainView({ source: chain.source, file: path.join(tmp, 'stop-hashes.json'), base: S0, stop: stop - 4, log: () => {} });
  check('view: a lower stop height later keeps the index and answers up to it', (await v2.hashAt(stop - 4)) === chain.hashAt(stop - 4) && (await v2.hashAt(stop - 3)) === null && v2.index().top === stop);
}

// ---- followers on the view: a restart replays from the block cache without asking for hashes
{
  const cache = path.join(tmp, 'follow');
  const fileF = path.join(cache, 'signet-hashes.json');
  const mk = (v) => follower({ network: 'signet', source: v, cacheDir: cache, rulesInscriptionId: P.id, rules: P.rules, rulesText: P.text, vkey: VKEY, startHeight: S0, makeIndexer: () => makeIndexer(P), checkpoints: true, checkpointEvery: 1 });
  const v1 = chainView({ source: chain.source, file: fileF, base: S0, log: () => {} });
  const f1 = mk(v1);
  await f1.sync();
  await f1.flush();
  const direct = makeIndexer(P);
  for (const h of chain.heights()) await direct.applyBlock(h, chain.reduced(h));
  check('follower on the view: reaches the tip with the same state as a direct replay', f1.ix()?.lastHeight === chain.tipHeight() && f1.ix().stateDigest() === direct.stateDigest());
  v1.newRound();
  const n = count();
  await f1.sync();
  check('follower on the view: an idle round costs one batch (its reorg check reads the last block from memory)', count() - n === 1);
  const v2 = chainView({ source: chain.source, file: fileF, base: S0, log: () => {} });
  const f2 = mk(v2);
  const m = count();
  const blocks = calls.block;
  await quiet(() => f2.sync());
  check('follower on the view: a restart loads its checkpoint with at most 2 hash calls and no download', count() - m <= 2 && calls.block === blocks && f2.ix().stateDigest() === direct.stateDigest(), { hashCalls: count() - m });
  check('follower on the view: after a load, hashAt of a block older than the saved 12 comes from the index', f2.hashAt(S0 + 1) === chain.hashAt(S0 + 1) && f2.hashAt(chain.tipHeight()) === chain.hashAt(chain.tipHeight()));
  fs.rmSync(path.join(cache, 'checkpoints'), { recursive: true, force: true });
  const v3 = chainView({ source: chain.source, file: fileF, base: S0, log: () => {} });
  const f3 = mk(v3);
  const k = count();
  await quiet(() => f3.sync());
  check('follower on the view: with no checkpoint a restart replays every block from the cache, still with at most 2 hash calls', count() - k <= 2 && calls.block === blocks && f3.ix().stateDigest() === direct.stateDigest(), { hashCalls: count() - k });
}

// ---- header checks on raw blocks
{
  const raw = chain.rawBlock(chain.hashAt(S0 + 3));
  const hash = chain.hashAt(S0 + 3);
  const prev = chain.hashAt(S0 + 2);
  check('verifiedBlock: an honest block passes, with its previous block and on a test network', !!verifiedBlock(raw, hash, { prevHash: prev, network: 'signet' }));
  check('verifiedBlock: a block that does not build on the previous block is refused', throwsLike(() => verifiedBlock(raw, hash, { prevHash: chain.hashAt(S0 + 1) }), /does not build on/));
  const blk = bitcoin.Block.fromBuffer(raw);
  blk.bits = 0x1d00ffff; // a real target this hash does not meet
  const weak = blk.toBuffer();
  check('verifiedBlock: a hash that does not meet its own target (no proof of work) is refused', throwsLike(() => verifiedBlock(weak, blk.getId()), /proof-of-work target/));
  check('verifiedBlock: on mainnet a target far easier than mainnet\'s is refused', throwsLike(() => verifiedBlock(raw, hash, { network: 'mainnet' }), /far easier than mainnet/));
  // block 969342's real header (mainnet): it meets its target and the floor
  const real = bitcoin.Block.fromHex('000000262f01e140ccc536f729b1de3da9f836edf806031ae042010000000000000000006583aedd344f042e10797c18df6a12115736e72c87146a8f321e9dd041c79ff81367bd6ac51e0217401fe847');
  let ok = true;
  try { checkBlockHeader(real, { network: 'mainnet', prevHash: '0000000000000000000142e01a0306f8ed36f8a93ddeb129f736c5cc40e1012f' }); } catch { ok = false; }
  check('checkBlockHeader: mainnet block 969342 passes; the floor is its target times 1024', ok && real.getId() === '000000000000000000014f3c81f04ae291ee96ff6aff77afefac135d7996a27e'
    && MAINNET_MAX_TARGET === targetOf(0x17021ec5) * 1024n && targetOf(real.bits) * 1024n === MAINNET_MAX_TARGET && targetOf(0x1d00ffff) > MAINNET_MAX_TARGET);
  // a source whose hashes jump between two chains: the follower refuses the block that does not link
  const c = new SynthChain({ start: 810000 });
  const Q = c.parent(testRules({ name: 'Jumpy' }).json);
  c.block([Q.tx]);
  for (let i = 0; i < 6; i++) c.block([c.mint(Q, i)]);
  const old = c.heights().map((h) => c.hashAt(h));
  c.source.fork(810004);
  const jumpy = { ...c.source, hashAt: async (h) => (h <= 810004 ? old[h - 810000] : c.hashAt(h)) };
  const f = follower({ network: 'signet', source: jumpy, cacheDir: path.join(tmp, 'jumpy'), rulesInscriptionId: Q.id, rules: Q.rules, vkey: VKEY, startHeight: 810000, makeIndexer: () => makeIndexer(Q) });
  const lines = await quiet(() => f.sync());
  check('follower: a block that does not build on the block it applied before is refused (nothing published)', f.ix() === null && lines.some((l) => /does not build on/.test(l)), lines);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
