// Shielded Ordinals v1 — the field, hashes and checks an indexer needs. Runs in Node and in the browser.
import { Buffer } from 'buffer';
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export { Buffer };
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Poseidon over BN254 with circomlib's parameters (poseidon-lite ships each width separately).
const POSEIDON = [null, poseidon1, poseidon2, poseidon3];
export async function initCrypto() {} // kept for callers; poseidon-lite needs no setup
export function poseidon(inputs) {
  const fn = POSEIDON[inputs.length];
  if (!fn) throw new Error(`poseidon width ${inputs.length} not supported`);
  return fn(inputs.map((x) => BigInt(x)));
}

export const toHex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => Buffer.from(h, 'hex');
export const fieldToBytes = (x) => fromHex(x.toString(16).padStart(64, '0'));
export function bytesToField(b) {
  const x = BigInt('0x' + toHex(b));
  if (x >= P) throw new Error('non-canonical field element');
  return x;
}

// hbody: sha256 of the proof-excluded body, top byte dropped so it always fits the field.
export function hashBody(body) {
  const h = Buffer.from(sha256(body));
  h[0] = 0;
  return BigInt('0x' + toHex(h));
}

export const tagged = (tag, ...parts) => sha256(Buffer.concat([Buffer.from(tag), ...parts.map((p) => Buffer.from(p))]));

export const schnorrVerify = (sig, msg32, xonly) => {
  try { return schnorr.verify(sig, msg32, xonly); } catch { return false; }
};

// A note's commitment (the tree leaf): the public piece and credit count over the holder's hidden
// `inner`. The indexer computes it for every note a transaction publishes.
export const noteCommitment = (assetId, tickets, inner) => poseidon([BigInt(assetId), BigInt(tickets), inner]);

// Encrypted note length: assetId u32 | tickets u32 | rho 32 | s 32 (72 B) + 16 B tag.
export const CT_LEN = 88;
