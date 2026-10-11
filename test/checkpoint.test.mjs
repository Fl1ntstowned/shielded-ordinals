// State checkpoints (src/v1/checkpoint.mjs) and the follower's restart, reorg and shutdown paths
// (src/v1/follow.mjs), offline on a synthetic chain (test/lib/synth.mjs). A loaded engine must be the
// engine a straight replay reaches, field for field (every root, the whole log, Map and Set order, the
// tree's own arrays), and every damaged or foreign checkpoint must be refused. The real indexer runs as
// a child process for shutdown (SIGTERM), a reorg (/status answers 200 throughout) and discovery.
//   node test/checkpoint.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SynthChain, testRules, makeIndexer, serveEsplora, VKEY, KEYS, PROOF, opReturn, p2tr, field } from './lib/synth.mjs';
import { follower } from '../src/v1/follow.mjs';
import {
  capture, restoreEngine, readCheckpoint, sealOf, engineStamp, encode, decode, listCheckpoints, loadNewest, persist, DEPENDENCIES,
} from '../src/v1/checkpoint.mjs';
import { exportState } from '../src/v1/view.mjs';
import { encodeListBody } from '../src/v1/envelope.mjs';
import { lockScript } from '../src/v1/scripts.mjs';
import { vkeyHash } from '../src/v1/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = path.join(ROOT, 'indexer', 'indexer.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-checkpoint-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// console.error / console.warn lines while fn runs (and nothing printed)
const logged = async (fn) => {
  const lines = [];
  const e = console.error, w = console.warn;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = console.error;
  try { await fn(); } finally { console.error = e; console.warn = w; }
  return lines;
};

// Everything an object holds, in order: every own field (functions as 'f'), Map and Set order, Buffer
// bytes, BigInt values, undefined, class names. Written for this test, independently of checkpoint.mjs.
function image(v) {
  if (v === undefined) return 'u';
  if (v === null) return 'null';
  switch (typeof v) {
    case 'bigint': return `n${v}`;
    case 'number': return `d${v}`;
    case 'string': return `s${JSON.stringify(v)}`;
    case 'boolean': return `b${v}`;
    case 'function': return 'f';
    default: break;
  }
  if (Buffer.isBuffer(v)) return `B${v.toString('hex')}`;
  if (v instanceof Uint8Array) return `U${Buffer.from(v).toString('hex')}`;
  if (Array.isArray(v)) return `[${v.map(image).join(',')}]`;
  if (v instanceof Map) return `M{${[...v].map(([k, x]) => `${image(k)}:${image(x)}`).join(',')}}`;
  if (v instanceof Set) return `S{${[...v].map(image).join(',')}}`;
  const name = Object.getPrototypeOf(v)?.constructor?.name ?? 'null';
  return `${name}{${Object.keys(v).map((k) => `${JSON.stringify(k)}:${image(v[k])}`).join(',')}}`;
}
const sameEngine = (a, b) => image(a) === image(b);
const firstDiff = (a, b) => { const x = image(a), y = image(b); let i = 0; while (i < x.length && x[i] === y[i]) i++; return `at ${i}: …${x.slice(Math.max(0, i - 80), i + 80)}… vs …${y.slice(Math.max(0, i - 80), i + 80)}…`; };

// ---- a synthetic chain with every kind of event: mints and a batch mint, a mint refused (no gate
// coin), an envelope of an unknown type (a parse refusal, logged with type undefined), transfers, a
// double spend refused, listings, a sale, a cancel (lock spent), a claim, two LISTs sharing one lock
// output (the lock index keeps only the second), and blocks without notes.
function build(start) {
  const chain = new SynthChain({ start });
  const X = chain.parent(testRules({ name: 'Checkpoint Test' }).json);
  chain.block([X.tx]); // +0
  chain.block([chain.mint(X, [0, 1, 2, 3])]); // +1
  chain.block([]); // +2
  const l1 = chain.list(X, { assetId: 0, price: 50000 });
  chain.block([chain.transfer(X), l1]); // +3
  const unknown = chain.tx({ outs: [opReturn(Buffer.concat([Buffer.from('SHORD'), Buffer.from([1, 99]), X.cid, Buffer.alloc(8)]))] });
  chain.block([chain.mint(X, 4, { ticketsBuy: 2 }), chain.mint(X, 5, { gate: false }), unknown]); // +4
  const l2 = chain.list(X, { assetId: 1, price: 60000 });
  const l3 = chain.list(X, { assetId: 2, price: 70000 });
  chain.block([chain.buy(X, l1.listing, { ticketsBuy: 1 }), l2, l3]); // +5
  chain.block([chain.cancel(l2.listing)]); // +6
  const lock = lockScript(X.rules, KEYS.ret.xonly, chain.NET);
  const listBody = (assetId, nf) => Buffer.concat([encodeListBody({ cid: X.cid, hanchor: chain._height(), nf, assetId, tickets: 0, spend: 0, buy: 0, price: 80000, returnKey: KEYS.ret.xonly, sellerScript: p2tr(KEYS.seller.xonly) }), PROOF]);
  const twin = chain.tx({ outs: [opReturn(listBody(3, field('twin a'))), opReturn(listBody(4, field('twin b'))), { script: lock, value: 1000 }] });
  chain.block([chain.claim(X, l2.listing), twin.tx]); // +7
  const spent = chain.transfer(X);
  chain.block([spent]); // +8
  chain.block([chain.transfer(X, { nf: spent.nf }), chain.mint(X, [6, 7])]); // +9  the transfer is a double spend
  chain.block([]); // +10
  chain.block([chain.cancel({ lock: { txid: twin.txid, vout: 2, script: lock }, sellerScript: p2tr(KEYS.seller.xonly) })]); // +11  the twin lock spent
  chain.block([chain.transfer(X), chain.transfer(X)]); // +12
  chain.block([chain.mint(X, 8)]); // +13
  chain.block([]); // +14
  chain.block([chain.transfer(X, { hanchor: start + 1 })]); // +15  anchor outside the window? no: inside (short chain)
  chain.block([chain.mint(X, [9, 10])]); // +16
  chain.block([]); // +17
  chain.block([chain.transfer(X)]); // +18
  chain.block([chain.mint(X, 11)]); // +19
  return { chain, X, l3 };
}

const { chain, X } = build(600000);
const S0 = chain.start;
const B = chain.tipHeight();
const A1 = S0 + 9;
const A2 = S0 + 13;
const replayTo = async (c, col, h, make = () => makeIndexer(col)) => { const ix = make(); for (let k = c.start; k <= h; k++) await ix.applyBlock(k, c.reduced(k)); return ix; };
const straight = await replayTo(chain, X, B);
const meta = { stamp: 'test-stamp', network: 'signet', cid: X.cidHex, rulesInscriptionId: X.id, rulesHash: sha(X.text), vkeyHash: vkeyHash(VKEY), startHeight: S0 };
const split = (cp) => { const nl = cp.text.indexOf('\n'); return { header: JSON.parse(cp.text.slice(0, nl)), bodyText: cp.text.slice(nl + 1) }; };

// ---- 1. the engine itself
check('chain: every kind of event happened (accepted and refused)', (() => {
  const types = new Set(straight.log.map((l) => `${l.type}:${l.accepted}`));
  return ['MINTN:true', 'MINT:true', 'MINT:false', 'undefined:false', 'TRANSFER:true', 'TRANSFER:false', 'LIST:true', 'BUY:true', 'LOCK_SPENT:true', 'CLAIM:true'].every((t) => types.has(t))
    && straight.log.some((l) => !l.accepted && Object.hasOwn(l, 'type') && l.type === undefined)
    && [...straight.listings.values()].map((l) => l.state).join(',') === 'SOLD,CLAIMED,ACTIVE,ACTIVE,CLOSED'
    && straight.lockIndex.size === 1;
})(), straight.log.map((l) => `${l.type}:${l.accepted}`));

for (const A of [S0, S0 + 2, S0 + 5, A1, B]) {
  const at = await replayTo(chain, X, A);
  const cp = capture(at, { meta, hashOf: (h) => chain.hashAt(h) });
  const { header, bodyText } = split(cp);
  const back = restoreEngine(header, JSON.parse(bodyText), { make: () => makeIndexer(X), startHeight: S0 });
  const same = sameEngine(back, at);
  for (let k = A + 1; k <= B; k++) await back.applyBlock(k, chain.reduced(k));
  check(`engine: saved at ${A - S0 === 0 ? 'the start block' : `start + ${A - S0}`} and loaded, it is the same engine; replayed on to the tip it equals a straight replay (every field, the v1 digest, the /state bytes)`,
    same && sameEngine(back, straight) && back.stateDigest() === straight.stateDigest() && JSON.stringify(exportState(back)) === JSON.stringify(exportState(straight)),
    same ? firstDiff(back, straight) : firstDiff(restoreEngine(header, JSON.parse(bodyText), { make: () => makeIndexer(X), startHeight: S0 }), at));
}
{
  const cp = capture(straight, { meta, hashOf: (h) => chain.hashAt(h) });
  const { header, bodyText } = split(cp);
  const body = JSON.parse(bodyText);
  check('engine: a checkpoint holds every block\'s root and leaf count (not only the last 101) and the whole log', body.roots.length === B - S0 + 1 && body.roots[0][0] === S0 && body.log.length === straight.log.length
    && body.roots.every(([h, r, n]) => String(straight.roots.get(h)) === r && straight.leafCounts.get(h) === n));
  check('engine: the header carries the v1 digest (as /status), the block hash and the 12 recent hashes', header.digest === sha(straight.stateDigest()) && header.blockHash === chain.hashAt(B)
    && header.recent.length === 12 && header.recent.every(([h, x]) => chain.hashAt(h) === x) && header.recent[11][0] === B && header.seal === sealOf(header, bodyText));
  check('engine: listings keep every field (heights, scripts, lock, sold/closed/claim txids)', (() => {
    const back = restoreEngine(header, body, { make: () => makeIndexer(X), startHeight: S0 });
    return image(back.listings) === image(straight.listings) && image(back.lockIndex) === image(straight.lockIndex) && image(back.minted) === image(straight.minted);
  })());
}
{
  // fields later packages add: a Map named in FIELDS (WP4's nfCounts), a note that carries its assetId
  const withExtras = await replayTo(chain, X, A1, () => { const e = makeIndexer(X); e.nfCounts = new Map(); return e; });
  for (let h = S0; h <= A1; h++) withExtras.nfCounts.set(h, h - S0);
  withExtras.notes[0].assetId = 0;
  withExtras.notes[1].txSeen = Buffer.from('ab', 'hex');
  const cp = capture(withExtras, { meta, hashOf: (h) => chain.hashAt(h) });
  const { header, bodyText } = split(cp);
  const back = restoreEngine(header, JSON.parse(bodyText), { make: () => { const e = makeIndexer(X); e.nfCounts = new Map(); return e; }, startHeight: S0 });
  check('engine: a FIELDS Map (nfCounts) and notes with extra fields come back exactly', sameEngine(back, withExtras) && back.notes[0].assetId === 0 && Buffer.isBuffer(back.notes[1].txSeen), firstDiff(back, withExtras));
  let refusedLoad = null;
  try { restoreEngine(header, JSON.parse(bodyText), { make: () => makeIndexer(X), startHeight: S0 }); } catch (e) { refusedLoad = e.message; }
  check('engine: a checkpoint with a field this engine does not have is refused', /engine fields/.test(refusedLoad ?? ''), refusedLoad);
  const odd = await replayTo(chain, X, S0 + 2);
  odd.somethingNew = 1;
  let refusedSave = null;
  try { capture(odd, { meta, hashOf: (h) => chain.hashAt(h) }); } catch (e) { refusedSave = e.message; }
  check('engine: an engine field that checkpoints do not know stops the checkpoint being written', /somethingNew/.test(refusedSave ?? ''), refusedSave);
}
{
  // a chain longer than the 101 roots /state serves: every root is saved, and an old one is checked too
  const c = new SynthChain({ start: 650000 });
  const L = c.parent(testRules({ name: 'Long' }).json);
  c.block([L.tx]);
  for (let i = 0; i < 130; i++) c.block(i % 20 === 0 ? [c.mint(L, i / 20)] : []);
  const ix = await replayTo(c, L, c.tipHeight());
  const m = { ...meta, cid: L.cidHex, rulesInscriptionId: L.id, rulesHash: sha(L.text), startHeight: c.start };
  const { header, bodyText } = split(capture(ix, { meta: m, hashOf: (h) => c.hashAt(h) }));
  const body = JSON.parse(bodyText);
  const back = restoreEngine(header, body, { make: () => makeIndexer(L), startHeight: c.start });
  check('engine: past 101 blocks every root is saved and comes back (/state serves 101)', body.roots.length === 131 && exportState(ix).roots.length === 101 && back.roots.size === 131 && sameEngine(back, ix));
  body.roots[5][1] = '777';
  let refused = null;
  try { restoreEngine(header, body, { make: () => makeIndexer(L), startHeight: c.start }); } catch (e) { refused = e.message; }
  check('engine: a root far outside the anchor window that does not match the notes is refused', /root at block 650005/.test(refused ?? ''), refused);
}
{
  const v = { a: [1n, undefined, Buffer.from('00ff', 'hex'), new Uint8Array([7]), new Map([[1n, new Set(['x'])]]), { '~b': 'not a tag' }, null, 'text', true, -3] };
  const back = decode(JSON.parse(JSON.stringify(encode(v))));
  check('encode/decode: BigInt, undefined, Buffer, bytes, Map, Set and a look-alike tag round-trip', image(back) === image(v));
  let refused = false;
  try { encode({ when: new Date(0) }); } catch { refused = true; }
  check('encode: a class instance it cannot rebuild is refused', refused);
}

// ---- 2. the engine stamp
{
  const srcDir = path.join(ROOT, 'src', 'v1');
  const lf = path.join(tmp, 'stamp', 'lf', 'src', 'v1');
  const crlf = path.join(tmp, 'stamp', 'crlf', 'src', 'v1');
  for (const d of [lf, crlf]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const text = fs.readFileSync(path.join(srcDir, f), 'latin1').replace(/\r\n/g, '\n');
    fs.writeFileSync(path.join(lf, f), text, 'latin1');
    fs.writeFileSync(path.join(crlf, f), text.replace(/\n/g, '\r\n'), 'latin1');
  }
  const mods = (root, over = {}) => {
    for (const p of DEPENDENCIES) {
      const d = path.join(root, 'node_modules', ...p.split('/'));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: p, version: over[p] ?? '1.0.0' }));
    }
  };
  mods(path.join(tmp, 'stamp', 'lf'));
  mods(path.join(tmp, 'stamp', 'crlf'));
  const vk = vkeyHash(VKEY);
  const a = engineStamp({ vkeyHash: vk, srcDir: lf });
  const b = engineStamp({ vkeyHash: vk, srcDir: crlf });
  check('stamp: an LF and a CRLF checkout of src/v1 give the same stamp', a === b && /^[0-9a-f]{64}$/.test(a));
  check('stamp: the real checkout equals its LF copy when the same packages are installed', engineStamp({ vkeyHash: vk }) === engineStamp({ vkeyHash: vk, srcDir: lf, modulesFrom: srcDir }));
  fs.appendFileSync(path.join(crlf, 'indexer.mjs'), '// a comment\r\n');
  const c = engineStamp({ vkeyHash: vk, srcDir: crlf });
  fs.writeFileSync(path.join(crlf, 'new-rule.mjs'), 'export {};\n');
  const d = engineStamp({ vkeyHash: vk, srcDir: crlf });
  mods(path.join(tmp, 'stamp', 'lf'), { 'poseidon-lite': '9.9.9' });
  const e = engineStamp({ vkeyHash: vk, srcDir: lf });
  check('stamp: it changes when a src/v1 file changes, when a file is added, and when a dependency version changes', c !== b && d !== c && e !== a);
  check('stamp: it changes with the verification key, REGISTRY_START and NAMES_START', engineStamp({ vkeyHash: 'ab'.repeat(32), srcDir: lf }) !== e
    && engineStamp({ vkeyHash: vk, srcDir: lf, registryStart: { mainnet: 1, signet: 2 } }) !== e && engineStamp({ vkeyHash: vk, srcDir: lf, namesStart: { mainnet: 1, signet: 2 } }) !== e);
}

// ---- 3. the follower: write, load, refuse
// A hook with state: per block, how many notes and nullifiers the engine held (a Map in its snapshot).
const tally = () => ({
  id: 'tally', rows: new Map(),
  reset() { this.rows = new Map(); },
  afterBlock(h, ix) { this.rows.set(h, [ix.notes.length, ix.nullifiers.size]); },
  snapshot() { return { rows: this.rows }; },
  restore(s) { if (!(s?.rows instanceof Map)) throw new Error('no rows'); this.rows = s.rows; },
});
const straightTally = tally();
for (let h = S0; h <= B; h++) straightTally.afterBlock(h, await replayTo(chain, X, h));
const blocks = path.join(tmp, 'blocks'); // one block cache for every follower below
const golden = path.join(tmp, 'golden');
const fopts = (over = {}) => ({
  network: 'signet', source: chain.source, cacheDir: blocks, rulesInscriptionId: X.id, rules: X.rules, rulesText: X.text, vkey: VKEY, startHeight: S0,
  makeIndexer: () => makeIndexer(X), checkpoints: true, checkpointEvery: 1, ...over,
});
let copies = 0;
const copyOf = (dir) => { const to = path.join(tmp, `copy-${++copies}`); fs.cpSync(dir, to, { recursive: true }); return to; };
const loadedAt = (lines) => { const m = lines.map((l) => /loaded the checkpoint at block (\d+)/.exec(l)).find(Boolean); return m ? Number(m[1]) : null; };
{
  const hook = tally();
  const f1 = follower(fopts({ checkpointDir: golden, hooks: [hook] }));
  chain.setTip(A1);
  await f1.sync();
  chain.setTip(A2);
  await f1.sync();
  await f1.flush();
  chain.setTip(null);
  const files = listCheckpoints(path.join(golden, 'signet', X.cidHex));
  check('follower: with checkpointEvery 1 it writes one at each tip, named <height>-<hash>.json.gz, by cid', files.map((c) => c.height).join(',') === `${A2},${A1}`
    && files.every((c) => path.basename(c.file) === `${c.height}-${chain.hashAt(c.height)}.json.gz`) && f1.checkpointInfo()?.height === A2);
  const hook2 = tally();
  const f2 = follower(fopts({ checkpointDir: copyOf(golden), hooks: [hook2] }));
  const before = { ...chain.source.calls };
  const lines = await logged(() => f2.sync());
  check('follower: a restart loads the newest checkpoint and replays only the blocks after it', loadedAt(lines) === A2 && f2.ix()?.lastHeight === B && chain.source.calls.block - before.block === B - A2, lines);
  check('follower: ... and is the engine a straight replay reaches (every field), with the hook state too', sameEngine(f2.ix(), straight) && image(hook2.rows) === image(straightTally.rows), firstDiff(f2.ix(), straight));
  check('follower: hashAt covers the loaded recent hashes and the new blocks; checkpointInfo is the newest taken', f2.hashAt(B) === chain.hashAt(B) && f2.hashAt(A2 - 11) === chain.hashAt(A2 - 11) && f2.checkpointInfo()?.height === B);
  // a checkpoint for each tip it reaches; the newest CHECKPOINT_KEEP are kept
  const fk = follower(fopts({ checkpointDir: path.join(tmp, 'keep'), checkpointKeep: 2 }));
  for (const t of [S0 + 3, S0 + 4, S0 + 5, S0 + 6]) { chain.setTip(t); await fk.sync(); }
  await fk.flush();
  chain.setTip(null);
  check('follower: only the newest checkpointKeep files are kept', listCheckpoints(path.join(tmp, 'keep', 'signet', X.cidHex)).map((c) => c.height).join(',') === `${S0 + 6},${S0 + 5}`);
  // checkpointEvery: at the tip only on multiples
  const fe = follower(fopts({ checkpointDir: path.join(tmp, 'every'), checkpointEvery: 4 }));
  for (const t of [S0 + 3, S0 + 4, S0 + 5]) { chain.setTip(t); await fe.sync(); }
  await fe.flush();
  chain.setTip(null);
  check('follower: at the tip it writes only when the height is a multiple of checkpointEvery', listCheckpoints(path.join(tmp, 'every', 'signet', X.cidHex)).map((c) => c.height).join(',') === String([S0 + 3, S0 + 4, S0 + 5].filter((h) => h % 4 === 0)));
  const noSnap = { afterBlock() {} };
  const warned = await logged(async () => { const fn = follower(fopts({ checkpointDir: path.join(tmp, 'nosnap'), hooks: [noSnap] })); await fn.sync(); });
  check('follower: a hook with state but no snapshot()/restore() turns checkpoints off (none written)', !fs.existsSync(path.join(tmp, 'nosnap')) && warned.some((l) => /checkpoints are off/.test(l)), warned);
  const off = follower(fopts({ checkpoints: false, checkpointDir: path.join(tmp, 'off') }));
  await off.sync();
  await off.checkpoint();
  check('follower: checkpoints are off unless asked for (cosigner, relayer)', !fs.existsSync(path.join(tmp, 'off')) && off.checkpointInfo() === null && sameEngine(off.ix(), straight));
}

// Every refusal falls back to the older checkpoint (A1), or to a full replay when none is usable; the
// result is always the straight replay.
const A2file = (base) => path.join(base, 'signet', X.cidHex, `${A2}-${chain.hashAt(A2)}.json.gz`);
const A1file = (base) => path.join(base, 'signet', X.cidHex, `${A1}-${chain.hashAt(A1)}.json.gz`);
async function rewrite(file, edit, { reseal = true } = {}) {
  const { header, bodyText } = await readCheckpoint(file);
  const body = JSON.parse(bodyText);
  edit(header, body);
  const text = JSON.stringify(body);
  if (reseal) header.seal = sealOf(header, text);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(header) + '\n' + text));
}
let caseNo = 0;
async function refusal(label, damage, { reason, expect = A1, over = {}, hooks = [tally()] } = {}) {
  const base = path.join(tmp, `case-${++caseNo}`);
  fs.cpSync(golden, base, { recursive: true });
  await damage(base);
  const f = follower(fopts({ checkpointDir: base, hooks, ...over }));
  const lines = await logged(() => f.sync());
  const why = lines.find((l) => l.includes(`${A2}-`) && /not used/.test(l)) ?? '';
  const ok = loadedAt(lines) === expect && reason.test(why) && sameEngine(f.ix(), straight) && image(hooks[0].rows) === image(straightTally.rows);
  check(`refused: ${label} -> ${expect === null ? 'full replay' : 'the older checkpoint'}`, ok, lines);
}
await refusal('a file cut short', (b) => { const f = A2file(b); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 4000)); }, { reason: /unexpected end|incorrect header|invalid|end of file/i });
await refusal('a byte flipped, not resealed', async (b) => {
  const f = A2file(b);
  const text = zlib.gunzipSync(fs.readFileSync(f)).toString();
  const i = text.indexOf('"notes":[["') + 12;
  fs.writeFileSync(f, zlib.gzipSync(text.slice(0, i) + (text[i] === '1' ? '2' : '1') + text.slice(i + 1)));
}, { reason: /seal/ });
await refusal('a nullifier dropped, resealed', (b) => rewrite(A2file(b), (h, body) => { body.nullifiers.pop(); }), { reason: /state digest/ });
await refusal('a note commitment changed, resealed', (b) => rewrite(A2file(b), (h, body) => { body.notes[2][0] = String(BigInt(body.notes[2][0]) + 1n); }), { reason: /root at block/ });
await refusal('a root changed, resealed', (b) => rewrite(A2file(b), (h, body) => { body.roots[body.roots.length - 3][1] = '12345'; }), { reason: /root at block/ });
await refusal('an older root changed, resealed', (b) => rewrite(A2file(b), (h, body) => { body.roots[1][1] = '12345'; }), { reason: /root at block/ });
await refusal('a leaf count changed, resealed', (b) => rewrite(A2file(b), (h, body) => { body.roots[3][2] += 1; }), { reason: /leaf count/ });
await refusal('a lock index entry pointed elsewhere, resealed', (b) => rewrite(A2file(b), (h, body) => { body.lockIndex[0][0] = `${'ff'.repeat(32)}:0`; }), { reason: /lock/ });
await refusal('another engine stamp', (b) => rewrite(A2file(b), (h) => { h.stamp = 'ab'.repeat(32); }), { reason: /another engine/ });
await refusal('another rules hash', (b) => rewrite(A2file(b), (h) => { h.rulesHash = sha('other rules'); }), { reason: /rulesHash/ });
await refusal('another verification key hash', (b) => rewrite(A2file(b), (h) => { h.vkeyHash = 'cd'.repeat(32); }), { reason: /vkeyHash/ });
await refusal('another network', (b) => rewrite(A2file(b), (h) => { h.network = 'mainnet'; }), { reason: /network/ });
await refusal('another start block', (b) => rewrite(A2file(b), (h) => { h.startHeight = S0 - 1; }), { reason: /startHeight/ });
await refusal('another collection', (b) => rewrite(A2file(b), (h) => { h.cid = '00'.repeat(8); }), { reason: /cid/ });
await refusal('a hook that refuses its saved state', (b) => rewrite(A2file(b), (h, body) => { body.hooks.tally = { '~u': 1 }; }), { reason: /hook "tally" refused/ });
await refusal('a hook with no saved state', (b) => rewrite(A2file(b), (h, body) => { delete body.hooks.tally; }), { reason: /no saved state for the hook/ });
await refusal('every checkpoint damaged', async (b) => { for (const f of [A1file(b), A2file(b)]) await rewrite(f, (h, body) => { body.nullifiers.pop(); }); }, { reason: /state digest/, expect: null });
await refusal('a follower with other rules text (both refused)', () => {}, { reason: /rulesHash/, expect: null, over: { rulesText: X.text + ' ' } });
{
  // a checkpoint whose block left the best chain: the chain is forked above A1 (same txs, new blocks)
  const base = path.join(tmp, `case-${++caseNo}`);
  fs.cpSync(golden, base, { recursive: true });
  const { chain: c2, X: X2 } = build(600000);
  const oldA2 = c2.hashAt(A2);
  c2.source.fork(A1 + 2);
  const hooks = [tally()];
  const f = follower({ ...fopts({ checkpointDir: base, hooks }), source: c2.source, cacheDir: path.join(tmp, 'blocks-fork') });
  const lines = await logged(() => f.sync());
  const again = await replayTo(c2, X2, B);
  check('refused: a checkpoint whose block is no longer in the best chain -> the older checkpoint', loadedAt(lines) === A1 && lines.some((l) => l.includes(`${A2}-${oldA2}`) && /no longer in the best chain/.test(l))
    && sameEngine(f.ix(), again) && f.hashAt(B) === c2.hashAt(B), lines);
}
{
  // a checkpoint above the tip (STOP_HEIGHT lower than before) is not tried
  const f = follower(fopts({ checkpointDir: copyOf(golden) }));
  chain.setTip(A2 - 1);
  const lines = await logged(() => f.sync());
  chain.setTip(null);
  check('follower: a checkpoint above the tip is not used; the newest one under it is', loadedAt(lines) === A1 && f.ix().lastHeight === A2 - 1 && lines.some((l) => /above block/.test(l)), lines);
}
{
  // leftover temp files of a write cut short are cleaned up; persist keeps at least one file
  const d = path.join(tmp, 'leftover');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${S0}-${'aa'.repeat(32)}.json.gz.tmp-999999`), 'cut');
  check('files: a temp file of another process is removed when listing', listCheckpoints(d).length === 0 && fs.readdirSync(d).length === 0);
  const cp = capture(await replayTo(chain, X, S0 + 1), { meta, hashOf: (h) => chain.hashAt(h) });
  await persist(d, cp, { keep: 0 });
  check('files: persist with keep 0 still keeps the file just written', listCheckpoints(d).length === 1);
  const none = await loadNewest({ dir: path.join(tmp, 'nothing-here'), meta, make: () => makeIndexer(X) });
  check('files: no directory, no checkpoint (null)', none === null);
}

// ---- 4. reorgs: roll back to a checkpoint next to the old state, swap at the tip
{
  const { chain: c3, X: X3 } = build(600000);
  const seen = [];
  let fr = null;
  const watch = { id: 'watch', stateless: true, beforeBlock: (h, hash) => { seen.push({ h, hash, ix: fr?.ix(), last: fr?.ix()?.lastHeight }); } };
  const hooks = [tally(), watch];
  fr = follower({ ...fopts({ checkpointDir: path.join(tmp, 'reorg'), hooks, makeIndexer: () => makeIndexer(X3) }), source: c3.source, cacheDir: path.join(tmp, 'blocks-reorg'), rulesInscriptionId: X3.id, rules: X3.rules, rulesText: X3.text });
  for (const t of [B - 4, B - 3, B - 2, B - 1, B]) { c3.setTip(t); await fr.sync(); }
  await fr.flush();
  c3.setTip(null);
  const old = fr.ix();
  const oldTip = c3.hashAt(B);
  // the last 2 blocks replaced by other blocks: new mints instead
  c3.source.fork(B - 1, [[c3.mint(X3, 12)], [c3.mint(X3, [13, 14])]]);
  seen.length = 0;
  const lines = await logged(() => fr.sync());
  const fresh = await replayTo(c3, X3, B);
  check('reorg: rolls back to the newest checkpoint at or below the fork, still in the best chain', lines.some((l) => /reorg near/.test(l)) && loadedAt(lines) === B - 2, lines);
  check('reorg: while the new state is built the old one is served (same object, same block)', seen.length === 2 && seen.every((s) => s.ix === old && s.last === B) && old.lastHeight === B, seen.map((s) => [s.h, s.last]));
  check('reorg: then it swaps: the new state equals a fresh replay of the new chain, hooks included', fr.ix() !== old && sameEngine(fr.ix(), fresh) && fr.hashAt(B) === c3.hashAt(B) && fr.hashAt(B) !== oldTip
    && image(hooks[0].rows.get(B)) === image([fresh.notes.length, fresh.nullifiers.size]));
  // a rebuild that fails keeps serving the old state, puts the hooks back, and fresh() refuses
  const before = fr.ix();
  const rowsBefore = image(hooks[0].rows);
  c3.source.fork(B - 1, [[c3.mint(X3, 15)], [c3.mint(X3, [13, 14])]]);
  const realBlock = c3.source.block;
  let broke = 0;
  c3.source.block = async (hash, o) => { if (hash === c3.hashAt(B) && broke++ === 0) throw new Error('connection reset'); return realBlock(hash, o); };
  const l2 = await logged(() => fr.sync());
  let refused = null;
  try { await logged(async () => { c3.source.block = async () => { throw new Error('still down'); }; await fr.fresh(); }); } catch (e) { refused = e.message; }
  check('reorg: a rebuild that fails leaves the old state served, the hooks as they were, and fresh() refusing', fr.ix() === before && image(hooks[0].rows) === rowsBefore && /not synced/.test(refused ?? '') && l2.some((l) => /connection reset/.test(l)), [l2, refused]);
  c3.source.block = realBlock;
  await logged(() => fr.sync());
  check('reorg: the next round finishes the rollback', sameEngine(fr.ix(), await replayTo(c3, X3, B)) && fr.ix().lastHeight === B);
  // a rebuild that fails, then the old chain comes back: the served state is current again and fresh() works
  const served = fr.ix();
  const { replaced } = c3.source.fork(B - 1, [[], []]);
  c3.source.block = async () => { throw new Error('down'); };
  await logged(() => fr.sync());
  c3.source.block = realBlock;
  c3.best.splice(B - 1 - c3.start, Infinity, ...replaced);
  let back = null;
  try { await logged(async () => { back = await fr.fresh(); }); } catch (e) { back = e.message; }
  check('reorg: a failed rebuild, then the old chain back: fresh() gives the served state again', back === served && fr.ix() === served, back === served ? null : back);
  // without checkpoints: a full replay, still next to the old state
  const { chain: c4, X: X4 } = build(600000);
  const seen4 = [];
  let f4 = null;
  f4 = follower({ ...fopts({ checkpoints: false, hooks: [{ stateless: true, beforeBlock: () => seen4.push(f4.ix()) }], makeIndexer: () => makeIndexer(X4) }), source: c4.source, cacheDir: path.join(tmp, 'blocks-reorg4'), rulesInscriptionId: X4.id, rules: X4.rules, rulesText: X4.text });
  await f4.sync();
  const old4 = f4.ix();
  c4.source.fork(B - 1, [[c4.mint(X4, 12)], []]);
  seen4.length = 0;
  await logged(() => f4.sync());
  check('reorg: without checkpoints it replays from the start block next to the old state, then swaps', seen4.length === B - S0 + 1 && seen4.every((x) => x === old4) && sameEngine(f4.ix(), await replayTo(c4, X4, B)));
}

// ---- 5. stopping (SIGTERM) mid-replay: whole blocks only
{
  const { chain: c5, X: X5 } = build(600000);
  let f5 = null;
  const stopAt = S0 + 7;
  const stopper = { stateless: true, afterBlock: (h) => { if (h === stopAt) f5.stop(); } };
  f5 = follower({ ...fopts({ checkpointDir: path.join(tmp, 'stop'), checkpointEvery: 1000, hooks: [tally(), stopper], makeIndexer: () => makeIndexer(X5) }), source: c5.source, cacheDir: path.join(tmp, 'blocks-stop'), rulesInscriptionId: X5.id, rules: X5.rules, rulesText: X5.text });
  await f5.sync();
  await f5.checkpoint();
  const files = listCheckpoints(path.join(tmp, 'stop', 'signet', X5.cidHex));
  const got = await loadNewest({ dir: path.join(tmp, 'stop', 'signet', X5.cidHex), meta: { ...meta, stamp: engineStamp({ vkeyHash: vkeyHash(VKEY) }), cid: X5.cidHex, rulesInscriptionId: X5.id, rulesHash: sha(X5.text) }, make: () => makeIndexer(X5) });
  check('stop: a sync told to stop ends after the block in hand; nothing is published before the tip', f5.ix() === null && files.length === 1 && files[0].height === stopAt);
  check('stop: checkpoint() then saves that whole block: equal to a straight replay at that height', got && sameEngine(got.ix, await replayTo(c5, X5, stopAt)) && f5.checkpointInfo()?.height === stopAt);
  check('stop: a stopped follower starts no new round', (await f5.sync()) === undefined && f5.ix() === null);
}

// ---- 6. the real indexer (child process): SIGTERM, a reorg served with 200s, discovery by cid
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = (port, p) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(c), json: () => JSON.parse(Buffer.concat(c).toString()) })); });
  r.on('error', no);
  r.end();
});
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
// SIGTERM goes through process.emit, so the test works where signals do not (Windows): a line on the
// child's stdin raises it.
const TERM = 'data:text/javascript,' + encodeURIComponent("process.stdin.on('data', (d) => { if (String(d).includes('TERM')) process.emit('SIGTERM'); });");
const run = (args, env) => {
  const proc = spawn(process.execPath, ['--import', TERM, INDEXER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = [];
  proc.stdout.on('data', (d) => out.push(d));
  proc.stderr.on('data', (d) => err.push(d));
  const done = new Promise((ok) => proc.on('exit', (code) => ok(code)));
  return { proc, done, out: () => Buffer.concat(out).toString(), err: () => Buffer.concat(err).toString() };
};
const cleanEnv = (esplora, P, start, extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(API_|ADMIN_|COLLECTION|RULES_|START_HEIGHT|STOP_HEIGHT|FOLLOW_|REGISTRY_START|BITCOIN_RPC|CHAIN_API|MEMPOOL_API|CACHE_DIR|PORT|NETWORK|PUBLIC_LIMIT|TRUST_PROXY|CHECKPOINT)/.test(k)) delete env[k];
  return { ...env, NETWORK: 'signet', CHAIN_API: esplora.url, RULES_INSCRIPTION_ID: P.id, START_HEIGHT: String(start), REGISTRY_START: String(start), ...extra };
};
const mintChain = (start, extra = () => {}) => {
  const c = new SynthChain({ start });
  const P = c.parent(testRules({ name: 'Server Primary' }).json);
  c.block([P.tx]);
  for (let i = 0; i < 14; i++) c.block(i % 3 === 2 ? [] : [c.mint(P, i)]);
  extra(c, P);
  return { c, P };
};
{
  // SIGTERM in the middle of the first replay
  const { c, P } = mintChain(700000);
  const esplora = await serveEsplora(c);
  esplora.setDelay(150);
  const cache = path.join(tmp, 'term');
  const r = run([], cleanEnv(esplora, P, c.start, { CACHE_DIR: cache, PORT: String(await freePort()) }));
  const dir = path.join(cache, 'signet');
  for (let i = 0; i < 400 && !(fs.existsSync(dir) && fs.readdirSync(dir).length >= 5); i++) await wait(25);
  r.proc.stdin.write('TERM\n');
  const code = await Promise.race([r.done, wait(30_000).then(() => 'still running')]);
  if (code === 'still running') r.proc.kill();
  const files = listCheckpoints(path.join(cache, 'checkpoints', 'signet', P.cidHex));
  const h = files[0]?.height ?? null;
  const got = h === null ? null : await loadNewest({ dir: path.join(cache, 'checkpoints', 'signet', P.cidHex), meta: { stamp: engineStamp({ vkeyHash: vkeyHash(VKEY) }), network: 'signet', cid: P.cidHex, rulesInscriptionId: P.id, rulesHash: sha(P.text), vkeyHash: vkeyHash(VKEY), startHeight: c.start }, make: () => makeIndexer(P) });
  check('server: SIGTERM mid-replay exits 0 and saves the last whole block before the tip', code === 0 && h !== null && h > c.start && h < c.tipHeight() && /SIGTERM/.test(r.err()), [code, h, r.err().slice(-500)]);
  check('server: ... and that checkpoint equals a straight replay at its height', got && sameEngine(got.ix, await replayTo(c, P, h)));
  esplora.setDelay(0);
  const again = run(['--once'], cleanEnv(esplora, P, c.start, { CACHE_DIR: cache }));
  const code2 = await again.done;
  const st = JSON.parse(again.out().split('\n')[0] || 'null');
  check('server: the next start loads it and finishes the replay', code2 === 0 && new RegExp(`loaded the checkpoint at block ${h}`).test(again.err()) && st?.lastHeight === c.tipHeight()
    && st.digest === sha((await replayTo(c, P, c.tipHeight())).stateDigest()), again.err().slice(-400));
  await esplora.close();
}
{
  // a reorg while serving: /status answers 200 with the old state until the new one is at the tip. The
  // new chain is one block longer: the answer cache is keyed on the height, so after a reorg that ends
  // at the same height the cached answers change only with WP1's block-hash versions. The chain starts
  // so that block start + 12 is a multiple of 144: the first replay saves it (every 144 blocks), and
  // the fork replaces the 2 blocks above it.
  const { c, P } = mintChain(144 * 4931 - 12);
  const esplora = await serveEsplora(c);
  const cache = path.join(tmp, 'served-reorg');
  const port = await freePort();
  const r = run([], cleanEnv(esplora, P, c.start, { CACHE_DIR: cache, PORT: String(port), CHECKPOINT_EVERY: '1' }));
  const tip = c.tipHeight();
  let st = null;
  for (let i = 0; i < 300; i++) { try { const x = await get(port, '/status'); if (x.status === 200) { st = x.json(); break; } } catch { /* starting */ } await wait(100); }
  for (let i = 0; i < 100 && !(st?.checkpoint?.height === tip); i++) { await wait(100); st = (await get(port, '/status')).json(); }
  check('server: /status carries the newest checkpoint { height }', st?.lastHeight === tip && st.checkpoint?.height === tip, st);
  const oldHash = c.hashAt(tip);
  c.source.fork(tip - 1, [[c.mint(P, 2)], [c.mint(P, [5, 8])], [c.mint(P, 11)]]);
  const newHash = c.hashAt(tip + 1);
  esplora.setDelay(600);
  const codes = new Set();
  let before = 0, after = null, wrong = 0;
  for (let i = 0; i < 600 && !after; i++) {
    const x = await get(port, '/status');
    codes.add(x.status);
    if (x.status === 200) {
      const s = x.json();
      if (s.blockHash === newHash) after = s;
      else if (s.blockHash === oldHash && s.lastHeight === tip) before++;
      else wrong++;
    }
    await wait(100);
  }
  const fresh = await replayTo(c, P, tip + 1);
  check('server: during the rollback every /status is 200 with the old block, then the new state', after && codes.size === 1 && codes.has(200) && before > 0 && wrong === 0
    && after.lastHeight === tip + 1 && after.digest === sha(fresh.stateDigest()), { codes: [...codes], before, wrong, after });
  check('server: it rolled back to the checkpoint under the fork', new RegExp(`loaded the checkpoint at block ${tip - 2}`).test(r.err()), r.err().slice(-600));
  r.proc.kill();
  await r.done;
  await esplora.close();
}
{
  // discovery: a collection that mints is followed and checkpointed under its own cid; one that never
  // mints is listed but not followed; a restart loads every checkpoint and asks the source ~nothing
  const { c, P } = mintChain(720000, (ch) => {
    const Q = ch.parent(testRules({ name: 'Server Second', supply: 8 }).json);
    const R = ch.parent(testRules({ name: 'Server Never Mints', supply: 4 }).json);
    ch.block([Q.tx, R.tx]);
    ch.block([ch.mint(Q, [0, 1])]);
    ch.block([]);
    Object.assign(ch, { Q, R });
  });
  const { Q, R } = c;
  const esplora = await serveEsplora(c);
  const cache = path.join(tmp, 'discover');
  const once = run(['--once'], cleanEnv(esplora, P, c.start, { CACHE_DIR: cache, CHECKPOINT_EVERY: '1' }));
  const code = await once.done;
  const [statusLine, listLine] = once.out().trim().split('\n');
  const list = JSON.parse(listLine ?? '[]');
  const ck = path.join(cache, 'checkpoints', 'signet');
  const tip = c.tipHeight();
  check('discovery: the collection that minted writes its own checkpoints by cid; the one that never minted has none',
    code === 0 && listCheckpoints(path.join(ck, Q.cidHex))[0]?.height === tip && listCheckpoints(path.join(ck, P.cidHex))[0]?.height === tip && !fs.existsSync(path.join(ck, R.cidHex)), once.err().slice(-500));
  const r = list.find((x) => x.cid === R.cidHex);
  check('discovery: /collections lists the parent that never minted with followed: false and lastHeight null, and it costs no replay',
    r?.followed === false && r.lastHeight === null && r.range === null && list.find((x) => x.cid === Q.cidHex)?.lastHeight === tip && !once.err().includes('Server Never Mints: replayed') && !/found "Server Never Mints".*following it/.test(once.err()), list);
  const before = { ...esplora.calls };
  const second = run(['--once'], cleanEnv(esplora, P, c.start, { CACHE_DIR: cache, CHECKPOINT_EVERY: '1' }));
  const code2 = await second.done;
  const d = Object.fromEntries(Object.entries(esplora.calls).map(([k, v]) => [k, v - before[k]]));
  check('discovery: a restart loads each collection\'s checkpoint and asks the chain source for at most 2 batches of hashes and no block',
    code2 === 0 && /Server Primary: loaded the checkpoint/.test(second.err()) && /Server Second: loaded the checkpoint/.test(second.err()) && d.blocks <= 2 && d.hash === 0 && d.raw === 0
    && second.out().split('\n')[0] === statusLine, { d, err: second.err().slice(-600) });
  const all = run(['--once'], cleanEnv(esplora, P, c.start, { CACHE_DIR: path.join(tmp, 'discover-all'), FOLLOW_MINTED_ONLY: '0' }));
  await all.done;
  const listAll = JSON.parse(all.out().trim().split('\n')[1] ?? '[]');
  check('discovery: FOLLOW_MINTED_ONLY=0 follows the parent that never minted too, with the same state for the others',
    listAll.find((x) => x.cid === R.cidHex)?.lastHeight === tip && listAll.find((x) => x.cid === Q.cidHex)?.digest === list.find((x) => x.cid === Q.cidHex)?.digest);
  await esplora.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
