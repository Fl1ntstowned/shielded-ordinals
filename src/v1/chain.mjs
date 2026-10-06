// v1 signet I/O: taproot key-path signers, multi-input carrier txs, block fetch for replay.
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { envelopesOf } from './indexer.mjs';

bitcoin.initEccLib(ecc);
export const NETWORK = bitcoin.networks.testnet; // signet shares testnet params
export const API = process.env.MEMPOOL_API ?? 'https://mempool.space/signet/api';
const CACHE = fileURLToPath(new URL('../../.cache/signet-v1/', import.meta.url));

// A P2TR key-path signer. merkleRoot is set for outputs that also have a script tree (listing locks).
export function keyPathSigner(privHex, merkleRoot) {
  const priv = Buffer.from(privHex, 'hex');
  const pub = Buffer.from(ecc.pointFromScalar(priv, true));
  const xonly = pub.subarray(1);
  const evenPriv = pub[0] === 3 ? Buffer.from(ecc.privateNegate(priv)) : priv;
  const tweak = bitcoin.crypto.taggedHash('TapTweak', merkleRoot ? Buffer.concat([xonly, merkleRoot]) : xonly);
  const tweaked = Buffer.from(ecc.privateAdd(evenPriv, tweak));
  const outputKey = Buffer.from(ecc.pointFromScalar(tweaked, true)).subarray(1);
  return {
    xonly,
    merkleRoot,
    output: bitcoin.script.compile([bitcoin.opcodes.OP_1, outputKey]),
    sign: (psbt, i) => psbt.signInput(i, {
      publicKey: Buffer.concat([Buffer.from([2]), outputKey]),
      signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, tweaked)),
    }),
  };
}
export const xonlyOf = (privHex) => Buffer.from(ecc.pointFromScalar(Buffer.from(privHex, 'hex'), true)).subarray(1);
export const addressOf = (script) => bitcoin.address.fromOutputScript(script, NETWORK);

async function get(path, as = 'json') {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path);
    if (r.ok) return as === 'json' ? r.json() : as === 'text' ? r.text() : Buffer.from(await r.arrayBuffer());
    if (r.status === 429 && attempt < 5) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
    throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }
}
export const tipHeight = async () => Number(await get('/blocks/tip/height', 'text'));
export const getUtxos = (addr) => get(`/address/${addr}/utxo`);
export const txStatus = (txid) => get(`/tx/${txid}/status`);

export async function broadcast(hex) {
  const r = await fetch(API + '/tx', { method: 'POST', body: hex });
  const t = await r.text();
  if (!r.ok) throw new Error('broadcast rejected: ' + t);
  return t;
}

export const opReturn = (data) => bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]);

// inputs: [{ txid, vout, value, script, signer }]; outputs: [{ script, value }].
// Change (if above dust) goes to changeScript; the fee is sized from a signed dry run.
export function buildTx({ inputs, outputs, changeScript, feeRate }) {
  const make = (fee) => {
    const psbt = new bitcoin.Psbt({ network: NETWORK });
    for (const i of inputs) {
      psbt.addInput({
        hash: i.txid, index: i.vout, witnessUtxo: { script: i.script, value: i.value }, sequence: 0xfffffffd,
        tapInternalKey: i.signer.xonly, ...(i.signer.merkleRoot ? { tapMerkleRoot: i.signer.merkleRoot } : {}),
      });
    }
    for (const o of outputs) psbt.addOutput({ script: o.script, value: o.value });
    const change = inputs.reduce((a, i) => a + i.value, 0) - outputs.reduce((a, o) => a + o.value, 0) - fee;
    if (change < 0) throw new Error(`inputs short by ${-change} sats`);
    if (change >= 330) psbt.addOutput({ script: changeScript, value: change });
    inputs.forEach((i, n) => i.signer.sign(psbt, n));
    psbt.finalizeAllInputs();
    return psbt.extractTransaction();
  };
  const vsize = make(0).virtualSize() + 43; // + room for the change output
  const fee = Math.ceil(vsize * feeRate);
  const tx = make(fee);
  return { tx, hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize(), fee };
}

// Block -> indexer txs. Every tx keeps its spent outpoints (lock-spend detection); SHORD carriers
// also get their outputs and the scriptPubKeys of the coins they spend (mint-gate rule).
export async function fetchBlock(height) {
  mkdirSync(CACHE, { recursive: true });
  const file = CACHE + height + '.json';
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'), revive);
  const hash = await get(`/block-height/${height}`, 'text');
  const block = bitcoin.Block.fromBuffer(await get(`/block/${hash}/raw`, 'buf'));
  const txs = [];
  for (const t of block.transactions) {
    const txid = t.getId();
    const outs = t.outs.map((o) => ({ script: o.script, value: o.value }));
    const ins = t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index }));
    if (envelopesOf({ outs }).length) {
      const full = await get(`/tx/${txid}`);
      full.vin.forEach((v, n) => { if (v.prevout) ins[n].script = Buffer.from(v.prevout.scriptpubkey, 'hex'); });
      txs.push({ txid, ins, outs });
    } else {
      txs.push({ txid, ins, outs: [] });
    }
  }
  writeFileSync(file, JSON.stringify(txs, (k, v) => (v?.type === 'Buffer' ? { hex: Buffer.from(v.data).toString('hex') } : v)));
  return txs;
}
const revive = (k, v) => (v && typeof v === 'object' && typeof v.hex === 'string' && Object.keys(v).length === 1 ? Buffer.from(v.hex, 'hex') : v);
