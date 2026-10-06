// Shielded Ordinals v1 — the art commitment for "file mint" collections.
//
// The parent's rules carry artRoot: a Merkle root over every piece's file, so the art is fixed at
// launch even though each piece is only inscribed (as a child of the parent) after it's minted.
//   leaf(i)  = sha256(0x00 | u32le i | sha256(file_i))
//   node     = sha256(0x01 | left | right); an odd node at the end of a level is carried up as-is
// Anyone holding the published file list can recompute the root; any child inscription proves which
// piece it is by its content hash + a Merkle path.
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

const H = (...parts) => Buffer.from(sha256(Buffer.concat(parts.map((p) => Buffer.from(p)))));
export const fileHash = (bytes) => H(bytes);

export function artLeaf(assetId, contentHash) {
  const i = Buffer.alloc(4);
  i.writeUInt32LE(assetId);
  return H(Buffer.from([0]), i, contentHash);
}
const node = (l, r) => H(Buffer.from([1]), l, r);

function levels(contentHashes) {
  if (!contentHashes.length) throw new Error('no art');
  const out = [contentHashes.map((h, i) => artLeaf(i, Buffer.from(h)))];
  while (out[out.length - 1].length > 1) {
    const cur = out[out.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? node(cur[i], cur[i + 1]) : cur[i]);
    out.push(next);
  }
  return out;
}

export const artRoot = (contentHashes) => levels(contentHashes).at(-1)[0];

/** Path for piece i: sibling hashes bottom-up; null where the node was carried up alone. */
export function artProof(contentHashes, i) {
  const proof = [];
  for (const level of levels(contentHashes).slice(0, -1)) {
    const sib = i ^ 1;
    proof.push(sib < level.length ? level[sib] : null);
    i >>= 1;
  }
  return proof;
}

export function verifyArt(root, assetId, contentHash, proof) {
  let h = artLeaf(assetId, Buffer.from(contentHash));
  let i = assetId;
  for (const sib of proof) {
    if (sib) h = i & 1 ? node(Buffer.from(sib), h) : node(h, Buffer.from(sib));
    i >>= 1;
  }
  return h.equals(Buffer.from(root));
}
