// v1 public state: what an indexer serves (exportState).
// Everything here is already public on-chain. The wallet downloads ALL notes and scans them
// locally, so the server never learns which notes (or which Merkle paths) belong to whom.
//
import { Buffer, toHex, fromHex } from './core.mjs';
import { ANCHOR_WINDOW } from './rules.mjs';

export const STATE_VERSION = 1;

const listingOut = (l) => ({
  nf: String(l.nf), assetId: l.assetId, tickets: l.tickets, price: String(l.price),
  sellerScript: toHex(l.sellerScript), returnKey: toHex(l.returnKey),
  lock: l.lock, state: l.state, height: l.height,
  soldTxid: l.soldTxid ?? null, closedTxid: l.closedTxid ?? null, claimTxid: l.claimTxid ?? null,
});

// Anchors are only valid for the last ANCHOR_WINDOW blocks, so only those roots/counts are served.
export function exportState(ix, { sinceNote = 0 } = {}) {
  const heights = [...ix.roots.keys()].filter((h) => h > ix.lastHeight - ANCHOR_WINDOW - 1);
  return {
    v: STATE_VERSION,
    rulesInscriptionId: ix.rulesInscriptionId,
    cid: toHex(ix.cid),
    lastHeight: ix.lastHeight,
    noteCount: ix.notes.length,
    sinceNote,
    notes: ix.notes.slice(sinceNote).map((n) => ({
      pos: n.pos, cm: String(n.cm), epk: toHex(n.epk), ct: toHex(n.ct), txid: n.txid, height: n.height, kind: n.kind,
    })),
    roots: heights.map((h) => [h, String(ix.roots.get(h)), ix.leafCounts.get(h)]),
    nullifiers: [...ix.nullifiers].map(String),
    listings: [...ix.listings.values()].map(listingOut),
    minted: [...ix.minted.keys()],
  };
}
