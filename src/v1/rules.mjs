// Shielded Ordinals v1 — the collection rules. They live in the collection's PARENT inscription
// (content type application/json) and are fixed forever once the parent is parked at NUMS.
//
// {
//   "p": "shord", "v": 1,
//   "name": "…",
//   "supply": 1000,                        // == children.length
//   "children": ["<txid>i0", …],           // PRE-INSCRIBED mode: assetId = index in this list
//   -- or, FILE MINT mode (each piece is inscribed as a child after it's minted) --
//   "artRoot": "<64 hex>",                 // art.mjs Merkle root over every piece's file
//   "contentType": "image/jpeg",
//   "inscribeFee": 3000,                   // sats per piece -> relayerPayoutScript (pays its inscription)
//   "relayerPayoutScript": "5120…",        // optional (default: platform). Tickets + inscribe fees pay
//                                          // the wallet that spends them, so it funds itself
//   "mintPrice": 50000,                    // sats -> artistPayoutScript, every mint
//   "artistPayoutScript": "5120…",         // hex scriptPubKey, compared byte-exact
//   "platformPayoutScript": "5120…",
//   "mintFee": 3500,                       // sats -> platform, every mint (0 = waived for this collection)
//   "saleFeeBps": 250, "saleFeeMin": 1000, // platform fee on every sale: max(min, price*bps/1e4)
//   "ticketPrice": 1500,                   // sats per relay ticket
//   "gateKey": "<xonly hex>",              // platform key: every MINT must spend a P2TR(gateKey) coin
//   "lockKey": "<xonly hex>",              // platform key inside every listing lock
//   "cosigners": { "keys": ["<xonly>", "<xonly>", "<xonly>"], "threshold": 2 },
//                                          // optional, replaces gateKey/lockKey: the gate coin and the
//                                          // listing lock are spent by ANY 2 of 3 independent co-signers
//                                          // (script path; the key path is the unspendable NUMS point),
//                                          // so no single operator is needed, or trusted, to mint or sell
//   "spendVkeyHash": "<64 hex>"            // optional: sha256 of the ceremony's spend verification key.
//                                          // The indexer refuses to run with any other key, so the
//                                          // trusted-setup ceremony is pinned in the parent forever.
// }
//
// No royalties: a sale pays the seller the price and the platform its fee, nothing else.
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

// After this many blocks the seller can spend their listing lock alone (the escape hatch if the
// platform ever stops co-signing). Spending the lock closes the listing; CLAIM then returns the piece.
export const LOCK_ESCAPE_CSV = 1008;
export const MAX_SUPPLY = 65536;
export const DEPTH = 20; // note tree depth (must match the circuits)
export const ANCHOR_WINDOW = 100; // W: a proof may anchor on any of the last 100 roots
export const K_MIN = 1;
export const MAX_TICKETS_PER_BUY = 100;
// A holder proof must use one of the last few roots. The proof doesn't reveal the note's nullifier
// (that would let the verifier spot the piece when it later moves), so freshness is what stops a
// note spent long ago from being used.
export const HOLDER_ROOT_WINDOW = 6;

export const dustFor = (script) => {
  // witness v1 (P2TR) and v0 have lower dust limits than legacy scripts
  if (script.length === 34 && script[0] === 0x51) return 330;
  if (script[0] === 0x00) return 294;
  return 546;
};

const isHex = (s, bytes) => typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (!bytes || s.length === bytes * 2);
const posInt = (n) => Number.isSafeInteger(n) && n > 0;

export function parseRules(content) {
  const r = typeof content === 'string' ? JSON.parse(content) : content;
  const bad = (m) => { throw new Error('rules: ' + m); };
  if (r.p !== 'shord' || r.v !== 1) bad('not shord v1');
  if (typeof r.name !== 'string' || !r.name.length || r.name.length > 64) bad('name');
  if (!posInt(r.supply) || r.supply > MAX_SUPPLY) bad('supply');
  const fileMint = r.artRoot !== undefined;
  if (fileMint) {
    if (r.children !== undefined) bad('use children OR artRoot, not both');
    if (!isHex(r.artRoot, 32)) bad('artRoot');
    if (typeof r.contentType !== 'string' || !r.contentType.length || r.contentType.length > 64) bad('contentType');
  } else {
    if (!Array.isArray(r.children) || r.children.length !== r.supply) bad('children must list every piece');
    if (!r.children.every((c) => /^[0-9a-f]{64}i\d+$/.test(c))) bad('child id');
    if (new Set(r.children).size !== r.children.length) bad('duplicate child');
  }
  if (r.spendVkeyHash !== undefined && !isHex(r.spendVkeyHash, 32)) bad('spendVkeyHash');
  const inscribeFee = r.inscribeFee ?? 0;
  if (!Number.isSafeInteger(inscribeFee) || inscribeFee < 0) bad('inscribeFee');
  if (inscribeFee > 0 && !fileMint) bad('inscribeFee is for file-mint collections');
  for (const k of ['artistPayoutScript', 'platformPayoutScript']) if (!isHex(r[k]) || r[k].length < 4 || r[k].length > 160) bad(k);
  if (r.relayerPayoutScript !== undefined && (!isHex(r.relayerPayoutScript) || r.relayerPayoutScript.length < 4 || r.relayerPayoutScript.length > 160)) bad('relayerPayoutScript');
  if (r.cosigners !== undefined) {
    const c = r.cosigners;
    if (!c || !Array.isArray(c.keys) || c.keys.length < 2 || c.keys.length > 5 || !c.keys.every((k) => isHex(k, 32)) || new Set(c.keys).size !== c.keys.length) bad('cosigners.keys');
    if (!Number.isInteger(c.threshold) || c.threshold < 1 || c.threshold > c.keys.length) bad('cosigners.threshold');
  } else {
    for (const k of ['gateKey', 'lockKey']) if (!isHex(r[k], 32)) bad(k);
  }
  for (const k of ['mintPrice', 'saleFeeMin', 'ticketPrice']) if (!posInt(r[k])) bad(k);
  if (!Number.isSafeInteger(r.mintFee) || r.mintFee < 0) bad('mintFee');
  if (!Number.isInteger(r.saleFeeBps) || r.saleFeeBps < 0 || r.saleFeeBps > 5000) bad('saleFeeBps');
  const artist = Buffer.from(r.artistPayoutScript, 'hex');
  const platform = Buffer.from(r.platformPayoutScript, 'hex');
  if (r.mintPrice < dustFor(artist)) bad('mintPrice below dust');
  if ((r.mintFee > 0 && r.mintFee < dustFor(platform)) || r.saleFeeMin < dustFor(platform)) bad('platform fee below dust');
  const relayer = r.relayerPayoutScript ? Buffer.from(r.relayerPayoutScript, 'hex') : platform;
  if (inscribeFee > 0 && inscribeFee < dustFor(relayer)) bad('inscribeFee below dust');
  return Object.freeze({ ...r, fileMint, inscribeFee, artistScript: artist, platformScript: platform, relayerScript: relayer });
}

// sha256 of a verification key's canonical JSON (the ceremony tool prints the same hash)
export const vkeyHash = (vkey) => Buffer.from(sha256(Buffer.from(JSON.stringify(vkey)))).toString('hex');

// Collection id carried in every envelope: first 8 bytes of sha256(parent inscription id).
export const collectionId = (rulesInscriptionId) => Buffer.from(sha256(Buffer.from(rulesInscriptionId))).subarray(0, 8);

export const saleFee = (rules, price) => {
  const pct = (BigInt(price) * BigInt(rules.saleFeeBps)) / 10000n;
  return pct > BigInt(rules.saleFeeMin) ? pct : BigInt(rules.saleFeeMin);
};
