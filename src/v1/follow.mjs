// Node-only: follow Bitcoin with your own indexer. Blocks come from a chain SOURCE, either
//   - your own Bitcoin Core node over JSON-RPC (nothing else needed, no txindex), or
//   - any esplora / mempool-compatible HTTP API (your own instance works the same).
// Used by the standalone indexer, co-signer and relayer, so none of them trusts Ord Dropz's servers
// for state. Every block is checked against the hash that was asked for and against its own
// transaction root before it is used. Blocks are cached on disk by hash; a reorg rebuilds.
import fs from 'node:fs';
import path from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { Indexer, envelopesOf } from './indexer.mjs';
import { parseRules, collectionId } from './rules.mjs';
import { parseEnvelope, T } from './envelope.mjs';
import { rulesFromChain } from './inscribe.mjs';
import { Registry, scanBlock } from './registry.mjs';
import { toHex } from './core.mjs';

export const networkOf = (name) => (name === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);
export const defaultApi = (name) => (name === 'mainnet' ? 'https://mempool.space/api' : 'https://mempool.space/signet/api');

export function makeApi(api) {
  return async function get(p, as = 'json') {
    for (let attempt = 0; ; attempt++) {
      const wait = () => new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      let r;
      try {
        r = await fetch(api + p, { signal: AbortSignal.timeout(60_000) });
        // the body is read inside the try: a connection cut half-way through a block is retried too
        if (r.ok) return as === 'json' ? await r.json() : as === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
      } catch (e) {
        // no answer at all (connection dropped, timed out): the same request is safe to send again
        if (attempt < 5) { await wait(); continue; }
        throw new Error(`${p}: ${e?.cause?.code ?? e?.message ?? e}`);
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 5) { await wait(); continue; }
      const e = new Error(`${p}: ${r.status}`);
      e.status = r.status;
      throw e;
    }
  };
}

/**
 * Bitcoin Core JSON-RPC. `url` is http://user:password@127.0.0.1:8332 (signet: port 38332), or a
 * plain http://127.0.0.1:8332 together with `cookieFile` (the node's .cookie file).
 */
export function makeRpc(url, cookieFile = null) {
  const u = new URL(url);
  let userPass = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null;
  u.username = '';
  u.password = '';
  let id = 0;
  return async function rpc(method, ...params) {
    // the cookie changes every time the node restarts, so it is read per call
    const auth = userPass ?? (cookieFile ? fs.readFileSync(cookieFile, 'utf8').trim() : null);
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {}) },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`bitcoin node, ${method}: HTTP ${r.status}`);
    if (j.error) throw new Error(`bitcoin node, ${method}: ${j.error.message}`);
    return j.result;
  };
}

/** The block we were given is the block we asked for, and its transactions match its header. */
export function verifiedBlock(raw, hash) {
  const block = bitcoin.Block.fromBuffer(raw);
  if (block.getId() !== hash) throw new Error(`block ${hash}: the source returned a different block`);
  if (!block.checkTxRoots()) throw new Error(`block ${hash}: transactions do not match the header`);
  return block;
}

/**
 * Where blocks come from. Give `rpc` (Bitcoin Core) or `api` (esplora / mempool).
 *   tipHeight()            height of the best block
 *   hashAt(height)         hash of the block at that height in the best chain
 *   block(hash)            the verified block (bitcoinjs Block)
 *   prevoutScripts(hash, txid)   scriptPubKey of every coin that tx spends ([Buffer | null])
 *   txHex(txid, blockHash) a transaction's raw hex
 *   get                    the raw HTTP getter (esplora only; null on a node)
 */
export function makeSource({ api, rpc, rpcCookie } = {}) {
  // both followers (collection + registry) ask for the same blocks: download each one once
  const recent = new Map();
  const once = (key, make) => {
    if (!recent.has(key)) {
      recent.set(key, make().catch((e) => { recent.delete(key); throw e; }));
      if (recent.size > 6) recent.delete(recent.keys().next().value);
    }
    return recent.get(key);
  };

  if (rpc) {
    const call = makeRpc(rpc, rpcCookie);
    // verbosity 3 carries the spent coin of every input (from the node's undo data): no txindex
    const detailed = (hash) => once('v3:' + hash, () => call('getblock', hash, 3));
    return {
      kind: 'node',
      label: 'your Bitcoin node',
      get: null,
      tipHeight: async () => Number(await call('getblockcount')),
      hashAt: (h) => call('getblockhash', h),
      block: (hash) => once('b:' + hash, async () => verifiedBlock(Buffer.from(await call('getblock', hash, 0), 'hex'), hash)),
      async prevoutScripts(hash, txid) {
        const t = (await detailed(hash)).tx.find((x) => x.txid === txid);
        if (!t) throw new Error(`tx ${txid} is not in block ${hash}`);
        return t.vin.map((v) => {
          if (v.prevout?.scriptPubKey?.hex) return Buffer.from(v.prevout.scriptPubKey.hex, 'hex');
          if (v.coinbase !== undefined) return null;
          // A node older than 25.0 answers verbosity 3 without the spent coins. Carrying on would
          // silently reject every mint, so stop instead.
          throw new Error(`the node did not return the coins spent by ${txid}: Bitcoin Core 25.0 or newer is needed`);
        });
      },
      // with the block hash this works on any node; without it the node needs txindex=1
      txHex: (txid, blockHash) => (blockHash ? call('getrawtransaction', txid, false, blockHash) : call('getrawtransaction', txid, false)),
    };
  }

  if (!api) throw new Error('give a Bitcoin node (rpc) or an esplora / mempool API (api)');
  const base = String(api).replace(/\/+$/, '');
  const get = makeApi(base);
  return {
    kind: 'api',
    label: base,
    get,
    tipHeight: async () => Number(await get('/blocks/tip/height', 'text')),
    hashAt: async (h) => String(await get(`/block-height/${h}`, 'text')).trim(),
    block: (hash) => once('b:' + hash, async () => verifiedBlock(await get(`/block/${hash}/raw`, 'buf'), hash)),
    async prevoutScripts(_hash, txid) {
      const full = await get(`/tx/${txid}`);
      return full.vin.map((v) => (v.prevout ? Buffer.from(v.prevout.scriptpubkey, 'hex') : null));
    },
    txHex: async (txid) => String(await get(`/tx/${txid}/hex`, 'text')).trim(),
  };
}
const sourceOf = (o) => o.source ?? makeSource({ api: o.api, rpc: o.rpc, rpcCookie: o.rpcCookie });

/**
 * The collection's rules: from the parent inscription's reveal tx, or a local file (test collections).
 * `rulesBlock` = hash of the block holding the parent; a node without txindex needs it.
 */
export async function loadRules({ api, rpc, rpcCookie, source, rulesInscriptionId, rulesFile, rulesBlock }) {
  if (rulesFile) return parseRules(fs.readFileSync(rulesFile, 'utf8'));
  const src = source ?? makeSource({ api, rpc, rpcCookie });
  const txid = rulesInscriptionId.split('i')[0];
  let hex;
  try {
    hex = await src.txHex(txid, rulesBlock);
  } catch (e) {
    if (src.kind === 'node' && !rulesBlock) throw new Error(`can't read the parent tx ${txid} from the node (${e.message}). Give the hash of its block (RULES_BLOCK), or run the node with txindex=1.`);
    throw e;
  }
  return parseRules(rulesFromChain(hex, rulesInscriptionId).text);
}

const revive = (_k, v) => (v && typeof v === 'object' && typeof v.hex === 'string' && Object.keys(v).length === 1 ? Buffer.from(v.hex, 'hex') : v);
const ser = (o) => JSON.stringify(o, (_k, v) => (v?.type === 'Buffer' ? { hex: Buffer.from(v.data).toString('hex') } : v));
const cached = (file) => {
  if (!fs.existsSync(file)) return null;
  // a file cut short by a crash is fetched again instead of stalling the indexer
  try { return JSON.parse(fs.readFileSync(file, 'utf8'), revive); } catch { fs.rmSync(file, { force: true }); return null; }
};
const store = (file, value) => { fs.writeFileSync(file + '.tmp', ser(value)); fs.renameSync(file + '.tmp', file); };
const mintCids = (outs) => {
  const cids = [];
  for (const { data } of envelopesOf({ outs })) {
    try { const e = parseEnvelope(data); if (e && (e.type === T.MINT || e.type === T.MINTN)) cids.push(toHex(e.cid)); } catch { /* not an envelope */ }
  }
  return cids;
};

// Reorg check shared by both followers: are the last blocks we applied still in the best chain?
async function stillOnChain(src, hashes, lastHeight, startHeight) {
  for (let h = lastHeight; h >= Math.max(startHeight, lastHeight - 6); h--) {
    if (hashes.get(h) !== (await src.hashAt(h))) return false;
  }
  return true;
}

/**
 * Follow the GLOBAL registry (every shielded collection + global piece numbers; registry.mjs) from
 * startHeight. Each block's registry facts are cached on disk by hash; a reorg rebuilds.
 */
export function registryFollower({ network, api, rpc, rpcCookie, source, cacheDir, startHeight }) {
  const src = sourceOf({ api, rpc, rpcCookie, source });
  const NET = networkOf(network);
  const dir = path.resolve(cacheDir, `${network}-registry`);
  let reg = null;
  let hashes = new Map();
  let busy = null;

  async function facts(height, hash, work) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${height}-${hash}.json`);
    const hit = cached(file);
    if (hit) return hit;
    const f = scanBlock(await src.block(hash));
    // The spent coins of a carrier only matter for a mint of a collection that has not taken its
    // number range yet (known without a range, or born in this block): that is the one rule here
    // that reads them. Every other carrier needs no lookup.
    const open = new Set([...work.collections.entries()].filter(([, c]) => !c.range).map(([cid]) => cid));
    for (const p of f.parents) open.add(toHex(collectionId(p.id)));
    for (const c of f.carriers) {
      if (!mintCids(c.outs).some((cid) => open.has(cid))) continue;
      (await src.prevoutScripts(hash, c.txid)).forEach((s, n) => { if (s) c.ins[n].script = s; });
    }
    store(file, f);
    return f;
  }

  async function syncOnce() {
    if (startHeight == null) return; // numbering not started on this network yet
    const tip = await src.tipHeight();
    if (reg && !(await stillOnChain(src, hashes, reg.lastHeight, startHeight))) { reg = null; hashes = new Map(); }
    const work = reg ?? new Registry(NET);
    for (let h = reg ? reg.lastHeight + 1 : startHeight; h <= tip; h++) {
      const hash = await src.hashAt(h);
      work.applyBlock(h, await facts(h, hash, work));
      hashes.set(h, hash);
    }
    if (work.lastHeight !== null) reg = work;
  }
  const sync = () => (busy ??= syncOnce().catch((e) => console.error('registry sync:', e.message)).finally(() => { busy = null; }));
  return { sync, registry: () => reg };
}

export function follower({ network, api, rpc, rpcCookie, source, cacheDir, rulesInscriptionId, rules, vkey, startHeight, onProgress }) {
  const src = sourceOf({ api, rpc, rpcCookie, source });
  const NET = networkOf(network);
  const dir = path.resolve(cacheDir, network);
  let ix = null;
  let hashes = new Map();
  let tip = 0;
  let busy = null;

  async function fetchBlock(height, hash) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${height}-${hash}.json`);
    const hit = cached(file);
    if (hit) return hit;
    const block = await src.block(hash);
    const txs = [];
    for (const t of block.transactions) {
      const txid = t.getId();
      const outs = t.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value }));
      const ins = t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index }));
      // Every tx keeps the coins it spends (a listing lock being spent). Only txs that carry a SHORD
      // envelope keep their outputs, and only a mint needs the scripts of the coins it spends (the
      // mint-gate rule is the one rule that reads them).
      if (envelopesOf({ outs }).length) {
        if (mintCids(outs).length) (await src.prevoutScripts(hash, txid)).forEach((s, n) => { if (s) ins[n].script = s; });
        txs.push({ txid, ins, outs });
      } else txs.push({ txid, ins, outs: [] });
    }
    store(file, txs);
    return txs;
  }

  async function syncOnce() {
    tip = await src.tipHeight();
    if (ix && !(await stillOnChain(src, hashes, ix.lastHeight, startHeight))) { console.warn(`reorg near ${ix.lastHeight}: rebuilding`); ix = null; hashes = new Map(); }
    const work = ix ?? new Indexer({ rulesInscriptionId, rules, network: NET, vkey });
    for (let h = ix ? ix.lastHeight + 1 : startHeight; h <= tip; h++) {
      const hash = await src.hashAt(h);
      await work.applyBlock(h, await fetchBlock(h, hash));
      hashes.set(h, hash);
      if (!ix && onProgress) onProgress(h, tip);
    }
    if (work.lastHeight !== null) ix = work; // published only once it reaches the tip
  }
  const sync = () => (busy ??= syncOnce().catch((e) => console.error('sync:', e.message)).finally(() => { busy = null; }));

  return {
    get: src.get, NET, sync, source: src,
    ix: () => ix,
    tip: () => tip,
    /** the hash of a block this indexer applied */
    hashAt: (h) => hashes.get(h) ?? null,
    /** make sure we're at the tip right now (before signing / publishing anything) */
    async fresh() {
      await sync();
      if (!ix || ix.lastHeight < tip) throw new Error('not synced to the tip yet');
      return ix;
    },
  };
}
