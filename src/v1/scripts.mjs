// v1 Bitcoin scripts for the mint gate and listing locks (Node / backend only: bitcoinjs + tiny-secp256k1).
//
// Two custody-free modes, chosen by the collection's rules:
//  - single platform key (rules.gateKey / rules.lockKey): P2TR key path.
//  - co-signers (rules.cosigners = { keys: [A, B, C], threshold: 2 }): the key path is the provably
//    unspendable BIP341 NUMS point, and the only spend is the script leaf
//      <A> CHECKSIG <B> CHECKSIGADD <C> CHECKSIGADD <2> NUMEQUAL
//    so any 2 of the 3 independent co-signers (e.g. Ord Dropz, UniSat, a third party) can co-sign,
//    and none alone can. Each co-signer runs its own indexer and signs only valid mints / sales /
//    cancels (cosign.mjs), so the co-signers are for liveness and double-sale safety, never custody.
// Either way a listing lock also has the seller's escape leaf "<1008> CSV DROP <returnKey> CHECKSIG".
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { Buffer } from 'buffer';
import { LOCK_ESCAPE_CSV } from './rules.mjs';

bitcoin.initEccLib(ecc);

// BIP341's H: a point with no known private key ("nothing up my sleeve")
export const NUMS_X = Buffer.from('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', 'hex');

/** k-of-n co-signer leaf (BIP342 CHECKSIGADD). */
export function cosignLeaf(c) {
  const parts = [];
  c.keys.forEach((k, i) => parts.push(Buffer.from(k, 'hex'), i === 0 ? bitcoin.opcodes.OP_CHECKSIG : bitcoin.opcodes.OP_CHECKSIGADD));
  parts.push(bitcoin.opcodes.OP_1 + c.threshold - 1, bitcoin.opcodes.OP_NUMEQUAL);
  return bitcoin.script.compile(parts);
}

export function gatePayment(rules, network) {
  if (!rules.cosigners) return bitcoin.payments.p2tr({ internalPubkey: Buffer.from(rules.gateKey, 'hex'), network });
  const leaf = cosignLeaf(rules.cosigners);
  return bitcoin.payments.p2tr({ internalPubkey: NUMS_X, scriptTree: { output: leaf }, redeem: { output: leaf, redeemVersion: 0xc0 }, network });
}
export const gateScript = (rules, network) => gatePayment(rules, network).output;

// Listing lock: key path = platform lockKey (co-signs buys, cancels) or NUMS in co-signer mode, plus
// the seller's escape leaf "<1008> CSV DROP <returnKey> CHECKSIG" so the seller can always get out.
export function lockLeaf(returnKey) {
  return bitcoin.script.compile([
    bitcoin.script.number.encode(LOCK_ESCAPE_CSV),
    bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_DROP,
    Buffer.from(returnKey),
    bitcoin.opcodes.OP_CHECKSIG,
  ]);
}
/** `spend`: which leaf the payment's witness is for ('escape' by default, or 'cosign'). */
export function lockPayment(rules, returnKey, network, spend = 'escape') {
  const escape = lockLeaf(returnKey);
  if (!rules.cosigners) {
    return bitcoin.payments.p2tr({
      internalPubkey: Buffer.from(rules.lockKey, 'hex'),
      scriptTree: { output: escape },
      redeem: { output: escape, redeemVersion: 0xc0 },
      network,
    });
  }
  const co = cosignLeaf(rules.cosigners);
  return bitcoin.payments.p2tr({
    internalPubkey: NUMS_X,
    scriptTree: [{ output: escape }, { output: co }],
    redeem: { output: spend === 'cosign' ? co : escape, redeemVersion: 0xc0 },
    network,
  });
}
export const lockScript = (rules, returnKey, network) => lockPayment(rules, returnKey, network).output;
