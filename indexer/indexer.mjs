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
//
// Serving other people (optional): API keys and request limits, see indexer/keys.mjs
//   API_KEYS_FILE=api-keys.json  [API_KEY_REQUIRED=1]  [PUBLIC_LIMIT=30]  [TRUST_PROXY=<proxy hops>]
//   [ADMIN_SECRET=<long secret>]   turns on key management over HTTP (POST/GET /admin/keys)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { follower, registryFollower, loadRules, makeSource, defaultApi } from '../src/v1/follow.mjs';
import { exportState } from '../src/v1/view.mjs';
import { saleFee, vkeyHash } from '../src/v1/rules.mjs';
import { REGISTRY_START } from '../src/v1/registry.mjs';
import { knownCollection, COLLECTIONS } from '../src/v1/collections.mjs';
import { makeGate, Limiter, callerAddress } from './keys.mjs';

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
let shown = 0;
const chain = follower({
  network: NETWORK, source, cacheDir: CACHE, rulesInscriptionId: RULES_ID, rules, vkey: VKEY, startHeight: START,
  onProgress: (h, tip) => { if (h === tip || Date.now() - shown > 15_000) { shown = Date.now(); console.error(`  replayed to ${h} / ${tip}`); } },
});
const regStart = process.env.REGISTRY_START ? Number(process.env.REGISTRY_START) : REGISTRY_START[NETWORK];
const registry = registryFollower({ network: NETWORK, source, cacheDir: CACHE, startHeight: regStart });

export const digestOf = (ix) => crypto.createHash('sha256').update(ix.stateDigest()).digest('hex');
const rawRules = () => (rulesText ? JSON.parse(rulesText) : Object.fromEntries(Object.entries(rules).filter(([k]) => !/Script$|^fileMint$/.test(k))));
const statusOf = (ix) => ({
  network: NETWORK, collection: rules.name, rulesInscriptionId: RULES_ID, lastHeight: ix.lastHeight, blockHash: chain.hashAt(ix.lastHeight),
  notes: ix.notes.length, digest: digestOf(ix), software: 'shielded-ordinals indexer',
});

const routes = {
  '/status': (ix) => statusOf(ix),
  '/state': (ix, q) => exportState(ix, { sinceNote: Math.max(0, Number(q.get('since')) || 0) }),
  '/listings': (ix) => [...ix.listings.values()].filter((l) => l.state === 'ACTIVE').map((l) => ({
    nf: String(l.nf), assetId: l.assetId, inscriptionId: rules.children?.[l.assetId] ?? null, price: String(l.price),
    saleFee: String(saleFee(rules, l.price)), tickets: l.tickets, listedAt: l.height,
  })),
  '/registry': () => registry.registry()?.list() ?? [],
  '/collection': (ix) => ({
    network: NETWORK, rulesInscriptionId: RULES_ID, cid: ix.cid.toString('hex'), rules: rawRules(), minted: ix.minted.size, lastHeight: ix.lastHeight,
    fileMint: !!rules.fileMint, inscribeFee: rules.inscribeFee ?? 0,
    global: registry.registry()?.collections.get(ix.cid.toString('hex'))?.range ?? null,
  }),
};

// Does another indexer hold the same state? Both must be at the same block, so a block that lands
// between the two reads is settled by syncing again.
async function compare(url) {
  for (let round = 0; round < 6; round++) {
    await chain.sync();
    const ix = chain.ix();
    if (!ix) throw new Error('not synced');
    const r = await fetch(url);
    const theirs = await r.json().catch(() => null);
    if (!theirs?.digest || typeof theirs.lastHeight !== 'number') { console.log('that address did not answer with an indexer status'); return 2; }
    const mine = statusOf(ix);
    if (theirs.lastHeight !== mine.lastHeight) {
      console.log(`different heights (${mine.lastHeight} here, ${theirs.lastHeight} there): trying again`);
      await new Promise((ok) => setTimeout(ok, 20_000));
      continue;
    }
    console.log(`here   ${mine.lastHeight}  notes ${mine.notes}  ${mine.digest}`);
    console.log(`there  ${theirs.lastHeight}  notes ${theirs.notes}  ${theirs.digest}`);
    if (theirs.digest === mine.digest) { console.log('AGREE: the same state at the same block'); return 0; }
    console.log('DISAGREE: the two indexers hold different state at the same block');
    return 1;
  }
  console.log('the two indexers never stood at the same block; run it again');
  return 2;
}

console.error(`shielded indexer for "${rules.name}" (${NETWORK}), blocks from ${source.label}, from block ${START}`);
if (flag('once') || opt('compare')) {
  await Promise.all([chain.sync(), registry.sync()]);
  const ix = chain.ix();
  if (!ix) { console.error('sync did not finish; run it again (blocks already read are kept)'); process.exit(2); }
  console.log(JSON.stringify(statusOf(ix)));
  process.exit(opt('compare') ? await compare(opt('compare')) : 0);
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
    const limit = b.limit === undefined ? 600 : Number(b.limit);
    if (typeof b.label !== 'string' || !b.label.trim()) return send(400, { error: 'label is needed: who the key is for' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) return send(400, { error: 'limit must be a whole number of requests per minute' });
    return send(200, gate.store.create(b.label.trim(), limit));
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

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let extra = {};
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-api-key, authorization', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-api-key, authorization', 'access-control-allow-methods': 'GET' }); return res.end(); }
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname.startsWith('/admin/')) return gate && ADMIN ? await admin(req, url, send) : send(404, { error: 'not found' });
    const route = routes[url.pathname];
    const isName = url.pathname.startsWith('/names/') && url.pathname.length > '/names/'.length;
    if (req.method !== 'GET' || (!route && !isName)) return send(404, { error: 'not found' });
    if (gate) {
      const g = gate.check(req);
      extra = g.headers;
      if (!g.ok) return send(g.status, { error: g.error });
    }
    if (isName) { const r = nameRoute(url.pathname); return send(r.code, r.body); }
    const ix = chain.ix();
    if (!ix) return send(503, { error: 'still syncing' });
    send(200, route(ix, url.searchParams));
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, async () => {
  console.error(`listening on :${PORT}`);
  await Promise.all([chain.sync(), registry.sync()]);
  const ix = chain.ix();
  console.error(`synced to ${ix?.lastHeight}; state digest ${ix ? digestOf(ix).slice(0, 16) : '-'}…`);
  setInterval(() => { chain.sync(); registry.sync(); }, 20_000).unref();
});
