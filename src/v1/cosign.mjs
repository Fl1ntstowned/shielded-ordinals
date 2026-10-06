// Shielded Ordinals v1 — k-of-n co-signing of mint gates and listing locks (Node only).
//
// A co-signer signs ONE input (a gate coin or a listing lock) of a tx someone else built, and only if
// its OWN indexer says the tx is valid right now:
//   gate coin  -> the tx carries exactly one paid MINT / MINTN that would be accepted, with every
//                 piece still unminted (none skipped), and none of those pieces is in another tx this
//                 co-signer already signed and that hasn't been mined or dropped yet.
//   lock       -> the tx carries a valid BUY of that listing, or the seller's valid CLAIM (cancel).
// That memory is what stops a piece being sold twice in the mempool: any two co-signer quorums share
// at least one member (2 of 3), and that member refuses the second tx.
// Co-signers never hold anything: the worst a colluding quorum can do is refuse (liveness) or co-sign
// a cancel the seller signed. The seller's escape leaf still works after 1008 blocks without anyone.
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { gateScript, gatePayment, lockPayment } from './scripts.mjs';
import { outpointKey } from './indexer.mjs';

bitcoin.initEccLib(ecc);

const LEAF_VERSION = 0xc0;
const compactSize = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
export const tapleafHash = (leaf) => bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([Buffer.from([LEAF_VERSION]), compactSize(leaf.length), leaf]));

/** The leaf + control block to spend a gate coin / lock through the co-signer leaf. */
export function cosignSpendInfo(rules, network, kind, returnKey) {
  const pay = kind === 'gate' ? gatePayment(rules, network) : lockPayment(rules, returnKey, network, 'cosign');
  const [leaf, control] = pay.witness;
  return { leaf: Buffer.from(leaf), control: Buffer.from(control), output: Buffer.from(pay.output) };
}

/** BIP341 script-path sighash (SIGHASH_DEFAULT: commits to every input and output). */
export function cosignSighash(tx, index, prevouts, leaf) {
  return tx.hashForWitnessV1(index, prevouts.map((p) => Buffer.from(p.script)), prevouts.map((p) => Number(p.value)),
    bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash(leaf));
}

export function cosignerKey(privHex) {
  const priv = Buffer.from(privHex, 'hex');
  const xonly = Buffer.from(ecc.pointFromScalar(priv, true)).subarray(1);
  return { priv, xonly, xonlyHex: xonly.toString('hex') };
}
export const signCosign = (key, sighash) => Buffer.from(ecc.signSchnorr(sighash, key.priv));
export const verifyCosign = (xonly, sighash, sig) => { try { return ecc.verifySchnorr(sighash, Buffer.from(xonly), Buffer.from(sig)); } catch { return false; } };

/** Witness: one slot per key (script consumes the FIRST key first, so it sits on top), then leaf + control. */
export function cosignWitness(rules, sigsByKey, info) {
  const slots = rules.cosigners.keys.map((k) => sigsByKey.get(k) ?? Buffer.alloc(0)).reverse();
  const have = slots.filter((s) => s.length).length;
  if (have < rules.cosigners.threshold) throw new Error(`only ${have} of ${rules.cosigners.threshold} co-signatures`);
  return [...slots, info.leaf, info.control];
}

// ─── the policy every co-signer applies ─────────────────────────────────────────────────────────

const toIndexerTx = (tx, prevouts) => ({
  txid: tx.getId(),
  ins: tx.ins.map((i, n) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index, script: Buffer.from(prevouts[n].script) })),
  outs: tx.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value })),
});

/** In-memory record of what this co-signer signed and is still pending. */
export class CosignMemory {
  constructor() { this.pieces = new Map(); this.locks = new Map(); } // assetId / lock outpoint -> { txid, at }
  prune(ix, maxAgeMs = 6 * 3600_000) {
    const old = Date.now() - maxAgeMs;
    for (const [a, v] of this.pieces) if (ix.minted.has(a) || v.at < old) this.pieces.delete(a);
    for (const [k, v] of this.locks) if (!ix.lockIndex.has(k) || v.at < old) this.locks.delete(k);
  }
  /** a mint or a sale that was dropped (e.g. the buyer double-spent their own input) frees its pieces */
  forgetTx(txid) {
    for (const [a, v] of this.pieces) if (v.txid === txid) this.pieces.delete(a);
    for (const [k, v] of this.locks) if (v.txid === txid) this.locks.delete(k);
  }
}

/**
 * Should this co-signer sign input `index` of `tx`? prevouts: [{ script, value }] for EVERY input
 * (the sighash commits to them, so wrong ones only produce a useless signature).
 * Returns { ok, reason?, kind: 'mint'|'buy'|'cancel', record() } — call record() once you've signed.
 */
export async function cosignPolicy(ix, tx, index, prevouts, memory, network) {
  if (!ix.rules.cosigners) return { ok: false, reason: 'this collection has no co-signers' };
  if (!(index >= 0 && index < tx.ins.length) || prevouts.length !== tx.ins.length) return { ok: false, reason: 'bad input index or prevouts' };
  memory.prune(ix);
  const itx = toIndexerTx(tx, prevouts);
  const spent = itx.ins[index];
  const txid = itx.txid;

  if (Buffer.from(spent.script).equals(gateScript(ix.rules, network))) {
    const r = await ix.wouldAccept(itx);
    const mints = r.envelopes.filter((e) => e.type === 'MINT' || e.type === 'MINTN');
    if (r.paid !== 1 || mints.length !== 1) return { ok: false, reason: 'a gate coin co-signs exactly one mint' };
    const m = mints[0];
    if (!m.ok) return { ok: false, reason: 'mint would be rejected: ' + m.reason };
    if (m.info.skipped?.length) return { ok: false, reason: `pieces already minted: ${m.info.skipped.join(',')}` };
    const busy = m.info.assetIds.filter((a) => memory.pieces.has(a) && memory.pieces.get(a).txid !== txid);
    if (busy.length) return { ok: false, reason: `pieces ${busy.join(',')} are in another pending mint` };
    return { ok: true, kind: 'mint', record: () => { for (const a of m.info.assetIds) memory.pieces.set(a, { txid, at: Date.now() }); } };
  }

  const key = outpointKey(spent.txid, spent.vout);
  const nf = ix.lockIndex.get(key);
  if (nf === undefined) return { ok: false, reason: 'input is neither a gate coin nor an active listing lock' };
  const l = ix.listings.get(nf);
  if (!Buffer.from(spent.script).equals(lockPayment(ix.rules, l.returnKey, network).output)) return { ok: false, reason: 'lock script mismatch' };
  const r = await ix.wouldAccept(itx);
  const buy = r.envelopes.find((e) => e.type === 'BUY' && e.ok && e.info.listingNf === nf);
  const claim = r.envelopes.find((e) => e.type === 'CLAIM' && e.ok && e.info.listingNf === nf);
  if (!buy && !claim) {
    const why = r.envelopes.find((e) => (e.type === 'BUY' || e.type === 'CLAIM') && !e.ok);
    return { ok: false, reason: why ? `${why.type} would be rejected: ${why.reason}` : 'a lock co-signs only a valid buy or the seller\'s cancel' };
  }
  const prev = memory.locks.get(key);
  if (prev && prev.txid !== txid) return { ok: false, reason: 'this listing is already being bought or cancelled' };
  return { ok: true, kind: buy ? 'buy' : 'cancel', listing: l, record: () => memory.locks.set(key, { txid, at: Date.now() }) };
}
