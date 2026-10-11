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
//   - the list can be read in pages (page()), each with the running digest before its first name, so
//     a reader recomputes the chain from NAMES_GENESIS page by page and ends on the published digest.
import { sha256 } from '@noble/hashes/sha2.js';

export const NAME_ENDINGS = ['naka', 'shield'];
export const NAME_MAX_BYTES = 400;
/** The first block names count from (fixed for ever; earlier inscriptions are not names). */
export const NAMES_START = { mainnet: 969800, signet: 324867 };
const GENESIS_DIGEST = Buffer.from(sha256(Buffer.from('shord-names-v1'))).toString('hex');
/** The running digest before the first name: sha256('shord-names-v1'), hex. */
export const NAMES_GENESIS = GENESIS_DIGEST;
/** One link of the running digest: the digest after `rec` ({ height, id, name, to }) when `prev` came before it. */
export const nextNamesDigest = (prev, rec) => Buffer.from(sha256(Buffer.from(`${prev}|${rec.height}|${rec.id}|${rec.name}|${rec.to}`))).toString('hex');
/** Names in one page of GET /names. */
export const NAMES_PAGE = 500;
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
    this.digests = []; // digests[i] = the running digest before list[i] (a page's digestBefore)
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
      this.digests.push(this.digest);
      this.digest = nextNamesDigest(this.digest, rec);
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

  /**
   * Up to `n` names from place `after` (0 = the first name): { after, digestBefore, names: [{ i, name,
   * to, id, height }], next }. digestBefore is the running digest before names[0] (the digest itself
   * when the page is empty); next is the `after` of the following page, or null after the last name.
   * Recomputing the digest over every page from NAMES_GENESIS ends on state().digest.
   * (`list` is the records themselves, so this reader is page().)
   */
  page(after = 0, n = NAMES_PAGE) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.list.length) throw new Error(`after must be 0 to ${this.list.length}`);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('a page holds 1 name or more');
    // an index restored without digests[] (a saved state from before it existed) gets them back
    for (let i = this.digests.length; i < this.list.length; i++) this.digests.push(i ? nextNamesDigest(this.digests[i - 1], this.list[i - 1]) : GENESIS_DIGEST);
    const rows = this.list.slice(after, after + n).map((r, k) => ({ i: after + k, name: r.name, to: r.to, id: r.id, height: r.height }));
    const end = after + rows.length;
    return { after, digestBefore: after < this.list.length ? this.digests[after] : this.digest, names: rows, next: end < this.list.length ? end : null };
  }
}
