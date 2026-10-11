// Shielded Ordinals v1 — the piece index of a file-mint collection: which child inscription is each
// piece, with its content hash and metadata, read from the Bitcoin blocks the collection follower
// already reads (no ord server, no operator files). METADATA ONLY: nothing in the protocol's
// acceptance rules depends on it, and nothing here touches the rules engine or its state digest.
//
// The child convention (PROTOCOL-v1.md):
//   A child of the collection is an inscription in a tx that SPENDS the parent inscription, whose
//   parent tag (tag 3) names the parent (ord's rule for a child).
//   Its piece is tag-5 metadata `shielded.piece`: an integer in [0, supply), with `shielded.parent`
//   absent or equal to the parent. Otherwise a pin (collections.mjs) may decide: a pin names a child
//   id, its content hash and a Merkle path to artRoot, and counts only if the path checks. Never the
//   display name, never elimination.
//   The first child of a piece wins, in block order, then tx order, then inscription order. Every
//   other inscription that names the parent in a parent-spending tx is listed as ignored, with why.
//
// Where the parent is: from its reveal tx (the input holding its envelope, or its pointer tag), then
// moved by ord's first-in-first-out sat flow each time a tx spends it. The values of the coins a tx
// spends are only needed when the parent is not its first input (source.prevoutValues). If the
// parent's sat goes to the fees, the parent is 'lost' and no later child is recognised (ord would
// move it into the coinbase; this index stops instead).
//
// Cost: every cached block is scanned for the one outpoint that holds the parent (no request). Only
// the txs that spend the parent are read in full: one fetch each, kept on disk by txid
// (<cache>/<network>-pieces/<txid>.json, the content hashes and metadata, never the bodies).
//
// Checking: a running digest sha256(previous | height | child id | piece | content sha256) over every
// child taken, so two indexers can compare their piece maps. Once every piece has a child, artRoot is
// recomputed from the children's content hashes (art.mjs) and must equal the rules' artRoot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ordinals from 'micro-ordinals';
import { artRoot, verifyArt } from './art.mjs';
import { provenanceTier } from './registry.mjs';

const { parseEnvelopes, TagCoders } = ordinals.__test__ ?? {};
if (typeof parseEnvelopes !== 'function' || typeof TagCoders?.metadata?.decode !== 'function') throw new Error('pieces.mjs needs micro-ordinals 0.2 (parseEnvelopes and its CBOR coder)');

export const PER_PAGE = 1000; // rows per /pieces page
export const FINAL_DEPTH = 6; // a mint and a child this many blocks deep make an answer final
export const METADATA_MAX_BYTES = 4096; // larger tag-5 metadata is kept as null (flag 'too large')
export const IGNORED_MAX = 1000; // ignored children listed (all are counted)
export const READER = 1; // version of what readReveal keeps; a cached reading of another version is read again
export const SHIELDED_TRAIT = 'Shielded #'; // left out of the bulk pages: it is the global number

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const GENESIS_DIGEST = sha256hex('shord-pieces-v1');
const EMPTY = Buffer.alloc(0);

// ---- reading a reveal tx --------------------------------------------------------------------------

const NAMED_OPS = { 0x4f: '1NEGATE', 0x63: 'IF', 0x68: 'ENDIF' };
/**
 * A tapscript as micro-ordinals' parseEnvelopes reads it: 0 for an empty push (however it is
 * encoded, as ord treats it), bytes for any other push, 1..16 for OP_1..OP_16, 'IF', 'ENDIF',
 * '1NEGATE', and any other opcode as a string. As in ord, a push that runs past the end makes the
 * whole script unreadable (throws), and an unknown opcode is just an opcode.
 */
export function scriptOps(script) {
  const s = Buffer.from(script);
  const out = [];
  for (let i = 0; i < s.length;) {
    const op = s[i++];
    let n = -1;
    if (op <= 0x4b) n = op;
    else if (op === 0x4c) { if (i + 1 > s.length) throw new Error('truncated push'); n = s[i]; i += 1; }
    else if (op === 0x4d) { if (i + 2 > s.length) throw new Error('truncated push'); n = s.readUInt16LE(i); i += 2; }
    else if (op === 0x4e) { if (i + 4 > s.length) throw new Error('truncated push'); n = s.readUInt32LE(i); i += 4; }
    if (n >= 0) {
      if (i + n > s.length) throw new Error('push past the end of the script');
      out.push(n === 0 ? 0 : s.subarray(i, i + n));
      i += n;
      continue;
    }
    if (op >= 0x51 && op <= 0x60) { out.push(op - 0x50); continue; }
    out.push(NAMED_OPS[op] ?? `op${op}`);
  }
  return out;
}

/** ord's inscription id field (parent, delegate; ord InscriptionId::from_value): 32 bytes of txid,
 *  then 0-4 bytes of index, little endian. A shorter index may not end in a zero byte (ord refuses
 *  that form); the full 4-byte index may (fixed length, e.g. 00000000 for i0). null when it is not one. */
export function inscriptionIdField(v) {
  if (!v || v.length < 32 || v.length > 36) return null;
  const idx = v.subarray(32);
  if (idx.length && idx.length !== 4 && idx[idx.length - 1] === 0) return null;
  let n = 0;
  for (let k = idx.length - 1; k >= 0; k--) n = n * 256 + idx[k];
  return `${Buffer.from(v.subarray(0, 32)).reverse().toString('hex')}i${n}`;
}

/** ord's pointer field: little endian, bytes after the 8th must be zero. null when unusable. */
function pointerField(v) {
  if (!v || v.subarray(8).some((b) => b !== 0)) return null;
  let n = 0n;
  for (let k = Math.min(8, v.length) - 1; k >= 0; k--) n = (n << 8n) | BigInt(v[k]);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null; // beyond every output anyway
}

/** CBOR as decoded, made safe for JSON (bounded depth and width; bytes as hex, big integers as text). */
export function jsonSafe(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.slice(0, 256).map((x) => jsonSafe(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 64).map(([k, x]) => [String(k), jsonSafe(x, depth + 1)]));
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return typeof v === 'string' || typeof v === 'boolean' ? v : null;
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** One envelope's fields, the way ord reads them (fields before the first empty push at an even
 *  position, the body after it). Each envelope is decoded on its own, so a bad one hides nothing. */
function readEnvelope(id, input, payload) {
  const rec = { id, input, contentType: null, parents: [], pointer: null, delegate: null, contentEncoding: null, metadata: null, metadataError: null, shielded: null, size: 0, sha256: null };
  try {
    const p = payload.map((x) => (x === 0 ? EMPTY : Buffer.from(x)));
    let bodyAt = p.findIndex((x, i) => i % 2 === 0 && x.length === 0);
    const hasBody = bodyAt >= 0;
    if (!hasBody) bodyAt = p.length;
    const fields = new Map();
    for (let i = 0; i + 1 < bodyAt; i += 2) {
      const tag = p[i].toString('hex');
      if (!fields.has(tag)) fields.set(tag, []);
      fields.get(tag).push(p[i + 1]);
    }
    const first = (t) => fields.get(t)?.[0];
    if (first('01')) rec.contentType = first('01').toString('utf8');
    for (const v of fields.get('03') ?? []) { const id3 = inscriptionIdField(v); if (id3 && !rec.parents.includes(id3)) rec.parents.push(id3); }
    if (first('02')) rec.pointer = pointerField(first('02'));
    if (first('0b')) rec.delegate = inscriptionIdField(first('0b'));
    if (first('09')) rec.contentEncoding = first('09').toString('utf8');
    if (fields.has('05')) {
      let decoded;
      try { decoded = TagCoders.metadata.decode(Buffer.concat(fields.get('05'))); } catch { rec.metadataError = 'unreadable'; }
      if (!rec.metadataError) {
        const safe = jsonSafe(decoded);
        if (Buffer.byteLength(JSON.stringify(safe)) <= METADATA_MAX_BYTES) rec.metadata = safe;
        else rec.metadataError = 'too large';
        // what the piece rule reads, kept even when the metadata is too large to keep
        if (isPlainObject(decoded) && Object.hasOwn(decoded, 'shielded')) {
          const sh = decoded.shielded;
          rec.shielded = isPlainObject(sh) ? { piece: jsonSafe(sh.piece ?? null), parent: jsonSafe(sh.parent ?? null) } : false;
        }
      }
    }
    if (hasBody) {
      const body = Buffer.concat(p.slice(bodyAt + 1));
      rec.size = body.length;
      rec.sha256 = sha256hex(body);
    }
  } catch (e) {
    rec.error = String(e?.message ?? e).slice(0, 80);
  }
  return rec;
}

/**
 * Everything the piece index keeps from a raw tx: { reader, txid, ins: ['<txid>:<vout>'], outs:
 * [sats], envelopes }. Envelopes are numbered like ord (input by input), each one read on its own:
 * { id, input, contentType, parents, pointer, delegate, contentEncoding, metadata (tag 5, JSON-safe,
 * at most METADATA_MAX_BYTES, else null), metadataError ('unreadable' | 'too large' | null),
 * shielded ({ piece, parent } | false | null), size, sha256 (of the body; the body is not kept) }.
 */
export function readReveal(txHex) {
  const tx = bitcoin.Transaction.fromHex(String(txHex).trim());
  const txid = tx.getId();
  const envelopes = [];
  tx.ins.forEach((inp, input) => {
    let w = inp.witness ?? [];
    if (w.length >= 2 && w[w.length - 1].length && w[w.length - 1][0] === 0x50) w = w.slice(0, -1); // annex
    if (w.length < 2) return;
    let ops;
    try { ops = scriptOps(w[w.length - 2]); } catch { return; } // ord reads nothing from an unreadable script
    for (const env of parseEnvelopes(ops)) envelopes.push(readEnvelope(`${txid}i${envelopes.length}`, input, env.payload));
  });
  return {
    reader: READER, txid,
    ins: tx.ins.map((i) => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`),
    outs: tx.outs.map((o) => Number(o.value)),
    envelopes,
  };
}

/** The envelopes of a raw tx (readReveal), one record each, so one bad envelope never hides the rest. */
export const readChildren = (txHex) => readReveal(txHex).envelopes;

// ---- the index ------------------------------------------------------------------------------------

/** The sat at `abs` (counted over the tx's outputs) lands on { txid, vout, offset }, or 'lost' (fees). */
function locate(r, abs) {
  let acc = 0;
  for (let o = 0; o < r.outs.length; o++) {
    if (abs < acc + r.outs[o]) return { txid: r.txid, vout: o, offset: abs - acc };
    acc += r.outs[o];
  }
  return 'lost';
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** The PieceIndex among a follower's hooks, or null. */
export const piecesOf = (hooks) => (hooks ?? []).find((k) => k?.kind === 'pieces') ?? null;

/**
 * A follower hook (follow.mjs) for one file-mint collection.
 *   new PieceIndex({ rulesInscriptionId, rules, network, cacheDir, pinned })
 *   pinned: { '<child id>': { piece, sha256, proof: [hex | null, ...] } } (collections.mjs)
 */
export class PieceIndex {
  /** Collections that get a piece index: file mint (artRoot), not pre-inscribed, not a rune. */
  static wants(rules) { return !!rules?.artRoot && rules.children === undefined && rules.kind !== 'rune'; }

  constructor({ rulesInscriptionId, rules, network = 'mainnet', cacheDir = null, pinned = {}, perPage = PER_PAGE }) {
    if (!PieceIndex.wants(rules)) throw new Error('a piece index is for file-mint collections');
    const m = /^([0-9a-f]{64})i(\d+)$/.exec(rulesInscriptionId ?? '');
    if (!m) throw new Error('rulesInscriptionId is not an inscription id');
    if (!(Number.isSafeInteger(perPage) && perPage >= 1)) throw new Error('perPage is a whole number above 0');
    this.kind = 'pieces';
    this.id = 'pieces'; // its state's name in a checkpoint (checkpoint.mjs hookStates)
    this.parent = rulesInscriptionId;
    this.parentTxid = m[1];
    this.supply = rules.supply;
    this.artRootHex = rules.artRoot;
    this.contentType = rules.contentType ?? null;
    this.perPage = perPage;
    this.dir = cacheDir ? path.resolve(cacheDir, `${network}-pieces`) : null;
    // A pin counts only when its Merkle path proves its content hash is that piece's art.
    this.pins = new Map();
    for (const [id, p] of Object.entries(pinned ?? {})) {
      const shape = Number.isInteger(p?.piece) && p.piece >= 0 && p.piece < this.supply && /^[0-9a-f]{64}$/.test(p?.sha256 ?? '')
        && Array.isArray(p.proof) && p.proof.every((x) => x === null || /^[0-9a-f]{64}$/.test(x));
      const ok = shape && verifyArt(Buffer.from(this.artRootHex, 'hex'), p.piece, Buffer.from(p.sha256, 'hex'), p.proof.map((x) => (x ? Buffer.from(x, 'hex') : null)));
      this.pins.set(id, { piece: p?.piece, sha256: p?.sha256, ok: !!ok });
    }
    this.gen = 0;
    this.reset();
  }

  /** A new engine starts from the collection's first block (first sync, or after a reorg). */
  reset() {
    this.parentAt = null; // { txid, vout, offset } | 'lost' | null (its reveal not seen yet)
    this.pieces = new Map(); // assetId -> { id, height, txid, contentType, size, sha256, delegate, via, metadata, metadataError? }
    this.ignored = []; // [{ id, reason, piece? }], the first IGNORED_MAX
    this.ignoredTotal = 0;
    this.digest = GENESIS_DIGEST;
    this.height = null;
    this.pending = null;
    this.gen++;
    this._memo = new Map();
  }

  // -- follower hook ---------------------------------------------------------------------------------

  /** Finds the txs of block h that move the parent (txs = the follower's cached block: every tx's
   *  spent coins), reads them (cache or one fetch each) and works out where the parent ends up.
   *  Changes nothing yet: a failed fetch throws and the round stops before block h. */
  async beforeBlock(h, hash, txs, src) {
    this.pending = null;
    let at = this.parentAt;
    const reveals = [];
    let i = 0;
    if (at === null) {
      i = txs.findIndex((t) => t.txid === this.parentTxid);
      if (i < 0) { this.pending = { h, at, reveals }; return; }
      at = await this._genesis(await this._read(this.parentTxid, hash, src), hash, src);
      i++;
    }
    // A tx can only spend a coin made earlier in the block, so one pass in block order follows the
    // parent however many times it moves in this block.
    for (; i < txs.length && at && at !== 'lost'; i++) {
      const j = txs[i].ins.findIndex((x) => x.vout === at.vout && x.txid === at.txid);
      if (j < 0) continue;
      const r = await this._read(txs[i].txid, hash, src);
      if (r.ins[j] !== `${at.txid}:${at.vout}`) throw new Error(`tx ${r.txid}: its inputs differ from the block's`);
      let before = 0;
      if (j > 0) { const v = await this._values(r, hash, src); for (let k = 0; k < j; k++) before += v[k]; }
      reveals.push(r);
      at = locate(r, before + at.offset);
    }
    this.pending = { h, at, reveals };
  }

  /** Block h is applied: take its children, move the parent. */
  afterBlock(h) {
    const p = this.pending;
    this.pending = null;
    if (p && p.h === h) {
      for (const r of p.reveals) for (const e of r.envelopes) this._child(h, r.txid, e);
      this.parentAt = p.at;
    }
    this.height = h;
  }

  _child(h, txid, e) {
    if (!e.parents.includes(this.parent)) return; // not claiming this parent: not a child
    let piece = null;
    let via = null;
    let reason = null;
    const sh = e.shielded;
    if (sh === null || sh === undefined) reason = e.metadataError === 'unreadable' ? 'metadata unreadable' : 'no shielded.piece';
    else if (sh === false) reason = 'shielded is not an object';
    else if (sh.parent !== null && sh.parent !== this.parent) reason = 'shielded.parent names another parent';
    else if (sh.piece === null) reason = 'no shielded.piece';
    else if (!Number.isInteger(sh.piece)) reason = 'shielded.piece is not an integer';
    else if (sh.piece < 0 || sh.piece >= this.supply) reason = 'shielded.piece is out of range';
    else { piece = sh.piece; via = 'metadata'; }
    if (piece === null && this.pins.has(e.id)) {
      const pin = this.pins.get(e.id);
      if (!pin.ok) reason = 'pin proof does not verify against artRoot';
      else if (pin.sha256 !== e.sha256) reason = 'content differs from the pin';
      else { piece = pin.piece; via = 'pinned'; reason = null; }
    }
    if (piece === null) return this._ignore({ id: e.id, reason });
    if (this.pieces.has(piece)) return this._ignore({ id: e.id, reason: 'piece already has a child', piece });
    this.pieces.set(piece, {
      id: e.id, height: h, txid, contentType: e.contentType, size: e.size, sha256: e.sha256, delegate: e.delegate, via,
      metadata: e.metadata, ...(e.metadataError ? { metadataError: e.metadataError } : {}),
    });
    this.digest = sha256hex(`${this.digest}|${h}|${e.id}|${piece}|${e.sha256}`);
  }

  _ignore(x) {
    this.ignoredTotal++;
    if (this.ignored.length < IGNORED_MAX) this.ignored.push(x);
  }

  /** Where the parent stands after its own reveal tx: its pointer (when inside the outputs), else
   *  the first sat of the input holding its envelope. */
  async _genesis(r, hash, src) {
    const e = r.envelopes.find((x) => x.id === this.parent);
    if (!e) return 'lost';
    const total = r.outs.reduce((s, v) => s + v, 0);
    if (e.pointer !== null && e.pointer < total) return locate(r, e.pointer);
    let before = 0;
    if (e.input > 0) { const v = await this._values(r, hash, src); for (let k = 0; k < e.input; k++) before += v[k]; }
    return locate(r, before);
  }

  async _read(txid, hash, src) {
    const file = this.dir ? path.join(this.dir, `${txid}.json`) : null;
    const hit = file ? readJson(file) : null;
    if (hit?.reader === READER && hit.txid === txid && Array.isArray(hit.ins) && Array.isArray(hit.outs) && Array.isArray(hit.envelopes)) return hit;
    if (typeof src?.txHex !== 'function') throw new Error('the chain source cannot give a transaction');
    const r = readReveal(await src.txHex(txid, hash));
    if (r.txid !== txid) throw new Error(`tx ${txid}: the source returned a different transaction`);
    this._save(r);
    return r;
  }

  async _values(r, hash, src) {
    if (Array.isArray(r.inValues)) return r.inValues;
    if (typeof src?.prevoutValues !== 'function') throw new Error('the chain source cannot give the values of spent coins (prevoutValues)');
    const v = await src.prevoutValues(hash, r.txid);
    if (!Array.isArray(v) || v.length !== r.ins.length || !v.every((x) => Number.isSafeInteger(x) && x >= 0)) throw new Error(`tx ${r.txid}: the source gave no usable values for its spent coins`);
    r.inValues = v;
    this._save(r);
    return v;
  }

  _save(r) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${r.txid}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(r));
    fs.renameSync(file + '.tmp', file);
  }

  // -- saved state (checkpoints) ---------------------------------------------------------------------

  snapshot() {
    return {
      v: 1, parent: this.parent, height: this.height, parentAt: this.parentAt, digest: this.digest,
      pieces: [...this.pieces], ignored: this.ignored, ignoredTotal: this.ignoredTotal,
    };
  }

  restore(s) {
    if (!s || s.v !== 1 || s.parent !== this.parent) throw new Error('not a saved state of this piece index');
    this.reset();
    this.height = s.height;
    this.parentAt = s.parentAt;
    this.digest = s.digest;
    this.pieces = new Map(s.pieces);
    this.ignored = s.ignored;
    this.ignoredTotal = s.ignoredTotal;
  }

  // -- reading ---------------------------------------------------------------------------------------

  /** The child of a piece, or null. */
  childOf(assetId) { return this.pieces.get(assetId) ?? null; }
  pages() { return Math.ceil(this.supply / this.perPage); }
  parentAtText() { return this.parentAt === null || this.parentAt === 'lost' ? this.parentAt : `${this.parentAt.txid}:${this.parentAt.vout}`; }

  /** { root, have, of, verified }: verified is null until every piece has a child. */
  art() {
    const key = `art|${this.gen}|${this.digest}`;
    const hit = this._memo.get('art');
    if (hit?.key === key) return hit.value;
    let verified = null;
    if (this.pieces.size === this.supply) {
      const hs = [];
      for (let a = 0; a < this.supply; a++) { const s = this.pieces.get(a).sha256; if (!s) break; hs.push(Buffer.from(s, 'hex')); }
      verified = hs.length === this.supply && artRoot(hs).toString('hex') === this.artRootHex;
    }
    const value = { root: this.artRootHex, have: this.pieces.size, of: this.supply, verified };
    this._memo.set('art', { key, value });
    return value;
  }

  /** The small summary /collection carries. */
  summary() {
    const a = this.art();
    return { withChild: this.pieces.size, pages: this.pages(), art: { have: a.have, of: a.of, verified: a.verified } };
  }

  /** GET /pieces/info. `ix` = the collection's rules engine, `height` = its last block. */
  info({ ix, height }) {
    return {
      parent: this.parent, parentAt: this.parentAtText(), supply: this.supply, minted: ix.minted.size, withChild: this.pieces.size,
      pages: this.pages(), perPage: this.perPage, art: this.art(), ignored: this.ignored,
      ...(this.ignoredTotal > this.ignored.length ? { ignoredTotal: this.ignoredTotal } : {}),
      digest: this.digest, height,
    };
  }

  /** GET /pieces/<assetId>. `global` = the registry's global number of the piece, or null (then the
   *  answer is never final: it changes once the registry knows the number). */
  piece(assetId, { ix, height, global = null }) {
    const mi = ix.minted.get(assetId) ?? null;
    const c = this.pieces.get(assetId) ?? null;
    const deep = (h) => height - h + 1 >= FINAL_DEPTH;
    return {
      assetId, global, tier: global === null ? null : provenanceTier(global),
      mint: mi ? { height: mi.height, txid: mi.txid } : null,
      child: c ? {
        id: c.id, height: c.height, txid: c.txid, contentType: c.contentType, size: c.size, sha256: c.sha256, delegate: c.delegate, via: c.via,
        ...(c.metadataError ? { metadataError: c.metadataError } : {}),
      } : null,
      metadata: c?.metadata ?? null,
      final: !!(mi && c && global !== null && deep(mi.height) && deep(c.height)),
    };
  }

  /**
   * GET /pieces?page=k: { body, version, final }. Rows are built once per change (a mint, a child or
   * the collection's global range), and `version` is a hash of the answer, so an unchanged page keeps
   * its ETag across blocks. `globalStart` = the registry's range start for this collection, or null
   * (then the page is never final: its body changes once the registry knows the range).
   */
  page(k, { ix, height, globalStart = null }) {
    const m = this._pageRows(k, ix, globalStart);
    const final = m.complete && m.globalStart !== null && height - m.maxHeight + 1 >= FINAL_DEPTH;
    if (!m.versions[final]) {
      const body = this._pageBody(m, final);
      m.versions[final] = { body, version: sha256hex(JSON.stringify(body)).slice(0, 16) };
    }
    return { ...m.versions[final], final };
  }

  _pageBody(m, final) {
    return {
      v: 1, page: m.page, pages: this.pages(), from: m.from, to: m.to, final, contentType: this.contentType, name: m.name, globalStart: m.globalStart,
      txs: m.txs, traits: m.traits, values: m.values, rows: m.rows,
    };
  }

  _pageRows(k, ix, globalStart) {
    const key = `${this.gen}|${this.digest}|${ix.minted.size}|${globalStart}`;
    const hit = this._memo.get(`page ${k}`);
    if (hit && hit.key === key && hit.ix === ix) return hit.value;
    const from = k * this.perPage;
    const to = Math.min(this.supply, from + this.perPage) - 1;
    const entries = [];
    const prefixes = new Map();
    for (let a = from; a <= to; a++) {
      const mi = ix.minted.get(a) ?? null;
      const c = this.pieces.get(a) ?? null;
      if (!mi && !c) continue; // never minted, never inscribed: absent
      const name = c && typeof c.metadata?.name === 'string' ? c.metadata.name : null;
      entries.push({ a, mi, c, name });
      const nm = name === null || globalStart === null ? null : /^(.*) #(\d+)$/.exec(name);
      if (nm && Number(nm[2]) === globalStart + a) prefixes.set(nm[1], (prefixes.get(nm[1]) ?? 0) + 1);
    }
    // the name most children of this page follow, "<base> #<global number>"; others are sent as they are
    let base = null;
    for (const [p, n] of prefixes) if (base === null || n > prefixes.get(base) || (n === prefixes.get(base) && p < base)) base = p;
    const dict = () => { const list = []; const at = new Map(); return { list, of: (v) => { const key2 = JSON.stringify(v); if (!at.has(key2)) { at.set(key2, list.length); list.push(v); } return at.get(key2); } }; };
    const txs = dict();
    const traits = dict();
    const values = dict();
    const rows = [];
    let complete = true;
    let maxHeight = -Infinity;
    for (const { a, mi, c, name } of entries) {
      const attrs = [];
      for (const t of Array.isArray(c?.metadata?.attributes) ? c.metadata.attributes : []) {
        if (!isPlainObject(t) || typeof t.trait_type !== 'string' || !Object.hasOwn(t, 'value') || t.trait_type === SHIELDED_TRAIT) continue;
        attrs.push(traits.of(t.trait_type), values.of(t.value));
      }
      const row = [a, mi ? mi.height : null, c ? txs.of(c.txid) : null, c ? Number(c.id.slice(c.id.lastIndexOf('i') + 1)) : null, c ? c.height : null, attrs];
      if (c && (base === null || name !== `${base} #${globalStart + a}`)) row.push(name);
      rows.push(row);
      if (!mi || !c) complete = false;
      maxHeight = Math.max(maxHeight, mi?.height ?? -Infinity, c?.height ?? -Infinity);
    }
    if (rows.length !== to - from + 1) complete = false;
    const value = {
      page: k, from, to, name: base === null ? null : `${base} #{global}`, globalStart,
      txs: txs.list, traits: traits.list, values: values.list, rows, complete, maxHeight, versions: {},
    };
    this._memo.set(`page ${k}`, { key, ix, value });
    return value;
  }
}
