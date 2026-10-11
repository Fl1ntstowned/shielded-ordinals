// Shielded names over the API (indexer/routes/names.mjs) and /collection's rules as inscribed, offline,
// on a synthetic chain (test/lib/synth.mjs) served as an esplora API to the real indexer/indexer.mjs,
// with API keys required. Also NameIndex.page() and its running digests (src/v1/names.mjs).
//   node test/names.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SynthChain, testRules, serveEsplora, ADDRESS } from './lib/synth.mjs';
import { NameIndex, NAMES_GENESIS, nextNamesDigest, NAMES_PAGE, nameRecord } from '../src/v1/names.mjs';
import { KeyStore } from '../indexer/keys.mjs';
import nameRoutes from '../indexer/routes/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = path.join(ROOT, 'indexer', 'indexer.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-names-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const addr = (label) => 'shord1' + sha(`names test address ${label}`) + sha(`names test address ${label} 2`);
// the running digest written out here, independently of names.mjs
const link = (prev, r) => sha(`${prev}|${r.height}|${r.id}|${r.name}|${r.to}`);
const GENESIS = sha('shord-names-v1');

// ---- NameIndex: the digest chain is unchanged, and page() lets a reader recompute it
{
  const idx = new NameIndex(100);
  const blocks = [[99, [{ id: 'a'.repeat(64) + 'i0', name: 'early.naka', label: 'early', to: ADDRESS }]]]; // before start: not a name
  for (let h = 100; h < 104; h++) blocks.push([h, Array.from({ length: 5 }, (_, k) => ({ id: `${sha(`id ${h} ${k}`)}i${k}`, name: `n${h}x${k}.naka`, label: `n${h}x${k}`, to: addr(k % 2) }))]);
  blocks.push([104, [{ id: 'b'.repeat(64) + 'i0', name: 'n100x0.shield', label: 'n100x0', to: ADDRESS }]]); // label taken: ignored
  let d = GENESIS;
  const accepted = [];
  for (const [h, ns] of blocks) {
    idx.apply(h, ns);
    if (h < 100) continue;
    for (const n of ns) if (!accepted.some((r) => r.label === n.label)) { accepted.push({ ...n, height: h }); d = link(d, { ...n, height: h }); }
  }
  check('names: the running digest is the documented chain (unchanged)', idx.digest === d && idx.list.length === 20 && NAMES_GENESIS === GENESIS && nextNamesDigest(GENESIS, accepted[0]) === link(GENESIS, accepted[0]));
  check('names: digests[i] is the digest before list[i]', idx.digests.length === 20 && idx.digests[0] === GENESIS && idx.digests.every((x, i) => (i ? x === link(idx.digests[i - 1], idx.list[i - 1]) : true)));
  // walk in pages of 7 and recompute
  let after = 0, r = GENESIS, pages = 0, ok = true;
  for (;;) {
    const p = idx.page(after, 7);
    pages++;
    ok &&= p.digestBefore === r && p.after === after && p.names.every((n, k) => n.i === after + k && same(Object.keys(n), ['i', 'name', 'to', 'id', 'height']));
    for (const n of p.names) r = link(r, n);
    if (p.next === null) break;
    after = p.next;
  }
  check('names: page() walked from 0 recomputes to the digest (3 pages of 7)', ok && pages === 3 && r === idx.digest);
  const end = idx.page(20, 7);
  check('names: the page at the end is empty, with the digest itself and no next', end.names.length === 0 && end.digestBefore === idx.digest && end.next === null);
  check('names: page() refuses a place outside the list', [-1, 21, 1.5, NaN].every((a) => { try { idx.page(a); return false; } catch { return true; } }) && NAMES_PAGE === 500);
  const restored = Object.assign(new NameIndex(100), { list: idx.list, digest: idx.digest, height: idx.height, byLabel: idx.byLabel, byAddress: idx.byAddress });
  check('names: an index restored without digests[] rebuilds them on the first page()', same(restored.page(13, 7), idx.page(13, 7)) && same(restored.digests, idx.digests));
  const v = nameRoutes[0].version;
  check('names routes: the version is the height plus the last 8 hex of its block hash', v({ height: 5, hash: 'ab'.repeat(32) }) === '5-abababab' && v({ height: 5, hash: 'cd'.repeat(32) }) !== v({ height: 5, hash: 'ab'.repeat(32) }) && nameRoutes.every((m) => m.version === v));
}

// ---- the chain: a primary whose rules are pretty-printed with a key of its own, a second collection
// that never inscribed inscribeFee, and over two pages of names
const chain = new SynthChain({ start: 400000 });
const S0 = chain.start;
const pJson = { ...testRules({ name: 'Names Primary' }).json, note: 'kept as inscribed' };
const P = chain.parent(JSON.stringify(pJson, null, 2));
const qJson = testRules({ name: 'Names Second', supply: 8, inscribeFee: undefined }).json;
const Q = chain.parent(qJson);
chain.block([P.tx, Q.tx]); // 400000
chain.block([chain.mint(P, [0, 1]), chain.mint(Q, 0)]); // 400001
const OTHER = addr('other');
const reserved = chain.inscribe([{ contentType: 'application/json', body: Buffer.from(JSON.stringify({ p: 'shord', op: 'name', name: 'admin.naka', to: ADDRESS })) }]);
chain.block([chain.nameTx('obi.naka'), reserved, chain.nameTx('two.naka', OTHER), chain.nameTx('three.shield', OTHER)]); // 400002
const FILL = 1040;
for (let b = 0; b < 2; b++) {
  const txs = [];
  for (let t = 0; t < 4; t++) {
    const from = b * 520 + t * 130;
    txs.push(chain.inscribe(Array.from({ length: 130 }, (_, k) => ({ contentType: 'application/json', body: Buffer.from(nameRecord(`f${String(from + k).padStart(4, '0')}.naka`, addr(from + k))) }))));
  }
  chain.block(txs); // 400003, 400004
}
chain.block([chain.nameTx('obi.shield', OTHER)]); // 400005: the label is taken, ignored
chain.block([]); // 400006
const TIP = chain.tipHeight();
const COUNT = 3 + FILL;
const esplora = await serveEsplora(chain);

// ---- the real server, keys required
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['API_KEYS_FILE', 'API_KEY_REQUIRED', 'ADMIN_SECRET', 'COLLECTION', 'RULES_FILE', 'RULES_BLOCK', 'START_HEIGHT', 'RULES_INSCRIPTION_ID', 'STOP_HEIGHT',
    'FOLLOW_ALL', 'REGISTRY_START', 'BITCOIN_RPC', 'BITCOIN_RPC_COOKIE', 'CHAIN_API', 'MEMPOOL_API', 'CACHE_DIR', 'PORT', 'NETWORK', 'PUBLIC_LIMIT', 'TRUST_PROXY']) delete env[k];
  return { ...env, NETWORK: 'signet', CHAIN_API: esplora.url, RULES_INSCRIPTION_ID: P.id, START_HEIGHT: String(S0), REGISTRY_START: String(S0) };
};
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = (port, p, headers = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const body = Buffer.concat(chunks); ok({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body.toString()) }); });
  });
  r.on('error', no);
  r.end();
});
async function serve(extraEnv = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [INDEXER], { env: { ...cleanEnv(), CACHE_DIR: path.join(tmp, `serve-${port}`), PORT: String(port), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err = [];
  proc.stderr.on('data', (d) => err.push(d));
  const done = new Promise((ok) => proc.on('exit', ok));
  for (let i = 0; i < 300; i++) {
    try {
      const c = await get(port, '/collections'); // open
      const n = await get(port, '/names/info'); // open
      if (c.status === 200 && c.json().every((x) => x.lastHeight === TIP) && n.status === 200 && n.json().height === TIP) return { port, proc, done };
    } catch { /* not listening yet */ }
    if (proc.exitCode !== null) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  console.log(Buffer.concat(err).toString());
  throw new Error('the indexer never reached the tip');
}

const keysFile = path.join(tmp, 'keys', 'api-keys.json');
const key = new KeyStore(keysFile).create('names test', 5000, 1000000).key;
const A = await serve({ API_KEYS_FILE: keysFile, API_KEY_REQUIRED: '1', PUBLIC_LIMIT: '1000' });
const port = A.port;
const K = { 'x-api-key': key };
// the day's count, not the minute's: a minute that rolls over mid-test would reset the minute's count
const left = (r) => Number(r.headers['x-ratelimit-daily-remaining']);
const probe = () => get(port, '/status', K); // 1 unit: what is left now
// units a call took: (left before) - (left after) - 1 for the probe that reads it
const units = async (call) => { const a = left(await probe()); const r = await call(); const b = left(await probe()); return { r, used: a - b - 1 }; };

// /names/info: open, body unchanged
const info = await get(port, '/names/info');
const st = info.json();
check('/names/info answers 200 with no key, the same body as before ({ ...state, index })', info.status === 200 && same(Object.keys(st), ['start', 'height', 'count', 'digest', 'index']) && same(st.index, { start: st.start, height: st.height, count: st.count, digest: st.digest }) && st.height === TIP && st.count === COUNT);
const cq = await get(port, `/c/${Q.cidHex}/names/info`);
check('/names/info is the same answer under a /c/<cid>/ prefix (a global route)', cq.status === 200 && cq.body.equals(info.body) && cq.headers.etag === info.headers.etag);
check('/names without a key gives 401 (only /names/info is open)', (await get(port, '/names')).status === 401 && (await get(port, '/names/obi.naka')).status === 401);

// the list, walked from after=0
{
  let after = 0, d = GENESIS, sizes = [], ok = true, spent = 0, i = 0, keys = true;
  for (;;) {
    const { r, used } = await units(() => get(port, `/names?after=${after}`, K));
    spent += used;
    const p = r.json();
    ok &&= r.status === 200 && p.after === after && p.digestBefore === d && p.count === COUNT && p.digest === st.digest && p.height === TIP && p.start === st.start;
    keys &&= same(Object.keys(p), ['start', 'height', 'count', 'digest', 'after', 'digestBefore', 'names', 'next']);
    for (const n of p.names) { ok &&= n.i === i++; d = link(d, n); }
    sizes.push(p.names.length);
    if (p.next === null) break;
    after = p.next;
  }
  check('/names: walking from after=0 and recomputing sha256(prev|height|id|name|to) from genesis ends on the /names/info digest', ok && d === st.digest && i === COUNT, { d, digest: st.digest, i });
  check('/names: pages of 500, each { start, height, count, digest, after, digestBefore, names, next } at 1 unit', keys && same(sizes, [500, 500, COUNT - 1000]) && spent === 3, { sizes, spent });
  const first = (await get(port, '/names', K)).json();
  check('/names: the first names in chain order (reserved and taken labels never listed)', same(first.names.slice(0, 3).map((n) => n.name), ['obi.naka', 'two.naka', 'three.shield']) && !first.names.some((n) => n.name === 'admin.naka') && first.names[0].to === ADDRESS && first.names[0].height === S0 + 2);
  const end = await get(port, `/names?after=${COUNT}`, K);
  check('/names?after=<count>: an empty page with the digest itself and no next', end.status === 200 && end.json().names.length === 0 && end.json().digestBefore === st.digest && end.json().next === null);
  const z = await get(port, '/names?after=007', K);
  const s = await get(port, '/names?after=7', K);
  check('/names: after=007 and after=7 are one answer (one key, one ETag)', z.status === 200 && z.headers.etag === s.headers.etag && z.body.equals(s.body) && s.json().names[0].i === 7);
  const bads = [];
  const { used } = await units(async () => { for (const a of ['abc', '-1', '1e3', '', '1.5', String(COUNT + 1), '99999999999999999999']) bads.push(await get(port, `/names?after=${encodeURIComponent(a)}`, K)); return null; });
  check('/names: a bad after (not a whole number, or past the last name) gives 400 and costs nothing', bads.every((r) => r.status === 400 && /after/.test(r.json().error) && r.headers['x-ratelimit-remaining'] === undefined) && used === 0, bads.map((r) => [r.status, r.body.toString()]).concat([used]));
}

// /names/<name>
{
  const bads = [];
  const { used } = await units(async () => { for (const n of ['a.naka', 'x--y.naka', 'obi.btc', 'admin.naka', '%E0%A4%A', 'of', 'obi', 'a%2Fb.naka']) bads.push(await get(port, `/names/${n}`, K)); return null; });
  const msg = bads.map((r) => (r.status === 400 ? r.json().error : `HTTP ${r.status}`));
  check("/names: a.naka, x--y.naka and obi.btc give 400 'not a valid name'", same(msg.slice(0, 3), ['not a valid name', 'not a valid name', 'not a valid name']), msg);
  check("/names: admin.naka gives 400 'that name is reserved'", msg[3] === 'that name is reserved', msg);
  check('/names: a malformed %-escape gives 400 (was a 500 after the charge)', bads[4].status === 400 && /malformed/.test(msg[4]), msg);
  check('/names: every one of these is answered before the gate and costs nothing', bads.every((r) => r.status === 400 && r.headers['x-ratelimit-remaining'] === undefined) && used === 0, [msg, used]);
  const miss = await units(() => get(port, '/names/zzzunclaimed.naka', K));
  check("/names: a valid name nobody holds gives 404 'nobody has that name' and costs 1 unit", miss.r.status === 404 && miss.r.json().error === 'nobody has that name' && miss.used === 1 && miss.r.headers.etag === undefined, [miss.r.status, miss.used]);
  const other = await get(port, '/names/obi.shield', K);
  check('/names: obi.shield, whose label obi.naka holds, is nobody\'s (404)', other.status === 404);
  const lo = await get(port, '/names/obi.naka', K);
  const up = await get(port, '/names/OBI.naka', K);
  const esc = await get(port, '/names/%4fBI.NAKA%20', K);
  const rec = lo.json();
  check('/names/<name> carries both address and to: { name, address, to, id, height }', lo.status === 200 && same(Object.keys(rec), ['name', 'address', 'to', 'id', 'height']) && rec.name === 'obi.naka' && rec.address === ADDRESS && rec.to === ADDRESS && rec.height === S0 + 2 && /^[0-9a-f]{64}i0$/.test(rec.id));
  check('/names: OBI.naka and obi.naka (and an escaped, padded spelling) share one cache entry: one key, one ETag', up.status === 200 && esc.status === 200 && up.headers.etag === lo.headers.etag && esc.headers.etag === lo.headers.etag && up.body.equals(lo.body) && esc.body.equals(lo.body));
  const nm = await units(() => get(port, '/names/OBI.naka', { ...K, 'if-none-match': lo.headers.etag }));
  check('/names: the ETag of obi.naka gives a 304 on OBI.naka, for 1 unit', nm.r.status === 304 && nm.used === 1);
  const one = await units(() => get(port, '/names/two.naka', K));
  check('/names: a found name costs 1 unit', one.r.status === 200 && one.used === 1 && one.r.json().to === OTHER);
}

// /names/of/<address>
{
  const lo = await get(port, `/names/of/${OTHER}`, K);
  const up = await get(port, `/names/of/${OTHER.toUpperCase()}`, K);
  check('/names/of: the records of an address, earliest first (shape unchanged)', lo.status === 200 && same(lo.json().names.map((n) => n.name), ['two.naka', 'three.shield']) && same(Object.keys(lo.json().names[0]), ['name', 'label', 'to', 'id', 'height']));
  check('/names/of: an uppercase address gives the lowercase results (one key, one ETag)', up.status === 200 && up.body.equals(lo.body) && up.headers.etag === lo.headers.etag);
  const none = await get(port, `/names/of/${addr('nobody')}`, K);
  check('/names/of: an address with no names gives { names: [] }', none.status === 200 && same(none.json(), { names: [] }));
  const bads = [];
  const { used } = await units(async () => { for (const a of ['shord1xyz', '', OTHER.slice(0, -1), `${OTHER}00`, '%E0%A4%A', 'obi.naka']) bads.push(await get(port, `/names/of/${a}`, K)); return null; });
  check('/names/of: a malformed address gives 400 and costs nothing', bads.every((r) => r.status === 400 && r.headers['x-ratelimit-remaining'] === undefined) && used === 0, bads.map((r) => [r.status, r.body.toString()]).concat([used]));
}

// /collection: the rules exactly as inscribed
{
  const c = (await get(port, '/collection', K)).json();
  const parsed = JSON.parse(P.text);
  check('/collection.rules deep-equals the parent inscription\'s JSON (same keys, same order)', same(c.rules, parsed) && P.text.includes('\n  "note"'), Object.keys(c.rules));
  check('/collection.rules carries artistPayoutScript, platformPayoutScript and relayerPayoutScript again', ['artistPayoutScript', 'platformPayoutScript', 'relayerPayoutScript'].every((k) => typeof c.rules[k] === 'string' && c.rules[k] === pJson[k]) && !('fileMint' in c.rules) && !('artistScript' in c.rules));
  const cq2 = (await get(port, `/c/${Q.cidHex}/collection`, K)).json();
  check('/c/<cid>/collection: a discovered collection\'s rules are its registry text, deep-equal, with no inscribeFee it never inscribed', same(cq2.rules, JSON.parse(Q.text)) && !('inscribeFee' in cq2.rules) && cq2.inscribeFee === 0 && cq2.fileMint === true && cq2.rules.relayerPayoutScript === qJson.relayerPayoutScript);
  const old = Object.fromEntries(Object.entries(P.rules).filter(([k]) => !/Script$|^fileMint$/.test(k)));
  check('/collection: the other fields are unchanged; only the rules came back whole', c.minted === 2 && c.fileMint === true && c.inscribeFee === 1000 && c.lastHeight === TIP && c.cid === P.cidHex
    && Object.keys(old).every((k) => same(old[k], c.rules[k])) && same(Object.keys(c.rules).filter((k) => !(k in old)).sort(), ['artistPayoutScript', 'platformPayoutScript', 'relayerPayoutScript']));
}
A.proc.kill();
await A.done;

// RULES_FILE: the file's JSON, as today
{
  const file = path.join(tmp, 'rules.json');
  const text = JSON.stringify(Object.fromEntries(Object.entries(pJson).reverse()), null, 1);
  fs.writeFileSync(file, text);
  const B = await serve({ RULES_FILE: file });
  const c = (await get(B.port, '/collection')).json();
  check('RULES_FILE: /collection.rules is the file\'s JSON (its key order)', same(c.rules, JSON.parse(text)) && !same(c.rules, JSON.parse(P.text)));
  B.proc.kill();
  await B.done;
}

await esplora.close();
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
