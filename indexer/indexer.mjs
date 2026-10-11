// Shielded Ordinals indexer anyone can run, like `ord`. It follows Bitcoin through your own node,
// rebuilds one collection's state and the global registry from the chain alone, and serves a read
// API. Point a site or a wallet at it, or compare fingerprints with any other indexer: two honest
// indexers at the same block always match.
//
// Chain source (one of):
//   BITCOIN_RPC=http://user:password@127.0.0.1:8332     your Bitcoin Core node (25.0 or newer)
//   BITCOIN_RPC=http://127.0.0.1:8332  BITCOIN_RPC_COOKIE=/path/to/.cookie
//   CHAIN_API=http://127.0.0.1:3000/api                 an esplora / mempool API instead
//
// Collection (one of):
//   COLLECTION=shielded-nakas                           a collection this software knows
//   RULES_INSCRIPTION_ID=<parent>i0  START_HEIGHT=<block>  [RULES_BLOCK=<hash of the parent's block>]
//   [RULES_FILE=rules.json]                             test collections whose rules aren't inscribed
//
//   NETWORK=mainnet|signet (default mainnet)  [PORT=5021]  [CACHE_DIR=.cache-indexer]
//   node indexer/indexer.mjs
//   node indexer/indexer.mjs --once                     sync to the tip, print the status, exit
//   node indexer/indexer.mjs --compare https://<host>/api/shielded/status
//                                                       sync, then say whether that indexer agrees
//
// GET /status      { network, collection, lastHeight, blockHash, notes, digest }   digest = sha256 of the state
// GET /state       the public state a vault scans (?since=<note count> for only the newer notes)
// GET /listings    active listings
// GET /registry    every shielded collection + its global number range
// GET /collection  rules, minted count, this collection's global range
// GET /names/info, /names/<name>, /names/of/<shielded address>      shielded names
// GET /collections                 every shielded collection this indexer follows (found on chain)
// GET /c/<cid>/status|state|listings|collection   the same routes for one collection by its cid
//
// Every shielded collection found on Bitcoin (the registry sees each parent inscription) gets its
// own copy of the rules engine, replayed from its parent's block, all sharing one block cache. The
// routes without /c/<cid>/ answer for the collection given with COLLECTION / RULES_INSCRIPTION_ID.
// FOLLOW_ALL=0 follows that one collection only.
//
// Serving other people (optional): API keys and request limits, see indexer/keys.mjs
//   API_KEYS_FILE=api-keys.json  [API_KEY_REQUIRED=1]  [PUBLIC_LIMIT=30]  [TRUST_PROXY=<proxy hops>]
//   Answers are built once per block, served compressed, and a client that sends If-None-Match gets
//   a 304 for an unchanged answer. /state costs 20 units (5 with ?since=), everything else 1.
//   [ADMIN_SECRET=<long secret>]   turns on key management over HTTP (POST/GET /admin/keys)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { follower, registryFollower, loadRules, makeSource, defaultApi } from '../src/v1/follow.mjs';
import { exportState } from '../src/v1/view.mjs';
import { saleFee, vkeyHash, collectionId } from '../src/v1/rules.mjs';
import { REGISTRY_START } from '../src/v1/registry.mjs';
import { knownCollection, COLLECTIONS } from '../src/v1/collections.mjs';
import { makeGate, Limiter, callerAddress } from './keys.mjs';
import { costOf, OPEN, etagOf, makeAnswers, sendAnswer } from './serve.mjs';
import { compare } from './compare.mjs';

const env = (k, d) => { const v = process.env[k]?.trim(); if (v) return v; if (d !== undefined) return d; throw new Error(`missing ${k}`); };
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i < 0 ? null : args[i + 1] ?? null; };

const NETWORK = env('NETWORK', 'mainnet');
if (NETWORK !== 'mainnet' && NETWORK !== 'signet') throw new Error('NETWORK must be mainnet or signet');
const PORT = Number(env('PORT', '5021'));
const CACHE = env('CACHE_DIR', '.cache-indexer');

const RPC = process.env.BITCOIN_RPC?.trim() || null;
const source = makeSource(RPC
  ? { rpc: RPC, rpcCookie: process.env.BITCOIN_RPC_COOKIE?.trim() || null }
  : { api: env('CHAIN_API', process.env.MEMPOOL_API?.trim() || defaultApi(NETWORK)) });

const name = process.env.COLLECTION?.trim() || null;
const known = name ? knownCollection(NETWORK, name) : null;
if (name && !known) throw new Error(`no collection "${name}" on ${NETWORK}. Known: ${Object.keys(COLLECTIONS[NETWORK] ?? {}).join(', ') || 'none'}`);
const RULES_ID = known?.rulesInscriptionId ?? env('RULES_INSCRIPTION_ID');
const START = known?.startHeight ?? Number(env('START_HEIGHT'));
const RULES_BLOCK = known?.rulesBlock ?? (process.env.RULES_BLOCK?.trim() || null);

const VKEY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../zk/spend_vkey.json', import.meta.url)), 'utf8'));
if (known?.spendVkeyHash && vkeyHash(VKEY) !== known.spendVkeyHash) throw new Error(`zk/spend_vkey.json is not the verification key of "${name}"`);

const rulesText = process.env.RULES_FILE ? fs.readFileSync(process.env.RULES_FILE, 'utf8') : null;
const rules = await loadRules({ source, rulesInscriptionId: RULES_ID, rulesFile: process.env.RULES_FILE, rulesBlock: RULES_BLOCK });

// One view of the chain per sync round, shared by every follower (the registry included): the tip and
// the last NEAR hashes are asked once per round (follow.mjs re-checks those for a reorg), deeper hashes
// once per process. So a restart asks each block's hash once, not once per follower, a collection
// found later replays from its parent's block without asking again, and in one round every follower
// stands on the same chain.
const NEAR = 7;
const view = { tip: null, tipP: null, near: new Map(), deep: new Map() };
const shared = {
  ...source,
  tipHeight: () => (view.tipP ??= source.tipHeight().then((t) => (view.tip = t)).catch((e) => { view.tipP = null; throw e; })),
  hashAt(h) {
    // the promise is kept, so two followers asking for the same block at once make one request
    const memo = view.tip !== null && h <= view.tip - NEAR ? view.deep : view.near;
    if (!memo.has(h)) memo.set(h, source.hashAt(h).catch((e) => { memo.delete(h); throw e; }));
    return memo.get(h);
  },
};
const newRound = () => { view.tip = null; view.tipP = null; view.near.clear(); };

// One rules engine per collection. Every follower shares the block cache (a cached block is the same
// whichever collection reads it), so the second collection costs no extra downloads.
const collections = new Map(); // cid hex -> { cid, id, rules, start, chain, skipped }
const follow = (id, r, start) => {
  let shown = 0;
  const cid = collectionId(id).toString('hex');
  const entry = {
    cid, id, rules: r, start, skipped: null,
    chain: follower({
      network: NETWORK, source: shared, cacheDir: CACHE, rulesInscriptionId: id, rules: r, vkey: VKEY, startHeight: start,
      onProgress: (h, tip) => { if (h === tip || Date.now() - shown > 15_000) { shown = Date.now(); console.error(`  ${r.name}: replayed to ${h} / ${tip}`); } },
    }),
  };
  collections.set(cid, entry);
  return entry;
};
const primary = follow(RULES_ID, rules, START);
const chain = primary.chain;
const regStart = process.env.REGISTRY_START ? Number(process.env.REGISTRY_START) : REGISTRY_START[NETWORK];
const registry = registryFollower({ network: NETWORK, source: shared, cacheDir: CACHE, startHeight: regStart });
const FOLLOW_ALL = process.env.FOLLOW_ALL !== '0';
const ourVkey = vkeyHash(VKEY);

// Collections the registry found on chain that we are not following yet; returns the new ones.
function discover() {
  const found = [];
  if (!FOLLOW_ALL) return found;
  for (const [cid, c] of registry.registry()?.collections ?? []) {
    if (collections.has(cid)) continue;
    if (c.rules.spendVkeyHash && c.rules.spendVkeyHash !== ourVkey) {
      collections.set(cid, { cid, id: c.id, rules: c.rules, start: c.height, chain: null, skipped: 'this collection pinned another proof verification key' });
      console.error(`found "${c.rules.name}" (${c.id}); not followed: it pinned another verification key`);
      continue;
    }
    console.error(`found "${c.rules.name}" (${c.id}) at block ${c.height}; following it`);
    found.push(follow(c.id, c.rules, c.height));
  }
  return found;
}
let syncing = null;
// The registry and the primary together (they read the same blocks, so a block missing from the cache
// is downloaded once), then any collection the registry just found, then the others. A new collection
// replays from its parent's block inside the running server: no restart.
const syncAll = () => (syncing ??= (async () => {
  newRound();
  await Promise.all([registry.sync(), primary.chain.sync()]);
  discover();
  for (const c of collections.values()) if (c.chain && c !== primary) await c.chain.sync();
})().finally(() => { syncing = null; }));
const byPath = (pathname) => {
  // /c/<cid>/... -> that collection; anything else -> the primary
  const m = /^\/c\/([0-9a-f]{16})(\/.*)?$/.exec(pathname);
  if (!m) return { col: primary, path: pathname };
  return { col: collections.get(m[1]) ?? null, path: m[2] && m[2] !== '/' ? m[2] : '/status' };
};

export const digestOf = (ix) => crypto.createHash('sha256').update(ix.stateDigest()).digest('hex');
const rawRules = (col) => (col === primary && rulesText ? JSON.parse(rulesText) : Object.fromEntries(Object.entries(col.rules).filter(([k]) => !/Script$|^fileMint$/.test(k))));
const statusOf = (col, ix) => ({
  network: NETWORK, collection: col.rules.name, rulesInscriptionId: col.id, cid: col.cid, lastHeight: ix.lastHeight, blockHash: col.chain.hashAt(ix.lastHeight),
  notes: ix.notes.length, digest: digestOf(ix), software: 'shielded-ordinals indexer',
  ...(col === primary ? { collections: collections.size } : {}),
});
const collectionsList = () => [...collections.values()].map((c) => {
  const ix = c.chain?.ix() ?? null;
  const reg = registry.registry()?.collections.get(c.cid);
  return {
    cid: c.cid, parent: c.id, name: c.rules.name, kind: c.rules.kind === 'rune' ? 'rune' : 'collection', supply: c.rules.supply, startBlock: c.start, range: reg?.range ?? null,
    lastHeight: ix?.lastHeight ?? null, notes: ix?.notes.length ?? null, digest: ix ? digestOf(ix) : null,
    ...(c.skipped ? { skipped: c.skipped } : {}), ...(c === primary ? { primary: true } : {}),
  };
});

// Per-collection routes: (collection, its engine, query). Global ones ignore the first two.
const routes = {
  '/status': (col, ix) => statusOf(col, ix),
  '/state': (_c, ix, q) => exportState(ix, { sinceNote: Math.max(0, Number(q.get('since')) || 0) }),
  '/listings': (col, ix) => [...ix.listings.values()].filter((l) => l.state === 'ACTIVE').map((l) => ({
    nf: String(l.nf), assetId: l.assetId, inscriptionId: col.rules.children?.[l.assetId] ?? null, price: String(l.price),
    saleFee: String(saleFee(col.rules, l.price)), tickets: l.tickets, listedAt: l.height,
  })),
  '/registry': () => registry.registry()?.list() ?? [],
  '/collections': () => collectionsList(),
  '/collection': (col, ix) => ({
    network: NETWORK, rulesInscriptionId: col.id, cid: ix.cid.toString('hex'), rules: rawRules(col), minted: ix.minted.size, lastHeight: ix.lastHeight,
    fileMint: !!col.rules.fileMint, inscribeFee: col.rules.inscribeFee ?? 0,
    global: registry.registry()?.collections.get(ix.cid.toString('hex'))?.range ?? null,
  }),
};
const GLOBAL = new Set(['/registry', '/collections']);
// What a global answer depends on. /collections changes when ANY follower moves or a collection is
// found, not only when the highest block changes, so its cached copy and ETag follow all of them.
const globalVersion = (path) => {
  const regH = registry.registry()?.lastHeight ?? 0;
  if (path === '/registry') return `${regH}`;
  const all = [...collections.values()].map((c) => `${c.cid}:${c.chain?.ix()?.lastHeight ?? '-'}`).join(',');
  return `${regH}.${crypto.createHash('sha256').update(all).digest('hex').slice(0, 8)}`;
};

// --compare (compare.mjs): the primary's status, as /status answers it
const primaryStatus = () => {
  const ix = chain.ix();
  if (!ix) throw new Error('not synced');
  return statusOf(primary, ix);
};

console.error(`shielded indexer for "${rules.name}" (${NETWORK}), blocks from ${source.label}, from block ${START}`);
if (flag('once') || opt('compare')) {
  await syncAll();
  const ix = chain.ix();
  if (!ix) { console.error('sync did not finish; run it again (blocks already read are kept)'); process.exit(2); }
  console.log(JSON.stringify(statusOf(primary, ix)));
  if (collections.size > 1) console.log(JSON.stringify(collectionsList()));
  const behind = [...collections.values()].filter((c) => c.chain && c.chain.ix()?.lastHeight !== ix.lastHeight);
  if (behind.length) { console.error(`${behind.length} collection(s) did not finish syncing: ${behind.map((c) => c.rules.name).join(', ')}; run it again`); process.exit(2); }
  // without the registry no other collection can be found: a pass that lost it has not followed them all
  if (FOLLOW_ALL && registry.registry()?.lastHeight !== ix.lastHeight) { console.error('the registry did not finish syncing, so other collections may be missing; run it again'); process.exit(2); }
  process.exit(opt('compare') ? await compare({ url: opt('compare'), sync: syncAll, status: primaryStatus }) : 0);
}

// Serving other people: API keys and request limits (indexer/keys.mjs). Off unless API_KEYS_FILE is set.
const gate = process.env.API_KEYS_FILE?.trim()
  ? makeGate({
    keysFile: process.env.API_KEYS_FILE.trim(),
    required: process.env.API_KEY_REQUIRED === '1',
    publicLimit: Number(env('PUBLIC_LIMIT', '30')),
    trustProxy: Number(env('TRUST_PROXY', '0')),
  })
  : null;
// Key management over HTTP for the operator (off unless ADMIN_SECRET is set, and it needs the gate).
const ADMIN = process.env.ADMIN_SECRET?.trim() || null;
const isAdmin = (req) => {
  const got = Buffer.from(String(req.headers['x-admin-secret'] ?? ''));
  const want = Buffer.from(ADMIN ?? '');
  return !!ADMIN && got.length === want.length && crypto.timingSafeEqual(got, want);
};
const readBody = (req) => new Promise((ok, no) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 10_000) { no(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('the body is not JSON')); } });
  req.on('error', no);
});
const adminLimiter = new Limiter();
async function admin(req, url, send) {
  // wrong guesses are slowed down per caller
  if (!isAdmin(req)) {
    const t = adminLimiter.take(callerAddress(req, Number(env('TRUST_PROXY', '0'))), 10);
    return send(t.ok ? 401 : 429, { error: 'not allowed' });
  }
  if (req.method === 'GET' && url.pathname === '/admin/keys') return send(200, gate.store.list().map((k) => ({ ...k, usage: gate.usage.of(k.id) })));
  if (req.method === 'POST' && url.pathname === '/admin/keys') {
    const b = await readBody(req);
    if (typeof b.label !== 'string' || !b.label.trim()) return send(400, { error: 'label is needed: who the key is for' });
    try { return send(200, gate.store.create(b.label.trim(), b.limit === undefined ? undefined : Number(b.limit), b.daily === undefined ? undefined : Number(b.daily))); } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/keys/limits') {
    const b = await readBody(req);
    try { return gate.store.setLimits(String(b.id ?? ''), { limit: b.limit === undefined ? undefined : Number(b.limit), daily: b.daily === undefined ? undefined : Number(b.daily) }) ? send(200, { id: b.id, limit: b.limit, daily: b.daily }) : send(404, { error: 'no active key with that id' }); } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/admin/keys/revoke') {
    const b = await readBody(req);
    return gate.store.revoke(String(b.id ?? '')) ? send(200, { revoked: b.id }) : send(404, { error: 'no active key with that id' });
  }
  return send(404, { error: 'not found' });
}

const namesOf = () => registry.registry()?.names ?? null;
const nameRoute = (p) => {
  const names = namesOf();
  if (!names) return { code: 503, body: { error: 'still syncing' } };
  if (p === '/names/info') { const st = names.state(); return { code: 200, body: { ...st, index: st } }; } // index: the shape tools/names-indexer.mjs --compare reads
  if (p.startsWith('/names/of/')) return { code: 200, body: { names: names.of(decodeURIComponent(p.slice('/names/of/'.length))) } };
  const rec = names.resolve(decodeURIComponent(p.slice('/names/'.length)).trim().toLowerCase());
  return rec ? { code: 200, body: { name: rec.name, address: rec.to, id: rec.id, height: rec.height } } : { code: 404, body: { error: 'nobody has that name' } };
};

// Every answer is built once per block and kept compressed (serve.mjs); costOf and OPEN price them.
const { answer } = makeAnswers();

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let extra = {};
  const base = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-api-key, authorization, if-none-match', 'access-control-expose-headers': 'etag, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-daily-limit, x-ratelimit-daily-remaining, retry-after', ...extra });
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...base() });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...base(), 'access-control-allow-methods': 'GET' }); return res.end(); }
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname.startsWith('/admin/')) return gate && ADMIN ? await admin(req, url, send) : send(404, { error: 'not found' });
    const { col, path } = byPath(url.pathname);
    const route = routes[path];
    const isName = path.startsWith('/names/') && path.length > '/names/'.length;
    if (req.method !== 'GET' || (!route && !isName)) return send(404, { error: 'not found' });
    if (!col) return send(404, { error: 'no such collection here; see /collections' });
    // names, /registry and /collections are the same answer under any /c/<cid>/ prefix
    const global = isName || GLOBAL.has(path);
    if (col.skipped && !global) return send(409, { error: col.skipped });
    const ix = global ? primary.chain.ix() : col.chain.ix();
    if (!ix) {
      if (gate) { const g = gate.check(req, 1, { open: OPEN.has(path) }); extra = g.headers; if (!g.ok) return send(g.status, { error: g.error }); }
      return send(503, { error: 'still syncing' });
    }
    // The cache key names the answer, not the URL as typed: the collection (none for the primary and
    // for global answers, so those keys and ETags are what they were before /c/ existed), the route,
    // and `since`, the only query that changes an answer. A stranger can't make the indexer keep a
    // copy per spelling (/c/<cid>, /c/<cid>/, /c/<cid>/status are one answer).
    const since = path === '/state' ? Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0)) : 0;
    const key = (global || col === primary ? '' : `/c/${col.cid}`) + path + (since ? `?since=${since}` : '');
    const height = isName ? (namesOf()?.height ?? ix.lastHeight) : GLOBAL.has(path) ? globalVersion(path) : ix.lastHeight;
    // The ETag is known before anything is built, so the gate goes first: a refused call never costs
    // a build, and an unchanged answer is charged as a small call, not a heavy one.
    const unchanged = req.headers['if-none-match'] === etagOf(key, height);
    if (gate) {
      const g = gate.check(req, unchanged ? 1 : costOf(path, since), { open: OPEN.has(path) });
      extra = g.headers;
      if (!g.ok) return send(g.status, { error: g.error });
    }
    const names = isName ? nameRoute(path) : null;
    if (names && names.code !== 200) return send(names.code, names.body); // a miss is not kept: unknown names are endless
    const a = isName ? answer(key, height, () => names.body) : answer(key, height, () => route(col, ix, new URLSearchParams(since ? { since: String(since) } : {})));
    sendAnswer(req, res, a, { 'content-type': 'application/json', 'cache-control': 'no-cache', etag: a.etag, vary: 'accept-encoding', ...base() });
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, async () => {
  console.error(`listening on :${PORT}`);
  await syncAll();
  const ix = chain.ix();
  console.error(`synced to ${ix?.lastHeight}; state digest ${ix ? digestOf(ix).slice(0, 16) : '-'}…; following ${[...collections.values()].filter((c) => c.chain).length} collection(s)`);
  setInterval(syncAll, 20_000).unref();
});
