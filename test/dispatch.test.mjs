// How the indexer answers, offline, on a synthetic chain (test/lib/synth.mjs) served as an esplora
// API: the real indexer/indexer.mjs runs as a child process, with its real rules engines and
// registry, against blocks made up for the test. Also the follower and registry extension points
// the server relies on (hooks, the registry's block hashes, loadRulesInfo, the inscribed rules text).
//   node test/dispatch.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SynthChain, testRules, makeIndexer, serveEsplora, VKEY, ADDRESS } from './lib/synth.mjs';
import { follower, registryFollower, loadRules, loadRulesInfo, makeSource } from '../src/v1/follow.mjs';
import { KeyStore } from '../indexer/keys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = path.join(ROOT, 'indexer', 'indexer.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-dispatch-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const oldEtag = (version, key) => `"${version}-${sha(key).slice(0, 12)}"`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

// ---- the chain: a primary, a second collection, one that pins another verification key, mints, a name
const chain = new SynthChain({ start: 400000 });
const S0 = chain.start;
const P = chain.parent(testRules({ name: 'Synthetic Primary' }).json);
const Q = chain.parent(testRules({ name: 'Synthetic Second', supply: 8 }).json);
const K = chain.parent(testRules({ name: 'Synthetic Other Key', spendVkeyHash: 'ab'.repeat(32) }).json);
chain.block([P.tx, Q.tx, K.tx]); // 400000
chain.block([chain.mint(P, [0, 1, 2, 3, 4]), chain.mint(Q, 0)]); // 400001
chain.block([chain.nameTx('alice.naka')]); // 400002
chain.block([chain.mint(P, 5, { ticketsBuy: 2 })]); // 400003
chain.block([]); // 400004

// ---- the synthetic chain itself: the engine flow with proofs taken as valid
{
  const c = new SynthChain({ start: 500000 });
  const X = c.parent(testRules().json);
  c.block([X.tx]);
  c.block([c.mint(X, [0, 1])]);
  const l1 = c.list(X, { assetId: 0, price: 50000 });
  c.block([c.transfer(X), l1]);
  const l2 = c.list(X, { assetId: 1, price: 60000 });
  c.block([c.buy(X, l1.listing), l2]);
  c.block([c.cancel(l2.listing)]);
  c.block([c.claim(X, l2.listing)]);
  const ix = makeIndexer(X);
  for (const h of c.heights()) await ix.applyBlock(h, c.reduced(h));
  check('synth: mint, transfer, list, buy, cancel and claim are all accepted', ix.log.every((l) => l.accepted) && ix.log.map((l) => l.type).join(',') === 'MINTN,TRANSFER,LIST,BUY,LIST,LOCK_SPENT,CLAIM', ix.log);
  check('synth: notes, nullifiers and listing states follow', ix.notes.length === 5 && ix.nullifiers.size === 3 && same([...ix.listings.values()].map((l) => l.state), ['SOLD', 'CLAIMED']));
  const again = new SynthChain({ start: 500000 });
  const X2 = again.parent(testRules().json);
  again.block([X2.tx]);
  check('synth: the same calls give the same txids and block hashes', X2.id === X.id && again.hashAt(500000) === c.hashAt(500000));
}

// ---- follower hooks
const VK = VKEY;
const events = [];
let failAt = null;
const hook = {
  reset: () => events.push('reset'),
  beforeBlock: async (h, hash, txs, src) => {
    if (h === failAt) throw new Error('hook refused the block');
    events.push(`before ${h} ${hash === chain.hashAt(h)} ${Array.isArray(txs)} ${src === chain.source}`);
  },
  afterBlock: (h, ix) => events.push(`after ${h} ${ix.lastHeight}`),
};
const fdir = path.join(tmp, 'follower');
const f = follower({ network: 'signet', source: chain.source, cacheDir: fdir, rulesInscriptionId: P.id, rules: P.rules, vkey: VK, startHeight: S0, hooks: [hook] });
await f.sync();
const expect = (from, to) => { const out = []; for (let h = from; h <= to; h++) out.push(`before ${h} true true true`, `after ${h} ${h}`); return out; };
check('follower: the hooks are on the returned object', f.hooks.length === 1 && f.hooks[0] === hook);
check('follower: reset once, then beforeBlock (hash, cached txs, source) and afterBlock (applied) for every block', same(events, ['reset', ...expect(S0, S0 + 4)]), events);
const revive = (_k, v) => (v && typeof v === 'object' && typeof v.hex === 'string' && Object.keys(v).length === 1 ? Buffer.from(v.hex, 'hex') : v);
const cachedBlock = (h) => JSON.parse(fs.readFileSync(path.join(fdir, 'signet', `${h}-${chain.hashAt(h)}.json`), 'utf8'), revive);
check('synth: reduced(h) is exactly what the follower caches', chain.heights().every((h) => same(cachedBlock(h), chain.reduced(h))) && chain.reduced(S0 + 1)[1].ins[0].script?.length === 34);
const direct = makeIndexer(P);
for (const h of chain.heights()) await direct.applyBlock(h, chain.reduced(h));
check('synth: a direct engine replay and the follower reach the same state', direct.stateDigest() === f.ix().stateDigest() && f.ix().notes.length === 6);
const before = f.ix().stateDigest();
events.length = 0;
const forked = chain.source.fork(S0 + 3);
await quiet(() => f.sync());
check('follower: a reorg starts a new engine: reset, then every block again from the start', same(events, ['reset', ...expect(S0, S0 + 4)]), events);
check('follower: after the reorg it stands on the new blocks, with the same state (same txs)', f.hashAt(S0 + 4) === forked.hashes[1] && forked.replaced[1] !== forked.hashes[1] && f.ix().stateDigest() === before);
chain.block([chain.mint(P, 6)]); // 400005
events.length = 0;
failAt = S0 + 5;
await quiet(() => f.sync());
check('follower: a hook that throws aborts the round before the block is applied', f.ix().lastHeight === S0 + 4 && f.hashAt(S0 + 5) === null && !events.some((e) => e.includes(`${S0 + 5}`)));
failAt = null;
await f.sync();
check('follower: the next round applies it', f.ix().lastHeight === S0 + 5 && same(events, expect(S0 + 5, S0 + 5)), events);
const plain = follower({ network: 'signet', source: chain.source, cacheDir: fdir, rulesInscriptionId: P.id, rules: P.rules, vkey: VK, startHeight: S0 });
await plain.sync();
check('follower: without hooks it works as before (hooks = [])', Array.isArray(plain.hooks) && plain.hooks.length === 0 && plain.ix().stateDigest() === f.ix().stateDigest());
const TIP = chain.tipHeight();

// ---- registry: block hashes and the inscribed rules text
const rf = registryFollower({ network: 'signet', source: chain.source, cacheDir: path.join(tmp, 'registry'), startHeight: S0 });
await rf.sync();
const reg = rf.registry();
check('registry: hashAt(h) is the hash of every block it applied, null otherwise', chain.heights().every((h) => rf.hashAt(h) === chain.hashAt(h)) && rf.hashAt(S0 - 1) === null && rf.hashAt(TIP + 1) === null);
check('registry: each collection keeps its rules text exactly as inscribed', reg.collections.get(P.cidHex)?.text === P.text && reg.collections.get(Q.cidHex)?.text === Q.text && reg.collections.get(K.cidHex)?.text === K.text);
check('registry: ranges from the first valid mints; list() has no text', same(reg.list().map((c) => [c.name, c.range?.start ?? null, c.range?.end ?? null]), [['Synthetic Primary', 0, 15], ['Synthetic Second', 16, 23], ['Synthetic Other Key', null, null]])
  && same(Object.keys(reg.list()[0]), ['cid', 'parent', 'name', 'supply', 'launchedAt', 'range']));
check('registry: the name is found', reg.names.resolve('alice.naka')?.to === ADDRESS);

// ---- loadRulesInfo
const esplora = await serveEsplora(chain);
{
  const txid = P.id.split('i')[0];
  const a = await loadRulesInfo({ source: chain.source, rulesInscriptionId: P.id });
  check('loadRulesInfo: rules, the inscribed text and the reveal txid; no height from a source without one', a.text === P.text && a.txid === txid && a.height === null && same(a.rules, P.rules));
  const api = makeSource({ api: esplora.url });
  const b = await loadRulesInfo({ source: api, rulesInscriptionId: P.id });
  check('loadRulesInfo: esplora gives the height from /tx/<txid>', b.height === S0 && b.text === P.text);
  const n = esplora.calls.tx;
  const r = await loadRules({ source: api, rulesInscriptionId: P.id });
  check('loadRules: the same rules, and no extra request for the height', same(r, P.rules) && esplora.calls.tx === n);
  const file = path.join(tmp, 'rules.json');
  fs.writeFileSync(file, P.text);
  const c = await loadRulesInfo({ rulesFile: file, rulesInscriptionId: P.id });
  check('loadRulesInfo: a rules file gives its text and no height', c.text === P.text && c.height === null && c.txid === txid && same(c.rules, P.rules));
  // a stand-in Bitcoin node: getrawtransaction and getblockheader only
  const asked = [];
  const node = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      asked.push(method);
      const result = method === 'getrawtransaction' ? chain.txHex(params[0]) : method === 'getblockheader' ? { hash: params[0], height: chain.blocks.get(params[0])?.height } : null;
      res.end(JSON.stringify(result === null ? { result: null, error: { message: 'Method not found' }, id } : { result, error: null, id }));
    });
  });
  await new Promise((ok) => node.listen(0, '127.0.0.1', ok));
  const rpc = makeSource({ rpc: `http://127.0.0.1:${node.address().port}` });
  const d = await loadRulesInfo({ source: rpc, rulesInscriptionId: P.id, rulesBlock: chain.hashAt(S0) });
  const e = await loadRulesInfo({ source: rpc, rulesInscriptionId: P.id });
  check('loadRulesInfo: a node gives the height from getblockheader(rulesBlock), none without it', d.height === S0 && e.height === null && same(asked, ['getrawtransaction', 'getblockheader', 'getrawtransaction']), asked);
  node.close();
}

// ---- the real server
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['API_KEYS_FILE', 'API_KEY_REQUIRED', 'ADMIN_SECRET', 'COLLECTION', 'RULES_FILE', 'RULES_BLOCK', 'START_HEIGHT', 'RULES_INSCRIPTION_ID', 'STOP_HEIGHT',
    'FOLLOW_ALL', 'REGISTRY_START', 'BITCOIN_RPC', 'BITCOIN_RPC_COOKIE', 'CHAIN_API', 'MEMPOOL_API', 'CACHE_DIR', 'PORT', 'NETWORK', 'PUBLIC_LIMIT', 'TRUST_PROXY']) delete env[k];
  return { ...env, NETWORK: 'signet', CHAIN_API: esplora.url, RULES_INSCRIPTION_ID: P.id, START_HEIGHT: String(S0), REGISTRY_START: String(S0) };
};
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const run = (args, env, nodeArgs = []) => {
  const proc = spawn(process.execPath, [...nodeArgs, INDEXER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], err = [];
  proc.stdout.on('data', (d) => out.push(d));
  proc.stderr.on('data', (d) => err.push(d));
  const done = new Promise((ok) => proc.on('exit', (code) => ok(code)));
  return { proc, done, out: () => Buffer.concat(out).toString(), err: () => Buffer.concat(err).toString() };
};
const get = (port, p, headers = {}, method = 'GET') => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks);
      ok({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body.toString()) });
    });
  });
  r.on('error', no);
  r.end();
});
async function serve(extraEnv = {}, nodeArgs = []) {
  const port = await freePort();
  const p = run([], { ...cleanEnv(), CACHE_DIR: path.join(tmp, `serve-${port}`), PORT: String(port), ...extraEnv }, nodeArgs);
  for (let i = 0; i < 300; i++) {
    try {
      const r = await get(port, '/collections'); // open, keys or not
      if (r.status === 200 && r.json().filter((c) => !c.skipped).every((c) => c.lastHeight === TIP) && (await get(port, '/status')).status === 200) return { port, p };
    } catch { /* not listening yet */ }
    if (p.proc.exitCode !== null) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  console.log(p.err());
  throw new Error('the indexer never reached the tip');
}

const A = await serve();
const port = A.port;
{
  const st = await get(port, '/status');
  const status = st.json();
  check('server: /status is the primary at the tip, with the collection count', status.lastHeight === TIP && status.cid === P.cidHex && status.collections === 3 && status.blockHash === chain.hashAt(TIP) && status.digest === sha(f.ix().stateDigest()));
  check('server: /status ETag follows the old formula "<height>-<sha256(key)[0:12]>"', st.headers.etag === oldEtag(TIP, '/status'), st.headers.etag);
  const three = await Promise.all([`/c/${Q.cidHex}`, `/c/${Q.cidHex}/`, `/c/${Q.cidHex}/status`].map((u) => get(port, u)));
  check('server: /c/<cid>, /c/<cid>/ and /c/<cid>/status are one answer with one ETag', three.every((r) => r.status === 200 && r.headers.etag === oldEtag(TIP, `/c/${Q.cidHex}/status`) && r.body.equals(three[0].body)) && three[0].json().cid === Q.cidHex, three.map((r) => [r.status, r.headers.etag]));
  const cp = await get(port, `/c/${P.cidHex}/status`);
  check('server: /c/<primary>/status equals /status (body and ETag)', cp.headers.etag === st.headers.etag && cp.body.equals(st.body));
  const rg = await get(port, '/registry');
  const crg = await get(port, `/c/${Q.cidHex}/registry`);
  check('server: /c/<cid>/registry equals /registry (body and ETag)', rg.status === 200 && crg.headers.etag === rg.headers.etag && crg.body.equals(rg.body) && rg.headers.etag === oldEtag(TIP, '/registry'));
  const forms = [['/state', '/state'], ['/state?since=2', '/state?since=2'], ['/state?since=2&x=1', '/state?since=2'], ['/state?since=0', '/state'], ['/listings', '/listings'], ['/collection', '/collection'],
    ['/names/info', '/names/info'], ['/names/alice.naka', '/names/alice.naka'], [`/c/${Q.cidHex}/state`, `/c/${Q.cidHex}/state`], [`/c/${Q.cidHex}/listings`, `/c/${Q.cidHex}/listings`]];
  const tags = await Promise.all(forms.map(([u]) => get(port, u)));
  check('server: ETags follow the old formula for every route (key = prefix + route + ?since)', tags.every((r, i) => r.status === 200 && r.headers.etag === oldEtag(TIP, forms[i][1])), tags.map((r, i) => [forms[i][0], r.status, r.headers.etag]));
  const cols = await get(port, '/collections');
  const list = cols.json();
  const all = list.map((c) => `${c.cid}:${c.lastHeight ?? '-'}`).join(',');
  check('server: /collections ETag is "<registry height>.<8 hex of every collection height>-<12 hex>"', cols.headers.etag === `"${TIP}.${sha(all).slice(0, 8)}-${sha('/collections').slice(0, 12)}"`, cols.headers.etag);
  check('server: /collections lists the primary, the second and the skipped one', same(list.map((c) => [c.cid, !!c.primary, !!c.skipped, c.lastHeight]), [[P.cidHex, true, false, TIP], [Q.cidHex, false, false, TIP], [K.cidHex, false, true, null]]));
  const sk = await get(port, `/c/${K.cidHex}/status`);
  check('server: a skipped collection gives 409', sk.status === 409 && /verification key/.test(sk.json().error));
  check('server: a skipped collection still serves the global answers', (await get(port, `/c/${K.cidHex}/registry`)).body.equals(rg.body));
  const unk = await get(port, '/c/0123456789abcdef/status');
  check('server: an unknown cid gives 404', unk.status === 404 && /no such collection/.test(unk.json().error));
  const gz = await get(port, '/state', { 'accept-encoding': 'gzip' });
  const plainState = await get(port, '/state');
  check("server: 'Accept-Encoding: gzip' on an answer over 1 KB returns gzip (1f8b)", gz.headers['content-encoding'] === 'gzip' && gz.body[0] === 0x1f && gz.body[1] === 0x8b && plainState.body.length > 1024 && zlib.gunzipSync(gz.body).equals(plainState.body) && gz.headers.vary === 'accept-encoding');
  const small = await get(port, '/status', { 'accept-encoding': 'gzip' });
  check('server: an answer of 1 KB or less is sent plain', small.headers['content-encoding'] === undefined && small.body.equals(st.body));
  const nm = await get(port, '/state', { 'if-none-match': plainState.headers.etag });
  check('server: If-None-Match with the ETag gives 304 and no body', nm.status === 304 && nm.body.length === 0 && nm.headers.etag === plainState.headers.etag);
  check('server: /health, OPTIONS, a POST and an unknown route', (await get(port, '/health')).status === 200 && (await get(port, '/status', {}, 'OPTIONS')).status === 204
    && (await get(port, '/status', {}, 'POST')).status === 404 && (await get(port, '/nope')).status === 404 && (await get(port, `/c/${Q.cidHex}/nope`)).status === 404);
  check('server: a name nobody holds gives 404', (await get(port, '/names/bob.naka')).status === 404);
}

// ---- --compare, --once and STOP_HEIGHT
{
  const cmp = run(['--compare', `http://127.0.0.1:${port}/status`], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'compare') });
  check('--compare: AGREE with the running indexer (exit 0)', (await cmp.done) === 0 && /AGREE/.test(cmp.out()), cmp.out() + cmp.err().slice(-300));
  const no = run(['--compare', `http://127.0.0.1:${port}/health`], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'compare') });
  check('--compare: an address that is not an indexer status exits 2', (await no.done) === 2 && /did not answer with an indexer status/.test(no.out()));
  A.p.proc.kill(); // nothing else asks the chain from here on
  await A.p.done;
  const once = run(['--once'], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'once') });
  const code = await once.done;
  const lines = once.out().trim().split('\n');
  const status = JSON.parse(lines[0] ?? 'null');
  check('--once: exits 0 at the tip, prints the status and every collection', code === 0 && status?.lastHeight === TIP && status.digest === sha(f.ix().stateDigest()) && JSON.parse(lines[1]).length === 3, once.err().slice(-400));
  const asked = esplora.heights.length;
  const stop = run(['--once'], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'stop'), STOP_HEIGHT: String(S0 + 3) });
  const scode = await stop.done;
  const sst = JSON.parse(stop.out().trim().split('\n')[0] ?? 'null');
  check('STOP_HEIGHT: --once stops at that block, exits 0, and never asks for a later block', scode === 0 && sst?.lastHeight === S0 + 3 && esplora.heights.slice(asked).every((h) => h <= S0 + 3), stop.err().slice(-400));
  const bad = run(['--once'], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'stop'), STOP_HEIGHT: 'soon' });
  check('STOP_HEIGHT: a value that is not a block height is refused', (await bad.done) !== 0 && /STOP_HEIGHT/.test(bad.err()));
}

// ---- route modules (indexer/routes/index.mjs), with keys required. The test swaps in its own list
// of modules through a module loader hook; the indexer itself is unchanged.
{
  const ROUTES = `
globalThis.__wholeBuilds = 0;
export const routes = [
  {
    id: 'probe', scope: 'collection', open: false, keep: 'shared',
    match: (p) => { const m = /^\\/probe\\/(\\d+)$/.exec(p); return m ? { n: Number(m[1]) } : null; },
    parse: ({ params }) => (params.n > 99 ? { status: 400, body: { error: 'n is at most 99' } } : { key: '/probe/' + params.n, cost: 3 }),
    build: (ctx) => ({ n: ctx.params.n, height: ctx.height, hash: ctx.hash, cid: ctx.col.cid, notes: ctx.ix.notes.length, registry: ctx.registry?.lastHeight ?? null,
      names: ctx.names?.height ?? null, hooks: Array.isArray(ctx.hooks), pad: 'x'.repeat(ctx.params.n * 30) }),
    headers: () => ({ 'x-probe': 'yes' }),
  },
  {
    id: 'whole', scope: 'global', open: true, keep: 'own', limit: 2,
    match: (p) => (/^\\/whole\\/[a-z]+$/.test(p) ? { w: p.slice(7) } : null),
    parse: ({ params }) => ({ key: '/whole/' + params.w, cost: 2 }),
    version: (ctx) => 'w' + ctx.height,
    build: (ctx) => ({ w: ctx.params.w, height: ctx.height, hash: ctx.hash, build: ++globalThis.__wholeBuilds }),
  },
  {
    id: 'badcost', scope: 'collection', keep: 'shared',
    match: (p) => (p.startsWith('/badcost/') ? { v: p.slice(9) } : null),
    parse: ({ params }) => (params.v === 'nokey' ? { cost: 1 } : { key: '/badcost/' + params.v, cost: Number(params.v) }),
    build: () => ({ ok: true }),
  },
];
export default routes;`;
  const data = (src) => 'data:text/javascript,' + encodeURIComponent(src);
  const loaderFor = (routesSource) => {
    const hooks = `export async function resolve(specifier, context, next) {
  if (specifier === './routes/index.mjs' && String(context.parentURL).endsWith('/indexer/indexer.mjs')) return { url: ${JSON.stringify(data(routesSource))}, shortCircuit: true };
  return next(specifier, context);
}`;
    return ['--import', data(`import { register } from 'node:module'; register(${JSON.stringify(data(hooks))});`)];
  };
  const loader = loaderFor(ROUTES);
  const keysFile = path.join(tmp, 'keys', 'api-keys.json');
  const key = new KeyStore(keysFile).create('dispatch test', 1000, 100000).key;
  const B = await serve({ API_KEYS_FILE: keysFile, API_KEY_REQUIRED: '1', PUBLIC_LIMIT: '1000' }, loader);
  const port = B.port;
  const K1 = { 'x-api-key': key };
  const left = (r) => Number(r.headers['x-ratelimit-remaining']);
  check('modules: a keyed module route without a key gives 401', (await get(port, '/probe/5')).status === 401);
  const refused = await get(port, '/probe/500');
  check('modules: parse() refusing (400) answers before the gate, with no key and no charge', refused.status === 400 && refused.json().error === 'n is at most 99' && refused.headers['x-ratelimit-remaining'] === undefined);
  const r1 = await get(port, '/probe/5', K1);
  const b1 = r1.json();
  check('modules: a collection route answers for the primary with ctx (height, hash, registry, names, hooks)', r1.status === 200 && b1.cid === P.cidHex && b1.height === TIP && b1.hash === chain.hashAt(TIP) && b1.notes === 7 && b1.registry === TIP && b1.names === TIP && b1.hooks === true, b1);
  check('modules: the default version is the height; ETag "<height>-<sha256(key)[0:12]>"; headers() are added', r1.headers.etag === oldEtag(TIP, '/probe/5') && r1.headers['x-probe'] === 'yes');
  const r2 = await get(port, '/probe/5', K1);
  check('modules: the gate charges parse()\'s cost', left(r1) - left(r2) === 3);
  const r3 = await get(port, '/probe/5', { ...K1, 'if-none-match': r1.headers.etag });
  check('modules: a 304 costs 1 and keeps the extra headers', r3.status === 304 && left(r2) - left(r3) === 1 && r3.headers['x-probe'] === 'yes');
  const rq = await get(port, `/c/${Q.cidHex}/probe/5`, K1);
  check('modules: under /c/<cid>/ a collection route answers for that collection (key /c/<cid>/...)', rq.json().cid === Q.cidHex && rq.json().notes === 1 && rq.headers.etag === oldEtag(TIP, `/c/${Q.cidHex}/probe/5`));
  const rp = await get(port, `/c/${P.cidHex}/probe/5`, K1);
  check('modules: /c/<primary>/... is the unprefixed answer', rp.headers.etag === r1.headers.etag && rp.body.equals(r1.body));
  check('modules: a skipped collection gives 409, an unknown cid 404', (await get(port, `/c/${K.cidHex}/probe/5`, K1)).status === 409 && (await get(port, '/c/0123456789abcdef/probe/5', K1)).status === 404);
  const big = await get(port, '/probe/50', { ...K1, 'accept-encoding': 'gzip' });
  check('modules: answers over 1 KB are gzipped', big.headers['content-encoding'] === 'gzip' && big.body[0] === 0x1f && big.body[1] === 0x8b && JSON.parse(zlib.gunzipSync(big.body)).n === 50);
  check('modules: no match, or a POST, gives 404', (await get(port, '/probe/x', K1)).status === 404 && (await get(port, '/probe/5', K1, 'POST')).status === 404);
  const w = await get(port, '/whole/a');
  check('modules: an open global route needs no key; version() sets the ETag; ctx.hash is the registry\'s', w.status === 200 && w.headers.etag === oldEtag(`w${TIP}`, '/whole/a') && w.json().hash === chain.hashAt(TIP));
  const wq = await get(port, `/c/${Q.cidHex}/whole/a`);
  const wk = await get(port, `/c/${K.cidHex}/whole/a`);
  check('modules: a global route is the same answer under any prefix, a skipped one too', wq.headers.etag === w.headers.etag && wq.body.equals(w.body) && wk.status === 200 && wk.body.equals(w.body));
  const order = [];
  for (const x of ['b', 'a', 'c', 'a', 'b']) order.push(`${x}${(await get(port, `/whole/${x}`)).json().build}`);
  check("modules: keep 'own' keeps the `limit` most recently used answers", same(order, ['b2', 'a1', 'c3', 'a1', 'b4']), order);
  const st = await get(port, '/status');
  check('modules: the built-in routes are unchanged', st.status === 200 && st.headers.etag === oldEtag(TIP, '/status'));
  // a price that is not a whole number of units would pass the gate for free and leave the key's
  // count broken (NaN) for the rest of the minute and the day
  const pb = await get(port, '/probe/5', K1);
  const bads = [];
  for (const v of ['abc', '0', '1.5', '-2', 'nokey']) bads.push(await get(port, `/badcost/${v}`, K1));
  const pa = await get(port, '/probe/5', K1);
  check('modules: parse() without a key or a whole number of units (1 or more) gives 500 and charges nothing', bads.every((r) => r.status === 500 && r.headers['x-ratelimit-remaining'] === undefined)
    && left(pb) - left(pa) === 3 && Number.isSafeInteger(left(pa)), bads.map((r) => [r.status, r.headers['x-ratelimit-remaining']]).concat([[left(pb), left(pa)]]));
  const good = await get(port, '/badcost/2', K1);
  check('modules: a whole-number price is charged as it is', good.status === 200 && left(pa) - left(good) === 2);
  B.p.proc.kill();
  await B.p.done;
  // a module that breaks the contract stops the indexer before it serves anything
  const broken = [`export default [{ id: 'x', scope: 'global', keep: 'own', limit: -1, match: () => null, parse: () => ({ key: '/x', cost: 1 }), build: () => 1 }];`,
    `export default [{ id: 'y', scope: 'global', keep: 'shared', limit: 4, match: () => null, parse: () => ({ key: '/y', cost: 1 }), build: () => 1 }];`,
    `export default [{ id: 'z', scope: 'global', keep: 'shared', open: 'yes', match: () => null, parse: () => ({ key: '/z', cost: 1 }), build: () => 1 }];`];
  const stopped = [];
  for (const src of broken) {
    const r = run([], { ...cleanEnv(), CACHE_DIR: path.join(tmp, 'broken'), PORT: String(await freePort()) }, loaderFor(src));
    const code = await Promise.race([r.done, new Promise((ok) => setTimeout(() => ok('still running'), 20_000))]);
    if (code === 'still running') { r.proc.kill(); await r.done; }
    stopped.push([code, /does not follow the contract/.test(r.err())]);
  }
  check("modules: limit below 1, limit without keep 'own', or open that is not a boolean: refused at startup", stopped.every(([code, said]) => typeof code === 'number' && code !== 0 && said), stopped);
}

await esplora.close();
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
