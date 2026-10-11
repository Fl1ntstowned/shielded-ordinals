// Node-only: follow Bitcoin with your own indexer. Blocks come from a chain SOURCE, either
//   - your own Bitcoin Core node over JSON-RPC (nothing else needed, no txindex), or
//   - any esplora / mempool-compatible HTTP API (your own instance works the same).
// Used by the standalone indexer, co-signer and relayer, so none of them trusts Ord Dropz's servers
// for state. Every block is checked against the hash that was asked for, its own transaction root,
// its proof of work and the block applied before it, before it is used. Blocks are cached on disk by
// hash. A reorg rebuilds the state next to the old one (from a checkpoint when there is one) and
// swaps it in at the tip; the old state is served until then.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { Indexer, envelopesOf } from './indexer.mjs';
import { parseRules, collectionId, vkeyHash } from './rules.mjs';
import { parseEnvelope, T } from './envelope.mjs';
import { rulesFromChain } from './inscribe.mjs';
import { Registry, scanBlock } from './registry.mjs';
import { toHex } from './core.mjs';
import { engineStamp, capture, persist, loadNewest, hooksSaveable, hookStates, restoreHooks } from './checkpoint.mjs';

/** Checkpoints (checkpoint.mjs): written at the tip when the block height is a multiple of this, */
export const CHECKPOINT_EVERY = 6;
/** every this many blocks during a long replay, */
export const CHECKPOINT_REPLAY_EVERY = 144;
/** and the newest this many are kept per collection. */
export const CHECKPOINT_KEEP = 4;

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

/** A block's proof-of-work target, from its compact `bits`. */
export function targetOf(bits) {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) return 0n; // a negative target: no hash meets it
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}
/** The easiest target a mainnet block may have here: block 969342's (bits 0x17021ec5) times 1024.
 *  Difficulty moves at most 4x per 2,016 blocks, so honest blocks stay far under it; a source that
 *  invents blocks would have to do real mainnet-scale work. */
export const MAINNET_MAX_TARGET = 0x0000000000000000087b14000000000000000000000000000000000000000000n;

/**
 * Checks on a block's header that refuse made-up blocks (honest blocks always pass):
 *   - its hash meets the target in its own `bits` (proof of work);
 *   - prevHash (when given): it builds on that block, the one applied before it;
 *   - network 'mainnet': that target is no easier than MAINNET_MAX_TARGET.
 */
export function checkBlockHeader(block, { prevHash = null, network = null } = {}) {
  const id = block.getId();
  if (!block.checkProofOfWork()) throw new Error(`block ${id}: its hash does not meet its own proof-of-work target`);
  if (prevHash && Buffer.from(block.prevHash).reverse().toString('hex') !== prevHash) throw new Error(`block ${id}: it does not build on block ${prevHash}`);
  if (network === 'mainnet' && targetOf(block.bits) > MAINNET_MAX_TARGET) throw new Error(`block ${id}: its proof-of-work target is far easier than mainnet's`);
}

/** The block we were given is the block we asked for, its transactions match its header, and the
 *  header passes checkBlockHeader (proof of work always; prevHash and network when given). */
export function verifiedBlock(raw, hash, { prevHash = null, network = null } = {}) {
  const block = bitcoin.Block.fromBuffer(raw);
  if (block.getId() !== hash) throw new Error(`block ${hash}: the source returned a different block`);
  if (!block.checkTxRoots()) throw new Error(`block ${hash}: transactions do not match the header`);
  checkBlockHeader(block, { prevHash, network });
  return block;
}

/**
 * hashesFrom's answer, checked: ascending [[height, hash, prevHash]], one height after another up to
 * `top`, each block building on the one before it.
 */
export function linkedHashes(rows, top) {
  const out = rows.map(([h, hash, prev]) => [Number(h), String(hash), String(prev ?? '')]).sort((a, b) => a[0] - b[0]);
  if (!out.length || out[out.length - 1][0] !== top) throw new Error(`the chain source did not return block ${top}`);
  out.forEach(([h, hash], i) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`the chain source returned a malformed hash for block ${h}`);
    if (i && (h !== out[i - 1][0] + 1 || out[i][2] !== out[i - 1][1])) throw new Error(`the chain source returned blocks ${out[i - 1][0]} and ${h} that do not link`);
  });
  return out;
}

/**
 * Where blocks come from. Give `rpc` (Bitcoin Core) or `api` (esplora / mempool).
 *   tipHeight()            height of the best block
 *   hashAt(height)         hash of the block at that height in the best chain
 *   hashesFrom(h, tip)     up to 10 blocks at once: ascending [[height, hash, prevHash]] for the blocks
 *                          top-9 .. top, top = min(h + 9, tip), checked to link (linkedHashes).
 *                          esplora: one GET /blocks/<top>; a node: getblockhash + getblockheader (local)
 *   block(hash)            the verified block (bitcoinjs Block)
 *   prevoutScripts(hash, txid)   scriptPubKey of every coin that tx spends ([Buffer | null])
 *   txHex(txid, blockHash) a transaction's raw hex
 *   get                    the raw HTTP getter (esplora only; null on a node)
 *   rpc                    the raw JSON-RPC caller (a node only; null on esplora)
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
      rpc: call,
      tipHeight: async () => Number(await call('getblockcount')),
      hashAt: (h) => call('getblockhash', h),
      async hashesFrom(h, tip) {
        const top = Math.min(h + 9, tip);
        const rows = [];
        let hash = await call('getblockhash', top);
        for (let k = top; k >= Math.max(0, top - 9) && hash; k--) {
          const head = await call('getblockheader', hash);
          rows.push([k, hash, head.previousblockhash ?? '']);
          hash = head.previousblockhash;
        }
        return linkedHashes(rows, top);
      },
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
    rpc: null,
    tipHeight: async () => Number(await get('/blocks/tip/height', 'text')),
    hashAt: async (h) => String(await get(`/block-height/${h}`, 'text')).trim(),
    async hashesFrom(h, tip) {
      // GET /blocks/<top>: the 10 blocks top, top-1, … with their ids and previous block ids
      const top = Math.min(h + 9, tip);
      const list = await get(`/blocks/${top}`);
      if (!Array.isArray(list)) throw new Error(`/blocks/${top}: not a list of blocks`);
      return linkedHashes(list.filter((b) => b && Number(b.height) <= top).map((b) => [b.height, b.id, b.previousblockhash]), top);
    },
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
export async function loadRules(opts) {
  return (await loadRulesInfo({ ...opts, withHeight: false })).rules;
}

/**
 * The rules and where they came from: { rules, text (the inscribed JSON as written), txid (the
 * parent's reveal tx), height (the block holding it, or null when unknown) }.
 * height: esplora GET /tx/<txid> status.block_height; a node: getblockheader(rulesBlock).height when
 * rulesBlock is given. A rules file has no height.
 */
export async function loadRulesInfo({ api, rpc, rpcCookie, source, rulesInscriptionId, rulesFile, rulesBlock, withHeight = true }) {
  if (rulesFile) {
    const text = fs.readFileSync(rulesFile, 'utf8');
    return { rules: parseRules(text), text, txid: rulesInscriptionId?.split('i')[0] ?? null, height: null };
  }
  const src = source ?? makeSource({ api, rpc, rpcCookie });
  const txid = rulesInscriptionId.split('i')[0];
  let hex;
  try {
    hex = await src.txHex(txid, rulesBlock);
  } catch (e) {
    if (src.kind === 'node' && !rulesBlock) throw new Error(`can't read the parent tx ${txid} from the node (${e.message}). Give the hash of its block (RULES_BLOCK), or run the node with txindex=1.`);
    throw e;
  }
  const { text } = rulesFromChain(hex, rulesInscriptionId);
  const rules = parseRules(text);
  let height = null;
  if (withHeight) {
    if (src.rpc && rulesBlock) height = Number((await src.rpc('getblockheader', rulesBlock)).height);
    else if (src.get) height = (await src.get(`/tx/${txid}`))?.status?.block_height ?? null;
  }
  return { rules, text, txid, height };
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

// Reorg check shared by both followers: are the last blocks we applied still in the best chain? A
// linked source (indexer/chainview.mjs: every hash it gives builds on the one under it) needs only the
// last block, because a block's hash commits to every block before it. Any other source: the last 7.
async function stillOnChain(src, hashes, lastHeight, startHeight) {
  const from = src.linked ? lastHeight : Math.max(startHeight, lastHeight - 6);
  for (let h = lastHeight; h >= from; h--) {
    if (hashes.get(h) !== (await src.hashAt(h))) return false;
  }
  return true;
}

// The hashes of these heights in the best chain: from memory on a linked source, in batches of 10
// where the source has hashesFrom, else one by one.
async function bestHashes(src, heights, tip) {
  const out = new Map();
  if (src.linked || !src.hashesFrom) {
    for (const h of heights) out.set(h, h > tip ? null : await src.hashAt(h));
    return out;
  }
  const want = heights.filter((h) => h <= tip).sort((a, b) => a - b);
  for (let i = 0; i < want.length;) {
    for (const [h, hash] of await src.hashesFrom(want[i], tip)) out.set(h, hash);
    while (i < want.length && out.has(want[i])) i++;
    if (i < want.length && !out.has(want[i])) {
      const h = want[i];
      out.set(h, await src.hashAt(h));
      i++;
    }
  }
  return out;
}

/**
 * Follow the GLOBAL registry (every shielded collection + global piece numbers; registry.mjs) from
 * startHeight. Each block's registry facts are cached on disk by hash. A reorg rebuilds the registry
 * from startHeight next to the old one, which is served until the new one reaches the tip.
 */
export function registryFollower({ network, api, rpc, rpcCookie, source, cacheDir, startHeight }) {
  const src = sourceOf({ api, rpc, rpcCookie, source });
  const NET = networkOf(network);
  const dir = path.resolve(cacheDir, `${network}-registry`);
  let reg = null;
  let hashes = new Map();
  let busy = null;
  let stopping = false;

  async function facts(height, hash, work, prevHash) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${height}-${hash}.json`);
    const hit = cached(file);
    if (hit) return hit;
    const block = await src.block(hash);
    checkBlockHeader(block, { prevHash, network });
    const f = scanBlock(block);
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
    let work = reg;
    let hs = hashes;
    if (reg && !(await stillOnChain(src, hashes, reg.lastHeight, startHeight))) {
      console.warn(`registry: reorg near ${reg.lastHeight}: rebuilding; the old registry is served until the new one reaches the tip`);
      work = null;
    }
    if (!work) { work = new Registry(NET); hs = new Map(); }
    for (let h = work.lastHeight === null ? startHeight : work.lastHeight + 1; h <= tip && !stopping; h++) {
      const hash = await src.hashAt(h);
      work.applyBlock(h, await facts(h, hash, work, hs.get(h - 1) ?? null));
      hs.set(h, hash);
    }
    if (work !== reg && work.lastHeight !== null && work.lastHeight >= tip) { reg = work; hashes = hs; }
  }
  const sync = () => (stopping ? Promise.resolve() : (busy ??= syncOnce().catch((e) => console.error('registry sync:', e.message)).finally(() => { busy = null; })));
  return {
    sync, registry: () => reg,
    /** the hash of a block the registry applied (null for any other height) */
    hashAt: (h) => hashes.get(h) ?? null,
    /** stop after the block in hand; resolves when the running sync has returned */
    stop() { stopping = true; return busy ?? Promise.resolve(); },
  };
}

/**
 * Follow one collection: replay its rules engine (indexer.mjs) from startHeight, block by block.
 * `hooks` (optional): side indexes that read the same blocks without ever changing the engine.
 *   beforeBlock(h, hash, txs, src)  awaited before block h is applied (txs = the cached reduced block).
 *                                   Throwing aborts the round before block h, like a failed fetch.
 *   afterBlock(h, ix)               called synchronously right after block h is applied
 *   reset()                         a new engine starts from startHeight (first sync, or after a reorg),
 *                                   or from a checkpoint (then restore() follows)
 *   id, snapshot() -> data, restore(data)   the hook's state in a checkpoint, under its id. Data may
 *                                   hold Maps, Sets, BigInts and Buffers (checkpoint.mjs encode).
 *                                   restore() that throws refuses that checkpoint.
 *   stateless: true                 a hook with no state of its own (no snapshot needed)
 * A hook with beforeBlock or afterBlock but neither snapshot/restore nor stateless turns checkpoints
 * off for this collection: they could not bring its state back.
 *
 * Checkpoints (checkpoint.mjs), off unless `checkpoints` is true: in <checkpointDir>/<network>/<cid>/
 * (default <cacheDir>/checkpoints), written right after a block when it is the tip and its height is a
 * multiple of checkpointEvery, every CHECKPOINT_REPLAY_EVERY blocks during a long replay, and by
 * checkpoint(). The first sync loads the newest one that passes every check and replays only the
 * blocks after it. A reorg rolls back to the newest one still in the best chain, next to the old state.
 *   rulesText    the parent's rules exactly as inscribed (their sha256 is in every checkpoint)
 *   makeIndexer  makes a fresh engine (tests); default new Indexer(...)
 *   digest2(ix)  optional second digest kept in the checkpoint header and checked on load
 */
export function follower({
  network, api, rpc, rpcCookie, source, cacheDir, rulesInscriptionId, rules, rulesText = null, vkey, startHeight, onProgress, hooks = [],
  checkpoints = false, checkpointDir = null, checkpointEvery = CHECKPOINT_EVERY, checkpointKeep = CHECKPOINT_KEEP, makeIndexer = null, digest2 = null,
}) {
  const src = sourceOf({ api, rpc, rpcCookie, source });
  const NET = networkOf(network);
  const dir = path.resolve(cacheDir, network);
  const cid = toHex(collectionId(rulesInscriptionId));
  const fresh = () => (makeIndexer ? makeIndexer() : new Indexer({ rulesInscriptionId, rules, network: NET, vkey }));
  const ids = hooks.map((k, i) => (typeof k.id === 'string' && k.id ? k.id : `hook${i}`));
  if (new Set(ids).size !== ids.length) throw new Error('two follower hooks have the same id');
  const saveable = hooksSaveable(hooks.filter((k) => k.beforeBlock || k.afterBlock));
  if (checkpoints && !saveable) console.warn(`${rules.name}: checkpoints are off: a hook has no snapshot() and restore()`);
  const ckOn = !!checkpoints && saveable;
  const ckDir = path.resolve(checkpointDir ?? path.join(cacheDir, 'checkpoints'), network, cid);
  let meta = null;
  const metaOf = () => (meta ??= {
    stamp: engineStamp({ vkeyHash: vkeyHash(vkey) }), network, cid, rulesInscriptionId,
    rulesHash: crypto.createHash('sha256').update(rulesText ?? JSON.stringify(rules)).digest('hex'), vkeyHash: vkeyHash(vkey), startHeight,
  });

  let ix = null; // the published engine, at the tip of the best chain (or the old chain while a reorg rebuilds)
  let hashes = new Map(); // the block hashes under ix
  let stale = false; // a reorg was seen and its replacement has not reached the tip yet
  let current = null; // { work, hs, clean }: the engine being advanced (ix itself at the tip)
  let tip = 0;
  let busy = null;
  let stopping = false;
  let saved = null; // { height, blockHash } of the newest checkpoint taken (written or being written) or loaded
  let writes = Promise.resolve();
  const say = (m) => console.error(`  ${rules.name}: ${m}`);

  async function fetchBlock(height, hash, prevHash) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${height}-${hash}.json`);
    const hit = cached(file);
    if (hit) return hit;
    const block = await src.block(hash);
    checkBlockHeader(block, { prevHash, network });
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

  // Serialized now (the engine may not change before it is), written in the background.
  function save(work, hs) {
    let cp;
    try {
      cp = capture(work, { meta: metaOf(), hooks, hashOf: (h) => hs.get(h) ?? null, digest2 });
    } catch (e) {
      say(`no checkpoint at block ${work.lastHeight}: ${e.message}`);
      return writes;
    }
    // counted from the moment the state is taken (an answer built at this block already shows it);
    // a write that fails puts the previous one back
    const prev = saved;
    saved = { height: cp.height, blockHash: cp.blockHash };
    writes = writes.then(() => persist(ckDir, cp, { keep: checkpointKeep })).then(
      () => {},
      (e) => {
        if (saved?.height === cp.height && saved.blockHash === cp.blockHash) saved = prev;
        say(`checkpoint at block ${cp.height} not written: ${e.message}`);
      },
    );
    return writes;
  }

  // Is this checkpoint's block, and the 11 before it, still in the best chain?
  async function onChain(header) {
    const want = new Map(header.recent);
    const got = await bestHashes(src, [...want.keys()], tip);
    return [...want].every(([h, x]) => got.get(h) === x);
  }

  // A new engine: the newest checkpoint at or below maxHeight that passes every check, else empty.
  async function startEngine(maxHeight) {
    if (ckOn) {
      const got = await loadNewest({ dir: ckDir, meta: metaOf(), make: fresh, hooks, onChain, maxHeight, digest2, log: say });
      if (got) {
        say(`loaded the checkpoint at block ${got.header.height}`);
        saved = { height: got.header.height, blockHash: got.header.blockHash };
        return { work: got.ix, hs: new Map(got.header.recent) };
      }
    }
    for (const k of hooks) k.reset?.();
    return { work: fresh(), hs: new Map() };
  }

  async function syncOnce() {
    tip = await src.tipHeight();
    let work;
    let hs;
    let undo = null; // the hooks' state under the old engine, put back if a rebuild fails
    if (ix && !(await stillOnChain(src, hashes, ix.lastHeight, startHeight))) {
      stale = true;
      console.warn(`reorg near ${ix.lastHeight}: rolling back${ckOn ? ' to a checkpoint' : ''}; the old state is served until the new one reaches the tip`);
      if (hooksSaveable(hooks)) undo = hookStates(hooks);
      ({ work, hs } = await startEngine(Math.min(ix.lastHeight, tip)));
    } else if (ix) {
      work = ix;
      hs = hashes;
      stale = false; // the served state is on the best chain (again, when a rebuild failed and the chain came back)
    } else if (current?.clean && current.work.lastHeight !== null && (await stillOnChain(src, current.hs, current.work.lastHeight, startHeight))) {
      ({ work, hs } = current); // a first replay that an error cut short carries on where it stopped
    } else {
      ({ work, hs } = await startEngine(tip));
    }
    current = { work, hs, clean: true };
    try {
      for (let h = work.lastHeight === null ? startHeight : work.lastHeight + 1; h <= tip && !stopping; h++) {
        const hash = await src.hashAt(h);
        if (!hash) throw new Error(`no block ${h} in the best chain`);
        const txs = await fetchBlock(h, hash, hs.get(h - 1) ?? null);
        for (const k of hooks) await k.beforeBlock?.(h, hash, txs, src);
        current.clean = false;
        await work.applyBlock(h, txs);
        for (const k of hooks) k.afterBlock?.(h, work);
        hs.set(h, hash);
        current.clean = true;
        if (ckOn && (h % CHECKPOINT_REPLAY_EVERY === 0 || (h === tip && h % checkpointEvery === 0))) save(work, hs);
        if (work !== ix && onProgress) onProgress(h, tip);
      }
    } catch (e) {
      if (work !== ix && ix) {
        // a rebuild after a reorg failed: drop it, keep serving the old state with its hooks
        if (undo) restoreHooks(hooks, undo);
        current = { work: ix, hs: hashes, clean: true };
      }
      throw e;
    }
    // published only once it reaches the tip
    if (work !== ix && work.lastHeight !== null && work.lastHeight >= tip) { ix = work; hashes = hs; stale = false; }
  }
  const sync = () => (stopping ? Promise.resolve() : (busy ??= syncOnce().catch((e) => console.error('sync:', e.message)).finally(() => { busy = null; })));

  return {
    get: src.get, NET, sync, source: src, hooks,
    ix: () => ix,
    tip: () => tip,
    /** the hash of a block this indexer applied (older ones from a linked source's index) */
    hashAt: (h) => hashes.get(h) ?? (ix && h <= ix.lastHeight && !stale ? src.knownHash?.(h) ?? null : null),
    /** make sure we're at the tip right now (before signing / publishing anything) */
    async fresh() {
      await sync();
      if (!ix || stale || ix.lastHeight < tip) throw new Error('not synced to the tip yet');
      return ix;
    },
    /** stop after the block in hand; resolves when the running sync has returned */
    stop() { stopping = true; return busy ?? Promise.resolve(); },
    /** write a checkpoint of the engine in hand at its last block (on shutdown); resolves once written */
    checkpoint() {
      if (!ckOn || !current?.clean || current.work.lastHeight === null || (stale && current.work === ix)) return writes;
      const { work, hs } = current;
      if (saved?.height === work.lastHeight && saved.blockHash === hs.get(work.lastHeight)) return writes;
      return save(work, hs);
    },
    /** resolves once every checkpoint started so far is written */
    flush: () => writes,
    /** the newest checkpoint taken (written, or being written in the background) or loaded: { height } or null */
    checkpointInfo: () => (saved ? { height: saved.height } : null),
  };
}
