// An offline synthetic chain for engine, follower and server tests. Nothing here touches the network,
// and everything is deterministic: the same calls give the same txids, block hashes and state.
//
//   const chain = new SynthChain();                   // signet parameters, blocks from 400000
//   const p = chain.parent(testRules().json);         // a collection's parent inscription (reveal tx)
//   chain.block([p.tx]);                              // block 400000
//   chain.block([chain.mint(p, [0, 1, 2])]);          // 400001: a batch mint with its gate coin and payments
//   const ix = makeIndexer(p);                        // the rules engine, proofs taken as valid
//   for (const h of chain.heights()) await ix.applyBlock(h, chain.reduced(h));
//
// The same chain read the way an indexer reads Bitcoin:
//   follower({ network: 'signet', source: chain.source, ... })      the fake source, in process
//   const esplora = await serveEsplora(chain);  CHAIN_API=esplora.url   an esplora API over HTTP
//   chain.source.fork(h)  replaces the blocks from h with new ones (a reorg)
//   chain.source.calls    every call the source answered, by kind (hash = hashAt, hashes = hashesFrom)
//
// Blocks are real Bitcoin blocks (merkle root, witness commitment, proof of work at the regtest
// target), so verifiedBlock() accepts them. Transactions spend made-up coins; the prevout script of
// every input is known (a mint's first input is the collection's gate coin).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ordinals from 'micro-ordinals';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  encodeMint, encodeMintBatch, encodeListBody, encodeTransferBody, encodeBuy, encodeClaimBody, claimSigHash, parseEnvelope, T,
} from '../../src/v1/envelope.mjs';
import { parseRules, collectionId, saleFee } from '../../src/v1/rules.mjs';
import { gateScript, lockScript } from '../../src/v1/scripts.mjs';
import { Indexer, envelopesOf } from '../../src/v1/indexer.mjs';
import { verifiedBlock, networkOf, linkedHashes } from '../../src/v1/follow.mjs';
import { CT_LEN } from '../../src/v1/core.mjs';
import { nameRecord } from '../../src/v1/names.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const hex = (b) => Buffer.from(b).toString('hex');
/** A field element made from a label (248 bits, always below the BN254 modulus). */
export const field = (label) => BigInt('0x' + hex(sha(`synth field ${label}`).subarray(1)));
const noteBits = (label) => ({
  inner: field(`inner ${label}`),
  epk: sha(`synth epk ${label}`),
  ct: Buffer.concat([0, 1, 2].map((i) => sha(`synth ct ${label} ${i}`))).subarray(0, CT_LEN),
});

/** Test keys: { sk, xonly } each, from fixed labels. */
const key = (label) => { const sk = sha(`synth key ${label}`); return { sk, xonly: Buffer.from(schnorr.getPublicKey(sk)) }; };
export const KEYS = Object.fromEntries(['gate', 'lock', 'artist', 'platform', 'relayer', 'seller', 'ret', 'reveal', 'miner'].map((k) => [k, key(k)]));
export const p2tr = (xonly) => Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(xonly)]);
export const opReturn = (data) => ({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(data)]), value: 0 });
/** A Groth16 proof slot (the engine made by makeIndexer takes every proof as valid). */
export const PROOF = Buffer.alloc(256);
export const VKEY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../zk/spend_vkey.json', import.meta.url)), 'utf8'));
export const ADDRESS = 'shord1' + 'ab'.repeat(64); // a well-formed shielded address

/** A small file-mint collection's rules: { json (as inscribed), text, rules (parsed) }. */
export function testRules(over = {}) {
  const json = {
    p: 'shord', v: 1, name: 'Synthetic Test', supply: 16,
    artRoot: hex(sha('synth art')), contentType: 'image/png', inscribeFee: 1000,
    mintPrice: 10000, artistPayoutScript: hex(p2tr(KEYS.artist.xonly)), platformPayoutScript: hex(p2tr(KEYS.platform.xonly)),
    relayerPayoutScript: hex(p2tr(KEYS.relayer.xonly)), mintFee: 1000, saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 500,
    gateKey: hex(KEYS.gate.xonly), lockKey: hex(KEYS.lock.xonly),
    ...over,
  };
  for (const k of Object.keys(json)) if (json[k] === undefined) delete json[k];
  const text = JSON.stringify(json);
  return { json, text, rules: parseRules(text) };
}

/** The rules engine for a collection made by chain.parent(), with every Groth16 proof taken as valid. */
export function makeIndexer(col, { network = 'signet' } = {}) {
  const ix = new Indexer({ rulesInscriptionId: col.id, rules: col.rules, network: networkOf(network), vkey: VKEY });
  ix._verify = async () => true;
  return ix;
}

const isMint = (outs) => envelopesOf({ outs }).some(({ data }) => {
  try { const e = parseEnvelope(data); return e && (e.type === T.MINT || e.type === T.MINTN); } catch { return false; }
});

export class SynthChain {
  constructor({ start = 400000, network = 'signet' } = {}) {
    this.start = start;
    this.network = network;
    this.NET = networkOf(network);
    this.n = 0; // every tx spends a made-up coin of its own
    this.txs = new Map(); // txid -> { tx, prevouts: [Buffer | null] }
    this.blocks = new Map(); // hash -> { raw, height, txids } (replaced blocks stay readable by hash)
    this.best = []; // the best chain's hashes, from `start`
    this.shown = null; // setTip(): the tip the chain admits to (null = its real tip)
    this.forks = 0;
    this.source = this._source();
  }

  // ---- transactions -------------------------------------------------------------------------
  /** A transaction from { ins: [{ txid?, vout?, script?, witness? }], outs: [{ script, value }] }. */
  tx({ ins = [{}], outs }) {
    const t = new bitcoin.Transaction();
    t.version = 2;
    const prevouts = [];
    ins.forEach((i, k) => {
      t.addInput(Buffer.from(i.txid ?? hex(sha(`synth coin ${this.n} ${k}`)), 'hex').reverse(), i.vout ?? 0);
      if (i.witness) t.setWitness(k, i.witness.map((w) => Buffer.from(w)));
      prevouts.push(i.script ? Buffer.from(i.script) : p2tr(sha(`synth prevout ${this.n} ${k}`)));
    });
    this.n++;
    for (const o of outs) t.addOutput(Buffer.from(o.script), Number(o.value));
    const txid = t.getId();
    this.txs.set(txid, { tx: t, prevouts });
    return { txid, tx: t };
  }

  /** One reveal tx carrying these inscriptions ([{ contentType, body, tags? }]); ids in ord order. */
  inscribe(inscriptions) {
    const script = Buffer.from(ordinals.p2tr_ord_reveal(KEYS.reveal.xonly, inscriptions.map((x) => ({
      tags: { contentType: x.contentType, ...(x.tags ?? {}) }, body: Buffer.from(x.body),
    }))).script);
    const control = Buffer.concat([Buffer.from([0xc0]), KEYS.reveal.xonly]);
    const t = this.tx({ ins: [{ witness: [Buffer.alloc(64, 1), script, control] }], outs: inscriptions.map(() => ({ script: p2tr(KEYS.reveal.xonly), value: 546 })) });
    return { ...t, ids: inscriptions.map((_, i) => `${t.txid}i${i}`) };
  }

  /** A collection's parent inscription. Returns { id, cid, cidHex, text, rules (null if invalid), tx }. */
  parent(json) {
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    const r = this.inscribe([{ contentType: 'application/json', body: Buffer.from(text) }]);
    const id = r.ids[0];
    let rules = null;
    try { rules = parseRules(text); } catch { /* not valid rules: the registry ignores it */ }
    return { id, cid: collectionId(id), cidHex: hex(collectionId(id)), text, rules, tx: r };
  }

  /** A shielded name inscription (names.mjs). */
  nameTx(name, to = ADDRESS) {
    return this.inscribe([{ contentType: 'application/json', body: Buffer.from(nameRecord(name, to)) }]);
  }

  _height() { return this.start + this.best.length - 1; } // the last block (anchors default to it)

  /** MINT (one id) or MINTN (several): spends the gate coin and pays artist, platform and relayer. */
  mint(col, ids, { ticketsBuy = 0, gate = true, pay = true } = {}) {
    ids = [].concat(ids);
    const R = col.rules;
    const tag = (a) => `${col.cidHex} mint ${a} ${this.n}`;
    const data = ids.length === 1
      ? encodeMint({ cid: col.cid, assetId: ids[0], ticketsBuy, ...noteBits(tag(ids[0])) })
      : encodeMintBatch({ cid: col.cid, mints: ids.map((a) => ({ assetId: a, ticketsBuy, ...noteBits(tag(a)) })) });
    const n = ids.length;
    const outs = [opReturn(data)];
    if (pay) {
      outs.push({ script: R.artistScript, value: n * R.mintPrice });
      if (R.mintFee > 0) outs.push({ script: R.platformScript, value: n * R.mintFee });
      const relayer = n * R.inscribeFee + n * ticketsBuy * R.ticketPrice;
      if (relayer > 0) outs.push({ script: R.relayerScript, value: relayer });
    }
    return this.tx({ ins: [{ script: gate ? gateScript(R, this.NET) : undefined }], outs });
  }

  /** TRANSFER (the proof slot is empty: only an engine from makeIndexer accepts it). */
  transfer(col, { hanchor = this._height(), nf = field(`nf ${this.n}`), cmOut = field(`cm ${this.n}`), spend = 0, buy = 0 } = {}) {
    const body = encodeTransferBody({ cid: col.cid, hanchor, nf, cmOut, spend, buy, ...noteBits(`${col.cidHex} transfer ${this.n}`) });
    const outs = [opReturn(Buffer.concat([body, PROOF]))];
    if (buy > 0) outs.push({ script: col.rules.relayerScript, value: buy * col.rules.ticketPrice });
    return { ...this.tx({ outs }), nf };
  }

  /** LIST with its lock output (vout 1). Returns the tx and `listing` for buy / cancel / claim. */
  list(col, { hanchor = this._height(), nf = field(`nf ${this.n}`), assetId, tickets = 0, spend = 0, buy = 0, price, seller = p2tr(KEYS.seller.xonly), ret = KEYS.ret } = {}) {
    const body = encodeListBody({ cid: col.cid, hanchor, nf, assetId, tickets, spend, buy, price, returnKey: ret.xonly, sellerScript: seller });
    const lock = lockScript(col.rules, ret.xonly, this.NET);
    const outs = [opReturn(Buffer.concat([body, PROOF])), { script: lock, value: 1000 }];
    if (buy > 0) outs.push({ script: col.rules.relayerScript, value: buy * col.rules.ticketPrice });
    const t = this.tx({ outs });
    return { ...t, listing: { nf, assetId, tickets, price: BigInt(price), sellerScript: Buffer.from(seller), ret, lock: { txid: t.txid, vout: 1, script: lock } } };
  }

  /** BUY: spends the listing lock and pays the seller, the platform's sale fee and any tickets. */
  buy(col, listing, { ticketsBuy = 0 } = {}) {
    const R = col.rules;
    const data = encodeBuy({ cid: col.cid, listingNf: listing.nf, ticketsBuy, ...noteBits(`${col.cidHex} buy ${this.n}`) });
    const outs = [opReturn(data), { script: listing.sellerScript, value: listing.price }, { script: R.platformScript, value: saleFee(R, listing.price) }];
    if (ticketsBuy > 0) outs.push({ script: R.relayerScript, value: ticketsBuy * R.ticketPrice });
    return this.tx({ ins: [{ txid: listing.lock.txid, vout: listing.lock.vout, script: listing.lock.script }], outs });
  }

  /** A tx that spends the listing lock with no BUY: the listing closes (the seller then CLAIMs). */
  cancel(listing) {
    return this.tx({ ins: [{ txid: listing.lock.txid, vout: listing.lock.vout, script: listing.lock.script }], outs: [{ script: listing.sellerScript, value: 700 }] });
  }

  /** CLAIM, signed with the listing's return key. */
  claim(col, listing, { spend = 0, extraIns = [] } = {}) {
    const body = encodeClaimBody({ cid: col.cid, listingNf: listing.nf, spend, ...noteBits(`${col.cidHex} claim ${this.n}`) });
    const sig = Buffer.from(schnorr.sign(claimSigHash(body), listing.ret.sk, Buffer.alloc(32)));
    return this.tx({ ins: extraIns.length ? extraIns : [{}], outs: [opReturn(Buffer.concat([body, sig]))] });
  }

  // ---- blocks -------------------------------------------------------------------------------
  /** Append a block of these txs to the best chain. Returns { height, hash }. */
  block(txs = [], { tag = '' } = {}) {
    const height = this.start + this.best.length;
    const prev = this.best.length ? this.best[this.best.length - 1] : '00'.repeat(32);
    const cb = new bitcoin.Transaction();
    cb.version = 2;
    cb.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, bitcoin.script.compile([bitcoin.script.number.encode(height), Buffer.from(`synth${tag}`)]));
    cb.setWitness(0, [Buffer.alloc(32)]);
    cb.addOutput(p2tr(KEYS.miner.xonly), 5_000_000_000);
    cb.addOutput(Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), Buffer.alloc(32)]), 0);
    const all = [cb, ...txs.map((t) => t.tx ?? t)];
    const commit = bitcoin.Block.calculateMerkleRoot(all, true);
    cb.outs[1].script = Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), commit]);
    const b = new bitcoin.Block();
    b.version = 0x20000000;
    b.prevHash = Buffer.from(prev, 'hex').reverse();
    b.timestamp = 1_700_000_000 + (height - this.start) * 600;
    b.bits = 0x207fffff;
    b.nonce = 0;
    b.transactions = all;
    b.merkleRoot = bitcoin.Block.calculateMerkleRoot(all);
    b.witnessCommit = commit;
    while (!b.checkProofOfWork()) b.nonce++;
    const hash = b.getId();
    this.txs.set(cb.getId(), { tx: cb, prevouts: [null] });
    this.blocks.set(hash, { raw: b.toBuffer(), height, txids: all.map((t) => t.getId()) });
    this.best.push(hash);
    return { height, hash };
  }

  /** Replace the best chain from `height` on: by `blocks` (lists of txs), or by the same txs in new
   *  blocks (new hashes). The replaced blocks stay readable by hash, like orphans on a node. */
  fork(height, blocks = null) {
    const i = height - this.start;
    if (i < 0 || i > this.best.length) throw new Error(`no block ${height} to fork from`);
    const old = this.best.splice(i);
    const again = blocks ?? old.map((h) => this.blocks.get(h).txids.slice(1).map((id) => this.txs.get(id).tx));
    this.forks++;
    for (const txs of again) this.block(txs, { tag: `-fork${this.forks}` });
    return { replaced: old, hashes: this.best.slice(i) };
  }

  /** The tip the chain shows (setTip(h) hides the blocks above h; setTip(null) shows them all). */
  setTip(h) { this.shown = h; }
  tipHeight() { const real = this._height(); return this.shown === null ? real : Math.min(real, this.shown); }
  hashAt(h) { return h >= this.start && h <= this.tipHeight() ? this.best[h - this.start] : null; }
  /** The hash of the block under block h (zeros under the first block). */
  prevHashAt(h) { return h > this.start ? this.best[h - this.start - 1] : '00'.repeat(32); }
  /** hashesFrom's answer (follow.mjs makeSource): [[height, hash, prevHash]] for top-9 .. top, top = min(h + 9, tip). */
  hashRows(h, tip) {
    const top = Math.min(h + 9, tip, this.tipHeight());
    const rows = [];
    for (let k = Math.max(this.start, top - 9); k <= top; k++) rows.push([k, this.hashAt(k), this.prevHashAt(k)]);
    return rows;
  }
  heights() { const out = []; for (let h = this.start; h <= this.tipHeight(); h++) out.push(h); return out; }
  rawBlock(hash) { return this.blocks.get(hash)?.raw ?? null; }
  txHex(txid) { const t = this.txs.get(txid); if (!t) throw new Error(`no tx ${txid}`); return t.tx.toHex(); }
  prevoutScripts(txid) { const t = this.txs.get(txid); if (!t) throw new Error(`no tx ${txid}`); return t.prevouts.slice(); }
  /** Height of the best-chain block holding txid, or null. */
  heightOf(txid) {
    for (let h = this.start; h <= this.tipHeight(); h++) if (this.blocks.get(this.best[h - this.start]).txids.includes(txid)) return h;
    return null;
  }

  /** Block h as the follower caches it: every tx keeps its inputs; only txs carrying a SHORD envelope
   *  keep their outputs; a mint's inputs carry their prevout scripts (the gate coin). */
  reduced(h) {
    const hash = this.hashAt(h);
    if (!hash) throw new Error(`no block ${h}`);
    return bitcoin.Block.fromBuffer(this.blocks.get(hash).raw).transactions.map((t) => {
      const txid = t.getId();
      const ins = t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index }));
      const outs = t.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value }));
      if (!envelopesOf({ outs }).length) return { txid, ins, outs: [] };
      if (isMint(outs)) this.prevoutScripts(txid).forEach((s, n) => { if (s) ins[n].script = s; });
      return { txid, ins, outs };
    });
  }

  // The chain as a follow.mjs source (makeSource's shape), counting every call.
  _source() {
    const calls = { tip: 0, hash: 0, hashes: 0, block: 0, prevouts: 0, txHex: 0 };
    const missing = (what) => Object.assign(new Error(`${what}: 404`), { status: 404 });
    return {
      kind: 'synthetic', label: 'a synthetic chain', get: null, rpc: null, calls,
      tipHeight: async () => { calls.tip++; return this.tipHeight(); },
      hashAt: async (h) => { calls.hash++; const x = this.hashAt(h); if (!x) throw missing(`/block-height/${h}`); return x; },
      hashesFrom: async (h, tip) => {
        calls.hashes++;
        const top = Math.min(h + 9, tip);
        if (top > this.tipHeight() || top < this.start) throw missing(`/blocks/${top}`);
        return linkedHashes(this.hashRows(h, tip), top);
      },
      block: async (hash, opts) => { calls.block++; const raw = this.rawBlock(hash); if (!raw) throw missing(`/block/${hash}`); return verifiedBlock(raw, hash, opts); },
      prevoutScripts: async (_hash, txid) => { calls.prevouts++; return this.prevoutScripts(txid); },
      txHex: async (txid) => { calls.txHex++; return this.txHex(txid); },
      fork: (height, blocks) => this.fork(height, blocks),
      setTip: (h) => this.setTip(h),
    };
  }
}

/**
 * The chain as an esplora API over HTTP (the subset an indexer uses): /blocks/tip/height,
 * /block-height/<h>, /blocks/<h> (the 10 blocks h, h-1, … with id and previousblockhash),
 * /block/<hash>/raw, /tx/<txid> (prevouts and status), /tx/<txid>/hex.
 * Returns { url, calls, heights (every height asked for, by /block-height or /blocks), setDelay(ms)
 * (each /block/<hash>/raw answers that much later), close() }.
 */
export async function serveEsplora(chain, { port = 0 } = {}) {
  const calls = { tip: 0, hash: 0, blocks: 0, raw: 0, tx: 0, hex: 0, other: 0 };
  const heights = [];
  let delay = 0;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    let m;
    try {
      if (p === '/blocks/tip/height') { calls.tip++; return send(200, String(chain.tipHeight())); }
      if ((m = /^\/blocks\/(\d+)$/.exec(p))) {
        calls.blocks++;
        const top = Number(m[1]);
        heights.push(top);
        if (top > chain.tipHeight() || top < chain.start) return send(404, 'Block not found');
        const rows = chain.hashRows(top, top).reverse().map(([height, id, prev]) => ({ id, height, previousblockhash: prev }));
        return send(200, JSON.stringify(rows), 'application/json');
      }
      if ((m = /^\/block-height\/(\d+)$/.exec(p))) {
        calls.hash++;
        heights.push(Number(m[1]));
        const h = chain.hashAt(Number(m[1]));
        return h ? send(200, h) : send(404, 'Block not found');
      }
      if ((m = /^\/block\/([0-9a-f]{64})\/raw$/.exec(p))) {
        calls.raw++;
        const raw = chain.rawBlock(m[1]);
        if (!raw) return send(404, 'Block not found');
        return delay ? void setTimeout(() => send(200, raw, 'application/octet-stream'), delay) : send(200, raw, 'application/octet-stream');
      }
      if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(p))) { calls.hex++; return chain.txs.has(m[1]) ? send(200, chain.txHex(m[1])) : send(404, 'Transaction not found'); }
      if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(p))) {
        calls.tx++;
        if (!chain.txs.has(m[1])) return send(404, 'Transaction not found');
        const { tx, prevouts } = chain.txs.get(m[1]);
        const height = chain.heightOf(m[1]);
        return send(200, JSON.stringify({
          txid: m[1],
          vin: tx.ins.map((i, k) => (prevouts[k]
            ? { txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index, is_coinbase: false, prevout: { scriptpubkey: hex(prevouts[k]) } }
            : { is_coinbase: true, prevout: null })),
          status: height === null ? { confirmed: false } : { confirmed: true, block_height: height, block_hash: chain.hashAt(height) },
        }), 'application/json');
      }
      calls.other++;
      return send(404, 'not found');
    } catch (e) { return send(500, e.message); }
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`, calls, heights, server, setDelay: (ms) => { delay = ms; },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}
