// Shielded Ordinals v1 — shielded names: "obi.naka" / "obi.shield" in place of a shielded address.
// METADATA ONLY: nothing in the protocol's acceptance rules depends on it.
//
//   A name = an ordinary ord inscription (application/json or text/plain) whose whole content is
//       {"p":"shord","op":"name","name":"obi.naka","to":"shord1…"}
//   Anyone may inscribe one, with any inscribing tool. No parent, no fee rule, no signature.
//   First is first: the EARLIEST valid inscription of a label wins, in block order, then tx order in
//   the block, then inscription order in the tx. Later ones are ignored for ever.
//   The label (the part before the dot) is unique across both endings: obi.naka blocks obi.shield.
//   The name must be written exactly as it is used: lowercase, no spaces. Anything else is not a name.
//   `to` is fixed by the inscription: moving or selling the inscription never changes where it points.
// Every indexer that replays the same blocks gets the same names. To make that checkable:
//   - names count from NAMES_START[network], a fixed block height: every indexer starts there, so a
//     name inscribed earlier can never be known to one indexer and not another;
//   - the index keeps a running digest, sha256(previous digest | height | inscription id | name | to)
//     over every accepted name in order. Two indexers at the same height with the same digest hold
//     exactly the same names. An indexer publishes { height, count, digest }; anyone can compare.
import { sha256 } from '@noble/hashes/sha2.js';

export const NAME_ENDINGS = ['naka', 'shield'];
export const NAME_MAX_BYTES = 400;
/** The first block names count from (fixed for ever; earlier inscriptions are not names). */
export const NAMES_START = { mainnet: 969800, signet: 324867 };
const GENESIS_DIGEST = Buffer.from(sha256(Buffer.from('shord-names-v1'))).toString('hex');
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,18})[a-z0-9]$/;
const ADDRESS_RE = /^shord1[0-9a-f]{128}$/;

/** Labels nobody can take (they would pass for the platform, the protocol or a wallet). */
export const RESERVED_LABELS = new Set([
  'orddropz', 'ord-dropz', 'orddrop', 'ord-drop', 'dropz', 'admin', 'administrator', 'support', 'help', 'official', 'team', 'staff',
  'mod', 'moderator', 'shielded', 'shield', 'shord', 'naka', 'nakas', 'vault', 'wallet', 'relayer', 'relay', 'treasury', 'escrow',
  'bitcoin', 'satoshi', 'nakamoto', 'null', 'undefined', 'unisat', 'xverse', 'magiceden', 'magic-eden', 'opensea',
]);

/** "Bob.NAKA" (as a person types it) -> { label, ending, full }, or null when it is not a name. */
export function parseName(input) {
  if (typeof input !== 'string') return null;
  const m = /^([^.\s]+)\.([a-z]+)$/.exec(input.trim().toLowerCase());
  if (!m || !NAME_ENDINGS.includes(m[2]) || !LABEL_RE.test(m[1]) || m[1].includes('--')) return null;
  return { label: m[1], ending: m[2], full: `${m[1]}.${m[2]}` };
}
export const isShieldedAddress = (a) => typeof a === 'string' && ADDRESS_RE.test(a);

/** The inscription content for a name. */
export function nameRecord(name, to) {
  const n = parseName(name);
  if (!n || n.full !== name) throw new Error('not a shielded name');
  if (RESERVED_LABELS.has(n.label)) throw new Error('that name is reserved');
  if (!isShieldedAddress(to)) throw new Error('not a shielded address');
  return JSON.stringify({ p: 'shord', op: 'name', name: n.full, to });
}

/** A name record read from an inscription's content, or null when it is not one. */
export function readNameRecord(contentType, body) {
  if (!/^(application\/json|text\/plain)/.test(contentType ?? '')) return null;
  if (!body || body.length > NAME_MAX_BYTES) return null;
  let j;
  try { j = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.p !== 'shord' || j.op !== 'name') return null;
  const n = parseName(j.name);
  if (!n || n.full !== j.name || RESERVED_LABELS.has(n.label) || !isShieldedAddress(j.to)) return null;
  return { name: n.full, label: n.label, to: j.to };
}

export class NameIndex {
  /** `start`: NAMES_START of the network (null = this network has no names yet). */
  constructor(start = null) {
    this.start = start;
    this.list = []; // every accepted record, in order
    this.digest = GENESIS_DIGEST;
    this.height = null; // last block applied
    this.byLabel = new Map(); // label -> { name, label, to, id, height }
    this.byAddress = new Map(); // shielded address -> [records], earliest first
  }

  /** `names`: this block's name records in tx order, then inscription order: [{ id, name, label, to }]. */
  apply(height, names) {
    this.height = height;
    if (this.start === null || height < this.start) return;
    for (const n of names ?? []) {
      if (this.byLabel.has(n.label)) continue; // first is first
      const rec = { name: n.name, label: n.label, to: n.to, id: n.id, height };
      this.list.push(rec);
      this.digest = Buffer.from(sha256(Buffer.from(`${this.digest}|${height}|${n.id}|${n.name}|${n.to}`))).toString('hex');
      this.byLabel.set(n.label, rec);
      const list = this.byAddress.get(n.to);
      if (list) list.push(rec); else this.byAddress.set(n.to, [rec]);
    }
  }

  /** The record a full name ("obi.naka") resolves to, or null. */
  resolve(full) {
    const n = parseName(full);
    const rec = n ? this.byLabel.get(n.label) : null;
    return rec && rec.name === n.full ? rec : null;
  }
  /** Is this label taken (under either ending)? */
  taken(label) { return this.byLabel.has(label); }
  /** What an indexer publishes so others can check they agree. */
  state() { return { start: this.start, height: this.height, count: this.list.length, digest: this.digest }; }
  /** Every name pointing at a shielded address, earliest first. */
  of(address) { return this.byAddress.get(address) ?? []; }
}
