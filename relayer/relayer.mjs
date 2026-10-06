// Shielded Ordinals relayer anyone can run. It follows Bitcoin with its own indexer, accepts relayed
// actions (private sends, listings, claims of cancelled listings), checks each one would be accepted,
// and publishes them from ITS OWN wallet in private batches: one tx per window, random order, at a
// random moment, so the chain can't match an action to when it was submitted.
//
// It can't change or steal anything: every envelope is bound by a ZK proof (or the seller's signature),
// so a relayer can only publish it as-is, delay it, or drop it, and the user can always go elsewhere
// or publish it themselves. Relay credits are paid to the collection's relayer address at mint time,
// so an independent relayer is paying the miner fee itself (a community service, or your own users).
//
//   RELAYER_KEY_FILE=~/.secrets/relayer.json   {"priv":"<64 hex>"}  (or RELAYER_KEY_HEX)
//   RULES_INSCRIPTION_ID=<parent>i0  [RULES_FILE=...]  START_HEIGHT=<block>
//   NETWORK=signet|mainnet  [MEMPOOL_API]  [PORT=5020]  [BATCH_MS=600000]  [MAX_BATCH=40]  [STATE_FILE]
//   node relayer/relayer.mjs
//
// API (same shape as Ord Dropz's relayer, so the site can point at any relayer):
//   POST /relay { envelopeHex } -> { id, state: 'queued', eta, batchSize }
//   GET  /relay/:id             -> { id, state: 'queued'|'sent'|'failed', txid, error, eta, batchSize }
//   GET  /status
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { follower, loadRules, networkOf, defaultApi } from '../src/v1/follow.mjs';
import { parseEnvelope, T } from '../src/v1/envelope.mjs';
import { lockScript } from '../src/v1/scripts.mjs';

bitcoin.initEccLib(ecc);
const env = (k, d) => { const v = process.env[k]?.trim(); if (v) return v; if (d !== undefined) return d; throw new Error(`missing ${k}`); };
const NETWORK = env('NETWORK', 'signet');
const NET = networkOf(NETWORK);
const API = env('MEMPOOL_API', defaultApi(NETWORK));
const PORT = Number(env('PORT', '5020'));
const RULES_ID = env('RULES_INSCRIPTION_ID');
const BATCH_MS = Number(env('BATCH_MS', NETWORK === 'mainnet' ? '600000' : '120000'));
const MAX_BATCH = Number(env('MAX_BATCH', '40'));
const STATE_FILE = env('STATE_FILE', '.relayer-state.json');
const VKEY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../zk/spend_vkey.json', import.meta.url)), 'utf8'));

// ─── wallet (P2TR key path) ────────────────────────────────────────────────────────────────────
const priv = Buffer.from(process.env.RELAYER_KEY_HEX?.trim() || JSON.parse(fs.readFileSync(env('RELAYER_KEY_FILE').replace(/^~/, os.homedir()), 'utf8')).priv, 'hex');
const pub = Buffer.from(ecc.pointFromScalar(priv, true));
const xonly = pub.subarray(1);
const wallet = bitcoin.payments.p2tr({ internalPubkey: xonly, network: NET });
const tweaked = Buffer.from(ecc.privateAdd(pub[0] === 3 ? Buffer.from(ecc.privateNegate(priv)) : priv, bitcoin.crypto.taggedHash('TapTweak', xonly)));

const rules = await loadRules({ api: API, rulesInscriptionId: RULES_ID, rulesFile: process.env.RULES_FILE });
const chain = follower({ network: NETWORK, api: API, cacheDir: env('CACHE_DIR', '.cache-relayer'), rulesInscriptionId: RULES_ID, rules, vkey: VKEY, startHeight: Number(env('START_HEIGHT')) });

// ─── queue (persisted: a restart never loses an action or pays for one twice) ────────────────────
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { queue: [], keys: {} }; } })();
const save = () => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
const pendingKeys = (except) => new Set(Object.keys(state.keys).filter((k) => k !== except).map(BigInt));
const keyOf = (env) => String(env.type === T.CLAIM ? env.listingNf : env.nf);
let nextFlushAt = 0;
const status = (q) => {
  const waiting = state.queue.filter((x) => x.state === 'queued').length;
  return { id: q.id, state: q.state, txid: q.txid ?? null, error: q.error ?? null, eta: q.state === 'queued' ? nextFlushAt : null, batchSize: q.state === 'queued' ? waiting : null };
};

let serial = Promise.resolve();
const inOrder = (fn) => { const run = serial.then(fn, fn); serial = run.catch(() => {}); return run; };

const relay = (envelopeHex) => inOrder(async () => {
  const data = Buffer.from(String(envelopeHex), 'hex');
  const env = parseEnvelope(data);
  if (!env) throw new Error('not a shielded ordinals envelope');
  const ix = await chain.fresh();
  const check = await ix.checkRelay(env, ix.lastHeight + 1, pendingKeys());
  if (!check.ok) throw new Error(check.reason);
  const q = { id: crypto.randomUUID(), envelopeHex: data.toString('hex'), key: keyOf(env), at: Date.now(), state: 'queued' };
  state.queue.push(q);
  state.keys[q.key] = `queued:${q.id}`;
  save();
  return status(q);
});

const flush = () => inOrder(async () => {
  const items = state.queue.filter((q) => q.state === 'queued').slice(0, MAX_BATCH);
  if (!items.length) return;
  const ix = await chain.fresh();
  const ok = [];
  for (const q of items) {
    const env = parseEnvelope(Buffer.from(q.envelopeHex, 'hex'));
    const check = await ix.checkRelay(env, ix.lastHeight + 1, pendingKeys(q.key));
    if (check.ok) ok.push({ q, env }); else { q.state = 'failed'; q.error = check.reason; delete state.keys[q.key]; }
  }
  if (ok.length) {
    for (let i = ok.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ok[i], ok[j]] = [ok[j], ok[i]]; }
    const outputs = ok.flatMap(({ q, env }) => [
      { script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(q.envelopeHex, 'hex')]), value: 0 },
      ...(env.type === T.LIST ? [{ script: lockScript(rules, env.returnKey, NET), value: 330 }] : []),
    ]);
    try {
      const txid = await publish(outputs);
      for (const { q } of ok) { q.state = 'sent'; q.txid = txid; state.keys[q.key] = txid; }
      console.log(`published batch of ${ok.length}: ${txid}`);
    } catch (e) {
      for (const { q } of ok) { q.tries = (q.tries ?? 0) + 1; if (q.tries >= 3) { q.state = 'failed'; q.error = 'could not publish'; delete state.keys[q.key]; } }
      console.warn('batch refused:', e.message);
    }
  }
  save();
});

async function publish(outputs) {
  const fees = await chain.get('/v1/fees/recommended');
  const rate = Math.min(Math.max(Number(fees.fastestFee) + 1, 1.1), 500);
  const coins = (await chain.get(`/address/${wallet.address}/utxo`)).sort((a, b) => b.value - a.value);
  const outflow = outputs.reduce((s, o) => s + o.value, 0);
  for (let n = 1; n <= Math.min(coins.length, 20); n++) {
    const own = coins.slice(0, n);
    const make = (fee) => {
      const tx = new bitcoin.Transaction(); tx.version = 2;
      for (const c of own) tx.addInput(Buffer.from(c.txid, 'hex').reverse(), c.vout, 0xfffffffd);
      for (const o of outputs) tx.addOutput(o.script, o.value);
      const change = own.reduce((s, c) => s + c.value, 0) - outflow - fee;
      if (change < 330) return null;
      tx.addOutput(wallet.output, change);
      own.forEach((c, i) => {
        const h = tx.hashForWitnessV1(i, own.map(() => wallet.output), own.map((x) => x.value), bitcoin.Transaction.SIGHASH_DEFAULT);
        tx.setWitness(i, [Buffer.from(ecc.signSchnorr(h, tweaked))]);
      });
      return tx;
    };
    const dry = make(0);
    if (!dry) continue;
    const tx = make(Math.ceil(dry.virtualSize() * rate));
    if (!tx) continue;
    const r = await fetch(API + '/tx', { method: 'POST', body: tx.toHex() });
    const t = await r.text();
    if (!r.ok) throw new Error(t.slice(0, 200));
    return t.trim();
  }
  throw new Error('relayer wallet too small');
}

function schedule() {
  if (BATCH_MS <= 0) return;
  const delay = Math.floor(BATCH_MS * (0.5 + Math.random()));
  nextFlushAt = Date.now() + delay;
  setTimeout(() => flush().catch((e) => console.warn(e.message)).finally(schedule), delay).unref();
}

// forget keys once their nullifier is on-chain (or the claim landed); drop old history
setInterval(() => {
  const ix = chain.ix();
  if (!ix) return;
  for (const k of Object.keys(state.keys)) {
    if (state.keys[k].startsWith('queued:')) continue;
    const l = ix.listings.get(BigInt(k));
    if (ix.nullifiers.has(BigInt(k)) || l?.state === 'CLAIMED') delete state.keys[k];
  }
  state.queue = state.queue.filter((q) => q.state === 'queued' || q.at > Date.now() - 86400_000);
  save();
}, 60_000).unref();

// ─── HTTP ──────────────────────────────────────────────────────────────────────────────────────
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, { collection: rules.name, address: wallet.address, height: chain.ix()?.lastHeight ?? null, queued: state.queue.filter((q) => q.state === 'queued').length, batchWindowMs: BATCH_MS, nextBatchAt: nextFlushAt });
  }
  const m = req.url?.match(/^\/relay\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && m) {
    const q = state.queue.find((x) => x.id === m[1]);
    return q ? send(res, 200, status(q)) : send(res, 404, { error: 'unknown relay id' });
  }
  if (req.method === 'POST' && req.url === '/relay') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
    req.on('end', async () => { try { send(res, 200, await relay(JSON.parse(raw).envelopeHex)); } catch (e) { send(res, 400, { error: e.message }); } });
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, async () => {
  console.log(`relayer for "${rules.name}" on :${PORT} (${NETWORK}); wallet ${wallet.address}; batches every ~${Math.round(BATCH_MS / 1000)} s`);
  await chain.sync();
  console.log(`synced to ${chain.ix()?.lastHeight}`);
  setInterval(chain.sync, 15_000).unref();
  schedule();
});
