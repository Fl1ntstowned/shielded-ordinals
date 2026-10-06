// Shielded Ordinals v1 — canonical envelopes. Each one is the single push of an OP_RETURN output.
//
// header   = "SHORD" | version 1 | type | cid(8)        cid = collection id (rules.mjs)
// MINT     = header | assetId u32 | ticketsBuy u16 | inner32 | epk32 | ct88
// TRANSFER = header | hanchor u32 | nf32 | cmOut32 | spend u8 | buy u16 | epk32 | ct88 | proof256
// LIST     = header | hanchor u32 | nf32 | assetId u32 | tickets u32 | spend u8 | buy u16
//                   | price u64 | returnKey32 | scriptLen u8 | sellerScript | proof256
// BUY      = header | listingNf32 | ticketsBuy u16 | inner32 | epk32 | ct88
// CLAIM    = header | listingNf32 | spend u8 | inner32 | epk32 | ct88 | sig64
// MINTN    = header | count u8 | count × (assetId u32 | ticketsBuy u16 | inner32 | epk32 | ct88)
//            batch mint: up to MAX_MINTS_PER_TX pieces in ONE OP_RETURN, one gate coin, one popup
//
// Integers are little-endian. TRANSFER/LIST proofs bind hbody = hashBody(everything before the
// proof); CLAIM's BIP340 signature is over sha256(everything before the signature).
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { fieldToBytes, bytesToField, hashBody, CT_LEN } from './core.mjs';

export const MAGIC = Buffer.from('SHORD');
export const VERSION = 1;
export const T = { TRANSFER: 1, MINT: 2, LIST: 3, BUY: 4, CLAIM: 5, MINTN: 6 };
export const MAX_MINTS_PER_TX = 20;
export const TYPE_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
const PROOF_LEN = 256;
const SIG_LEN = 64;
const HDR = 15;

const header = (type, cid) => {
  if (cid.length !== 8) throw new Error('cid must be 8 bytes');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, type]), cid]);
};
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const f = fieldToBytes;
const bytes = (b, n, what) => {
  b = Buffer.from(b);
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes`);
  return b;
};

export const encodeMint = ({ cid, assetId, ticketsBuy, inner, epk, ct }) =>
  Buffer.concat([header(T.MINT, cid), u32(assetId), u16(ticketsBuy), f(inner), bytes(epk, 32, 'epk'), bytes(ct, CT_LEN, 'ct')]);

export function encodeMintBatch({ cid, mints }) {
  if (!mints.length || mints.length > MAX_MINTS_PER_TX) throw new Error(`a batch mints 1 to ${MAX_MINTS_PER_TX} pieces`);
  return Buffer.concat([header(T.MINTN, cid), Buffer.from([mints.length]),
    ...mints.map(({ assetId, ticketsBuy, inner, epk, ct }) =>
      Buffer.concat([u32(assetId), u16(ticketsBuy), f(inner), bytes(epk, 32, 'epk'), bytes(ct, CT_LEN, 'ct')]))]);
}

export const encodeTransferBody =({ cid, hanchor, nf, cmOut, spend, buy, epk, ct }) =>
  Buffer.concat([header(T.TRANSFER, cid), u32(hanchor), f(nf), f(cmOut), Buffer.from([spend]), u16(buy),
    bytes(epk, 32, 'epk'), bytes(ct, CT_LEN, 'ct')]);

export function encodeListBody({ cid, hanchor, nf, assetId, tickets, spend, buy, price, returnKey, sellerScript }) {
  sellerScript = Buffer.from(sellerScript);
  if (sellerScript.length < 1 || sellerScript.length > 80) throw new Error('bad seller script');
  return Buffer.concat([header(T.LIST, cid), u32(hanchor), f(nf), u32(assetId), u32(tickets), Buffer.from([spend]),
    u16(buy), u64(price), bytes(returnKey, 32, 'returnKey'), Buffer.from([sellerScript.length]), sellerScript]);
}

export const encodeBuy = ({ cid, listingNf, ticketsBuy, inner, epk, ct }) =>
  Buffer.concat([header(T.BUY, cid), f(listingNf), u16(ticketsBuy), f(inner), bytes(epk, 32, 'epk'), bytes(ct, CT_LEN, 'ct')]);

export const encodeClaimBody = ({ cid, listingNf, spend, inner, epk, ct }) =>
  Buffer.concat([header(T.CLAIM, cid), f(listingNf), Buffer.from([spend]), f(inner), bytes(epk, 32, 'epk'), bytes(ct, CT_LEN, 'ct')]);
export const claimSigHash = (body) => Buffer.from(sha256(body));

// A strict reader: every read is bounds-checked, and the envelope must be consumed exactly.
class Reader {
  constructor(buf, o) { this.b = buf; this.o = o; }
  take(n) {
    if (this.o + n > this.b.length) throw new Error('truncated');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u16() { return this.take(2).readUInt16LE(0); }
  u32() { return this.take(4).readUInt32LE(0); }
  u64() { return this.take(8).readBigUInt64LE(0); }
  field() { return bytesToField(this.take(32)); }
  bin(n) { return Buffer.from(this.take(n)); }
  end() { if (this.o !== this.b.length) throw new Error('trailing bytes'); }
}

// Returns null if the bytes aren't a v1 SHORD envelope at all; throws on anything malformed.
export function parseEnvelope(buf) {
  buf = Buffer.from(buf);
  if (buf.length < HDR || !buf.subarray(0, 5).equals(MAGIC)) return null;
  if (buf[5] !== VERSION) return null; // other versions are other deployments
  const type = buf[6];
  const cid = Buffer.from(buf.subarray(7, 15));
  const r = new Reader(buf, HDR);
  let env;
  switch (type) {
    case T.MINT:
      env = { assetId: r.u32(), ticketsBuy: r.u16(), inner: r.field(), epk: r.bin(32), ct: r.bin(CT_LEN) };
      break;
    case T.MINTN: {
      const count = r.u8();
      if (count < 1 || count > MAX_MINTS_PER_TX) throw new Error('batch count');
      env = { mints: Array.from({ length: count }, () =>
        ({ assetId: r.u32(), ticketsBuy: r.u16(), inner: r.field(), epk: r.bin(32), ct: r.bin(CT_LEN) })) };
      break;
    }
    case T.TRANSFER: {
      env = { hanchor: r.u32(), nf: r.field(), cmOut: r.field(), spend: r.u8(), buy: r.u16(), epk: r.bin(32), ct: r.bin(CT_LEN) };
      env.hbody = hashBody(buf.subarray(0, r.o));
      env.proof = decodeProof(r.take(PROOF_LEN));
      break;
    }
    case T.LIST: {
      env = { hanchor: r.u32(), nf: r.field(), assetId: r.u32(), tickets: r.u32(), spend: r.u8(), buy: r.u16(),
        price: r.u64(), returnKey: r.bin(32) };
      env.sellerScript = r.bin(r.u8());
      if (env.sellerScript.length < 1) throw new Error('empty seller script');
      env.hbody = hashBody(buf.subarray(0, r.o));
      env.proof = decodeProof(r.take(PROOF_LEN));
      break;
    }
    case T.BUY:
      env = { listingNf: r.field(), ticketsBuy: r.u16(), inner: r.field(), epk: r.bin(32), ct: r.bin(CT_LEN) };
      break;
    case T.CLAIM: {
      env = { listingNf: r.field(), spend: r.u8(), inner: r.field(), epk: r.bin(32), ct: r.bin(CT_LEN) };
      env.sigHash = claimSigHash(buf.subarray(0, r.o));
      env.sig = r.bin(SIG_LEN);
      break;
    }
    default:
      throw new Error('unknown envelope type ' + type);
  }
  r.end();
  if ((env.spend ?? 0) > 1) throw new Error('spend must be 0 or 1');
  return { type, cid, ...env };
}

// Groth16 / BN254 proof: A(G1) | B(G2) | C(G1), 32-byte big-endian coordinates.
export function encodeProof(p) {
  const e = (s) => fieldToBytes(BigInt(s));
  return Buffer.concat([
    e(p.pi_a[0]), e(p.pi_a[1]),
    e(p.pi_b[0][0]), e(p.pi_b[0][1]), e(p.pi_b[1][0]), e(p.pi_b[1][1]),
    e(p.pi_c[0]), e(p.pi_c[1]),
  ]);
}
export function decodeProof(b) {
  const n = (i) => BigInt('0x' + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString('hex')).toString();
  return {
    protocol: 'groth16',
    curve: 'bn128',
    pi_a: [n(0), n(1), '1'],
    pi_b: [[n(2), n(3)], [n(4), n(5)], ['1', '0']],
    pi_c: [n(6), n(7), '1'],
  };
}
