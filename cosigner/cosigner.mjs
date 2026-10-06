// Shielded Ordinals co-signer: the software UniSat (or anyone) runs to hold ONE of the collection's
// co-signer keys. It follows Bitcoin with its own indexer (no trust in Ord Dropz's servers) and signs
// a gate coin or listing lock only for a tx its indexer says is a valid mint, buy or seller cancel
// (src/v1/cosign.mjs). It never holds funds or pieces.
//
//   COSIGNER_KEY_FILE=~/.secrets/cosigner.json      {"priv":"<64 hex>"}  (or COSIGNER_KEY_HEX)
//   RULES_INSCRIPTION_ID=<parent id>i0              the collection (rules are read from the parent tx)
//   [RULES_FILE=rules.json]                         test collections whose rules aren't inscribed
//   START_HEIGHT=<block the collection starts at>
//   NETWORK=signet|mainnet  [MEMPOOL_API=...]  [PORT=5018]  [CACHE_DIR=.cache-cosigner]
//   node cosigner/cosigner.mjs
//
// API: POST /cosign { txHex, index, prevouts: [{ script, value }] } -> { pubkey, sig }   (or 400 + why)
//      GET  /status
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import { follower, loadRules, networkOf, defaultApi } from '../src/v1/follow.mjs';
import { cosignerKey, cosignPolicy, cosignSpendInfo, cosignSighash, signCosign, CosignMemory } from '../src/v1/cosign.mjs';
import { lockPayment } from '../src/v1/scripts.mjs';

const env = (k, d) => { const v = process.env[k]?.trim(); if (v) return v; if (d !== undefined) return d; throw new Error(`missing ${k}`); };
const NETWORK = env('NETWORK', 'signet');
const NET = networkOf(NETWORK);
const API = env('MEMPOOL_API', defaultApi(NETWORK));
const PORT = Number(env('PORT', '5018'));
const RULES_ID = env('RULES_INSCRIPTION_ID');
const START = Number(env('START_HEIGHT'));
const keyHex = process.env.COSIGNER_KEY_HEX?.trim()
  || JSON.parse(fs.readFileSync(env('COSIGNER_KEY_FILE').replace(/^~/, os.homedir()), 'utf8')).priv;
const key = cosignerKey(keyHex);
const VKEY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../zk/spend_vkey.json', import.meta.url)), 'utf8'));

const rules = await loadRules({ api: API, rulesInscriptionId: RULES_ID, rulesFile: process.env.RULES_FILE });
if (!rules.cosigners) throw new Error('this collection has no co-signers');
if (!rules.cosigners.keys.includes(key.xonlyHex)) throw new Error('this key is not one of the collection co-signers');
const chain = follower({ network: NETWORK, api: API, cacheDir: env('CACHE_DIR', '.cache-cosigner'), rulesInscriptionId: RULES_ID, rules, vkey: VKEY, startHeight: START });
const get = chain.get;

// ─── pending txs we signed: a dropped one frees its pieces / lock ────────────────────────────────
const memory = new CosignMemory();
const signed = new Map(); // txid -> signedAt
setInterval(async () => {
  for (const [txid, at] of signed) {
    if (Date.now() - at < 3 * 60_000) continue;
    try { await get(`/tx/${txid}/status`); } catch (e) {
      if (e.status === 404) { memory.forgetTx(txid); signed.delete(txid); }
    }
    if (Date.now() - at > 6 * 3600_000) signed.delete(txid);
  }
}, 60_000).unref();

// ─── HTTP ──────────────────────────────────────────────────────────────────────────────────────
const hits = new Map();
const limited = (ip) => { const now = Date.now(); const r = (hits.get(ip) ?? []).filter((t) => t > now - 60_000); r.push(now); hits.set(ip, r); return r.length > 120; };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };

async function cosign(body) {
  const ix = await chain.fresh();
  const tx = bitcoin.Transaction.fromHex(String(body.txHex));
  const index = Number(body.index);
  const prevouts = (body.prevouts ?? []).map((p) => ({ script: Buffer.from(String(p.script), 'hex'), value: Number(p.value) }));
  const policy = await cosignPolicy(ix, tx, index, prevouts, memory, NET);
  if (!policy.ok) throw new Error(policy.reason);
  const l = policy.listing ?? null; // the listing whose lock this input spends (validated by the policy)
  const info = cosignSpendInfo(rules, NET, policy.kind === 'mint' ? 'gate' : 'lock', l?.returnKey);
  if (!prevouts[index].script.equals(policy.kind === 'mint' ? info.output : lockPayment(rules, l.returnKey, NET).output)) throw new Error('prevout script mismatch');
  const sig = signCosign(key, cosignSighash(tx, index, prevouts, info.leaf));
  policy.record();
  signed.set(tx.getId(), Date.now());
  console.log(`co-signed ${policy.kind} ${tx.getId()}`);
  return { pubkey: key.xonlyHex, sig: sig.toString('hex'), kind: policy.kind };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, { collection: rules.name, rulesInscriptionId: RULES_ID, key: key.xonlyHex, cosigners: rules.cosigners, height: chain.ix()?.lastHeight ?? null, tip: chain.tip(), pending: signed.size });
  }
  if (req.method === 'POST' && req.url === '/cosign') {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'slow down' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 400_000) req.destroy(); });
    req.on('end', async () => {
      try { send(res, 200, await cosign(JSON.parse(raw))); } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, async () => {
  console.log(`co-signer for "${rules.name}" (key ${key.xonlyHex.slice(0, 12)}…, ${rules.cosigners.threshold} of ${rules.cosigners.keys.length}) on :${PORT}, ${NETWORK}`);
  await chain.sync();
  console.log(`synced to ${chain.ix()?.lastHeight}`);
  setInterval(chain.sync, 15_000).unref();
});
