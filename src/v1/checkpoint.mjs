// Shielded Ordinals v1 — state checkpoints (Node only). After a block, one collection's rules engine
// (indexer.mjs) and its follower hooks are saved to a sealed file. A restart loads the newest file that
// still checks out and replays only the blocks after it. Nothing here is a rule: a loaded engine is,
// field for field, the engine a replay from the start block reaches (test/checkpoint.test.mjs).
//
// File: <dir>/<height>-<blockHash>.json.gz, the gzip of two lines:
//   header  kind, format, stamp, network, cid, rulesInscriptionId, rulesHash, vkeyHash, startHeight,
//           height, blockHash, recent (the last 12 [height, hash]), digest (v1, as /status), digest2
//           (when given), seal
//   body    notes, nullifiers, minted, listings, lockIndex, roots (EVERY block's root and leaf count),
//           fields (the engine Maps named in FIELDS), log (the engine's whole accept/reject log, with
//           heights: the listing history), hooks ({ id: hook.snapshot() })
// seal = sha256(the header without the seal + "\n" + the body): a cut or edited file is refused.
// Maps and Sets are saved in insertion order, so every answer built from a loaded engine (/state
// included) is byte for byte the answer a replay gives.
//
// A load is used only if all of these hold (any failure: the next older file, then a full replay):
//   1. kind, format, engine stamp, network, cid, rules, rules hash, key hash and start block are the
//      running ones;
//   2. the seal;
//   3. the note tree is rebuilt from the notes, block by block: every saved root and leaf count must
//      be what the notes give;
//   4. the v1 state digest; one mint note per minted piece; every lockIndex entry is an ACTIVE listing
//      with that lock outpoint;
//   5. (the follower) the block hash at `height` and the 12 before it are still the best chain;
//   6. every hook restores its own snapshot (a hook that throws refuses the file).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { P } from './core.mjs';
import { REGISTRY_START } from './registry.mjs';
import { NAMES_START } from './names.mjs';

export const FORMAT = 1;
const KIND = 'shord-checkpoint';
/** How many recent [height, hash] pairs a checkpoint carries (checked against the chain on load). */
export const RECENT = 12;
/** Engine fields saved by name, beyond the ones below. Later packages append theirs; a name the engine
 *  does not have is skipped. An engine field that is in neither list stops checkpoints being written. */
export const FIELDS = ['nfCounts'];
/** Packages whose code takes part in replaying a block: their installed versions are in the stamp. */
export const DEPENDENCIES = ['snarkjs', 'bitcoinjs-lib', 'poseidon-lite', '@noble/hashes', '@noble/curves', 'micro-ordinals'];

// Set by the constructor from the running settings (never saved), and the state a checkpoint carries.
const CONFIG = new Set(['rulesInscriptionId', 'rules', 'network', 'cid', 'gateScript', 'vkey']);
const STATE = new Set(['tree', 'nullifiers', 'roots', 'leafCounts', 'notes', 'minted', 'listings', 'lockIndex', 'lastHeight', 'log']);
const HEADER = ['kind', 'format', 'stamp', 'network', 'cid', 'rulesInscriptionId', 'rulesHash', 'vkeyHash', 'startHeight', 'height', 'blockHash', 'recent', 'digest', 'digest2'];
const MUST_MATCH = ['stamp', 'network', 'cid', 'rulesInscriptionId', 'rulesHash', 'vkeyHash', 'startHeight'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^(\d+)-([0-9a-f]{64})\.json\.gz$/;

// ---- the engine stamp --------------------------------------------------------------------------

const versionOf = (pkg, from) => {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
    if (fs.existsSync(file)) { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version); } catch { return 'unreadable'; } }
    if (path.dirname(dir) === dir) return 'missing';
  }
};

/**
 * sha256 over everything that decides what a replay produces: every file in src/v1/ (sorted by name,
 * line endings made LF, so a Windows and a Linux checkout agree), the installed versions of
 * DEPENDENCIES, the checkpoint format, REGISTRY_START, NAMES_START and the verification key hash.
 * Any change to one of them (a comment included) makes older checkpoints unusable: one full replay,
 * which is safe. indexer/*.mjs is not in it, so a release that changes only the API restarts in seconds.
 */
export function engineStamp({ vkeyHash, srcDir = HERE, modulesFrom = srcDir, registryStart = REGISTRY_START, namesStart = NAMES_START } = {}) {
  const h = crypto.createHash('sha256');
  h.update(`shord engine stamp, checkpoint format ${FORMAT}\n`);
  const files = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  for (const f of files) {
    const text = fs.readFileSync(path.join(srcDir, f), 'latin1').replace(/\r\n/g, '\n');
    h.update(`file ${f} ${text.length}\n`);
    h.update(text, 'latin1');
    h.update('\n');
  }
  for (const p of DEPENDENCIES) h.update(`package ${p} ${versionOf(p, modulesFrom)}\n`);
  h.update(`registry start ${JSON.stringify(registryStart)}\nnames start ${JSON.stringify(namesStart)}\nverification key ${vkeyHash}\n`);
  return h.digest('hex');
}

// ---- values the engine holds, as JSON ----------------------------------------------------------
// Buffer {"~b": hex}, other bytes {"~a": hex}, BigInt {"~n": decimal}, undefined {"~u": 1}, Map {"~m":
// [[k, v]]}, Set {"~s": [v]}; a plain object whose only key looks like a tag is wrapped in {"~o": …}.
// Anything else that is not plain data (a class instance, a function) cannot be saved: refused.
const TAGS = new Set(['~b', '~a', '~n', '~u', '~m', '~s', '~o']);

export function encode(v) {
  if (v === undefined) return { '~u': 1 };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`cannot save the number ${v}`); return v; }
  if (typeof v === 'bigint') return { '~n': v.toString() };
  if (Buffer.isBuffer(v)) return { '~b': v.toString('hex') };
  if (v instanceof Uint8Array) return { '~a': Buffer.from(v).toString('hex') };
  if (Array.isArray(v)) return v.map(encode);
  if (v instanceof Map) return { '~m': [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (v instanceof Set) return { '~s': [...v].map(encode) };
  if (typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`cannot save a ${v?.constructor?.name ?? typeof v} in a checkpoint`);
  const keys = Object.keys(v);
  const out = Object.fromEntries(keys.map((k) => [k, encode(v[k])]));
  return keys.length === 1 && TAGS.has(keys[0]) ? { '~o': out } : out;
}

export function decode(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const keys = Object.keys(v);
  if (keys.length === 1 && TAGS.has(keys[0])) {
    const x = v[keys[0]];
    switch (keys[0]) {
      case '~u': return undefined;
      case '~n': return BigInt(x);
      case '~b': return Buffer.from(x, 'hex');
      case '~a': return new Uint8Array(Buffer.from(x, 'hex'));
      case '~m': return new Map(x.map(([a, b]) => [decode(a), decode(b)]));
      case '~s': return new Set(x.map(decode));
      default: return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, decode(y)])); // ~o
    }
  }
  return Object.fromEntries(keys.map((k) => [k, decode(v[k])]));
}

// ---- engine <-> body ---------------------------------------------------------------------------
// The bulky parts use compact rows when every record has exactly the usual shape; anything else is
// saved with encode(), so an engine that grows a field is still saved exactly.
const NOTE_KEYS = 'pos,cm,epk,ct,txid,height,kind';
const plainNote = (n, i) => n.pos === i && typeof n.cm === 'bigint' && Buffer.isBuffer(n.epk) && Buffer.isBuffer(n.ct)
  && typeof n.txid === 'string' && Number.isSafeInteger(n.height) && typeof n.kind === 'string';
function noteRow(n, i) {
  const keys = Object.keys(n).join(',');
  if (plainNote(n, i)) {
    const row = [n.cm.toString(), n.epk.toString('hex'), n.ct.toString('hex'), n.txid, n.height, n.kind];
    if (keys === NOTE_KEYS) return row;
    if (keys === NOTE_KEYS + ',assetId' && Number.isSafeInteger(n.assetId)) return [...row, n.assetId];
  }
  return encode(n);
}
function noteOf(r, pos) {
  if (!Array.isArray(r)) return decode(r);
  const n = { pos, cm: BigInt(r[0]), epk: Buffer.from(r[1], 'hex'), ct: Buffer.from(r[2], 'hex'), txid: r[3], height: r[4], kind: r[5] };
  if (r.length === 7) n.assetId = r[6];
  return n;
}
const isPair = (v, a, b) => v && typeof v === 'object' && Object.keys(v).join(',') === `${a},${b}`;

/** The engine's state as a body object (synchronous; nothing is copied that a later block changes). */
export function engineBody(ix) {
  for (const k of Object.keys(ix)) {
    if (typeof ix[k] === 'function' || CONFIG.has(k) || STATE.has(k) || FIELDS.includes(k)) continue;
    throw new Error(`the rules engine has a field "${k}" that checkpoints do not save (add it to FIELDS in src/v1/checkpoint.mjs)`);
  }
  const roots = [...ix.roots];
  const counts = [...ix.leafCounts];
  if (roots.length !== counts.length || roots.some(([h, r], i) => counts[i][0] !== h || typeof r !== 'bigint' || !Number.isSafeInteger(counts[i][1]))) {
    throw new Error('the engine roots and leaf counts do not cover the same blocks');
  }
  const minted = [...ix.minted];
  const listings = [...ix.listings];
  const lockIndex = [...ix.lockIndex];
  const nullifiers = [...ix.nullifiers];
  return {
    notes: ix.notes.map(noteRow),
    nullifiers: nullifiers.every((x) => typeof x === 'bigint') ? nullifiers.map(String) : encode(ix.nullifiers),
    minted: minted.every(([a, m]) => Number.isSafeInteger(a) && isPair(m, 'txid', 'height') && typeof m.txid === 'string' && Number.isSafeInteger(m.height))
      ? minted.map(([a, m]) => [a, m.txid, m.height]) : encode(ix.minted),
    listings: listings.every(([nf, l]) => typeof nf === 'bigint' && l?.nf === nf) ? listings.map(([, l]) => encode(l)) : encode(ix.listings),
    lockIndex: lockIndex.every(([k, nf]) => typeof k === 'string' && typeof nf === 'bigint') ? lockIndex.map(([k, nf]) => [k, String(nf)]) : encode(ix.lockIndex),
    roots: roots.map(([h, r], i) => [h, r.toString(), counts[i][1]]),
    fields: Object.fromEntries(FIELDS.filter((f) => Object.hasOwn(ix, f)).map((f) => [f, encode(ix[f])])),
    log: encode(ix.log),
  };
}

const hookId = (k, i) => (typeof k.id === 'string' && k.id ? k.id : `hook${i}`);
/** Hooks whose state a checkpoint can carry: every one with snapshot() and restore(). */
export const hooksSaveable = (hooks) => hooks.every((k) => k.stateless === true || (typeof k.snapshot === 'function' && typeof k.restore === 'function'));
export function hookStates(hooks) {
  const out = {};
  hooks.forEach((k, i) => { if (typeof k.snapshot === 'function') out[hookId(k, i)] = encode(k.snapshot()); });
  return out;
}
export function restoreHooks(hooks, saved = {}) {
  hooks.forEach((k, i) => {
    k.reset?.();
    if (typeof k.restore !== 'function') return;
    const id = hookId(k, i);
    if (!Object.hasOwn(saved, id)) throw new Error(`no saved state for the hook "${id}"`);
    try { k.restore(decode(saved[id])); } catch (e) { throw new Error(`the hook "${id}" refused its saved state: ${e.message}`); }
  });
}

const canonicalHeader = (h) => JSON.stringify(Object.fromEntries(HEADER.filter((k) => h[k] !== undefined).map((k) => [k, h[k]])));
/** The seal of a header (its own `seal` left out) over a body text. */
export const sealOf = (header, bodyText) => sha(canonicalHeader(header) + '\n' + bodyText);

/**
 * A checkpoint of `ix` after its last block, made synchronously (call it right after applyBlock
 * returns, before the next await). meta = { stamp, network, cid, rulesInscriptionId, rulesHash,
 * vkeyHash, startHeight }; hashOf(h) = the hash of block h the engine applied; digest2(ix) optional.
 * Returns { name, height, blockHash, text } for persist().
 */
export function capture(ix, { meta, hooks = [], hashOf, digest2 = null }) {
  const height = ix.lastHeight;
  if (height === null) throw new Error('no block applied yet');
  const recent = [];
  for (let h = Math.max(meta.startHeight, height - RECENT + 1); h <= height; h++) {
    const x = hashOf(h);
    if (!x || !HEX64.test(x)) throw new Error(`the hash of block ${h} is not known`);
    recent.push([h, x]);
  }
  const blockHash = recent[recent.length - 1][1];
  const bodyText = JSON.stringify({ ...engineBody(ix), hooks: hookStates(hooks) });
  const header = {
    kind: KIND, format: FORMAT, stamp: meta.stamp, network: meta.network, cid: meta.cid, rulesInscriptionId: meta.rulesInscriptionId,
    rulesHash: meta.rulesHash, vkeyHash: meta.vkeyHash, startHeight: meta.startHeight, height, blockHash, recent,
    digest: sha(ix.stateDigest()), ...(digest2 ? { digest2: digest2(ix) } : {}),
  };
  header.seal = sealOf(header, bodyText);
  return { name: `${height}-${blockHash}.json.gz`, height, blockHash, text: JSON.stringify(header) + '\n' + bodyText };
}

/**
 * Rebuild an engine from a checkpoint and check it (steps 3 and 4 above). make() returns a fresh
 * engine with the running rules and key. Throws on any mismatch.
 */
export function restoreEngine(header, body, { make, startHeight }) {
  const ix = make();
  const want = FIELDS.filter((f) => Object.hasOwn(ix, f)).sort().join(',');
  const got = Object.keys(body.fields ?? {}).sort().join(',');
  if (want !== got) throw new Error(`the checkpoint saves the engine fields [${got}], this engine has [${want}]`);
  if (ix.lastHeight !== null || ix.notes.length || ix.tree.leaves.length) throw new Error('make() did not return a fresh engine');

  const notes = body.notes.map(noteOf);
  // the tree, every root and every leaf count, block by block, from the notes alone
  const blocks = header.height - startHeight + 1;
  if (!Array.isArray(body.roots) || body.roots.length !== blocks) throw new Error(`the roots do not cover every block from ${startHeight} to ${header.height}`);
  let n = 0;
  let last = -Infinity;
  for (let i = 0; i < blocks; i++) {
    const [h, r, count] = body.roots[i];
    if (h !== startHeight + i) throw new Error(`the roots skip block ${startHeight + i}`);
    for (; n < notes.length && notes[n].height <= h; n++) {
      const note = notes[n];
      if (note.pos !== n || note.height < last) throw new Error(`note ${n} is out of order`);
      if (typeof note.cm !== 'bigint' || note.cm < 0n || note.cm >= P) throw new Error(`note ${n} has no valid commitment`);
      last = note.height;
      ix.tree.append(note.cm);
    }
    if (count !== n) throw new Error(`the leaf count at block ${h} is not what the notes give`);
    const root = ix.tree.root();
    if (root !== BigInt(r)) throw new Error(`the root at block ${h} is not what the notes give`);
    ix.roots.set(h, root);
    ix.leafCounts.set(h, count);
  }
  if (n !== notes.length) throw new Error('notes from after the checkpoint block');
  ix.notes = notes;

  const nfs = Array.isArray(body.nullifiers) ? new Set(body.nullifiers.map(BigInt)) : decode(body.nullifiers);
  for (const nf of nfs) if (typeof nf !== 'bigint' || nf < 0n || nf >= P) throw new Error('a nullifier is not a field element');
  ix.nullifiers = nfs;
  ix.minted = Array.isArray(body.minted) ? new Map(body.minted.map(([a, txid, height]) => [a, { txid, height }])) : decode(body.minted);
  ix.listings = Array.isArray(body.listings) ? new Map(body.listings.map((x) => { const l = decode(x); return [l.nf, l]; })) : decode(body.listings);
  ix.lockIndex = Array.isArray(body.lockIndex) ? new Map(body.lockIndex.map(([k, nf]) => [k, BigInt(nf)])) : decode(body.lockIndex);
  ix.lastHeight = header.height;
  ix.log = decode(body.log);
  for (const f of Object.keys(body.fields ?? {})) ix[f] = decode(body.fields[f]);

  if (sha(ix.stateDigest()) !== header.digest) throw new Error('the state digest does not match');
  const mints = notes.filter((x) => x.kind === 'mint').length;
  if (mints !== ix.minted.size) throw new Error(`${mints} mint notes for ${ix.minted.size} minted pieces`);
  for (const [op, nf] of ix.lockIndex) {
    const l = ix.listings.get(nf);
    if (!l || l.state !== 'ACTIVE' || `${l.lock?.txid}:${l.lock?.vout}` !== op) throw new Error(`the lock ${op} does not belong to an active listing`);
  }
  return ix;
}

// ---- files -------------------------------------------------------------------------------------

// (a file another program holds open on Windows stays until the next try)
const removeQuietly = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* removed next time */ } };

/** Checkpoint files in `dir`, newest first: [{ file, height, blockHash }]. Leftover temp files of
 *  other processes (a write cut short) are removed. */
export function listCheckpoints(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const tmp = /\.tmp-(\d+)$/.exec(e.name);
    if (tmp) { if (Number(tmp[1]) !== process.pid) removeQuietly(path.join(dir, e.name)); continue; }
    const m = NAME.exec(e.name);
    if (!m) continue;
    const file = path.join(dir, e.name);
    out.push({ file, height: Number(m[1]), blockHash: m[2], mtime: fs.statSync(file).mtimeMs });
  }
  return out.sort((a, b) => b.height - a.height || b.mtime - a.mtime).map(({ file, height, blockHash }) => ({ file, height, blockHash }));
}

/** Write a capture()d checkpoint: gzip off the main thread, a temp file, then a rename (a file cut
 *  short by a crash fails its seal and the next older one is used). Keeps the newest `keep`. */
export async function persist(dir, cp, { keep = 4 } = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  const gz = await new Promise((ok, no) => zlib.gzip(Buffer.from(cp.text), (e, b) => (e ? no(e) : ok(b))));
  const file = path.join(dir, cp.name);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, gz);
  await fs.promises.rename(tmp, file);
  for (const old of listCheckpoints(dir).slice(Math.max(1, keep))) removeQuietly(old.file);
  return file;
}

/** Read a checkpoint file: { header, bodyText }. Throws on a file that is cut short or not one. */
export async function readCheckpoint(file) {
  const raw = await fs.promises.readFile(file);
  const text = (await new Promise((ok, no) => zlib.gunzip(raw, (e, b) => (e ? no(e) : ok(b))))).toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('not a checkpoint file');
  return { header: JSON.parse(text.slice(0, nl)), bodyText: text.slice(nl + 1) };
}

function checkMeta(header, meta, c) {
  if (header?.kind !== KIND || header.format !== FORMAT) throw new Error('not a checkpoint of this format');
  for (const k of MUST_MATCH) if (header[k] !== meta[k]) throw new Error(`another ${k === 'stamp' ? 'engine (the code or a dependency changed)' : k}`);
  if (header.height !== c.height || header.blockHash !== c.blockHash) throw new Error('the file name does not match its header');
  if (!Number.isSafeInteger(header.height) || header.height < header.startHeight) throw new Error('its block is before the start block');
  const r = header.recent;
  if (!Array.isArray(r) || !r.length || r.length > RECENT || r[r.length - 1][0] !== header.height || r[r.length - 1][1] !== header.blockHash
    || r.some(([h, x], i) => !HEX64.test(x) || (i && h !== r[i - 1][0] + 1))) throw new Error('its recent block hashes are malformed');
}

/**
 * The newest checkpoint in `dir` that passes every check, rebuilt: { ix, header, file }, or null.
 *   meta       the running { stamp, network, cid, rulesInscriptionId, rulesHash, vkeyHash, startHeight }
 *   make()     a fresh engine
 *   hooks      the follower's hooks: reset, then restore(snapshot), for the file being tried
 *   onChain(header) -> boolean   are header.blockHash and header.recent still the best chain?
 *   maxHeight  files above it are not tried
 *   digest2(ix) optional: must equal the header's digest2 when the file has one
 *   log(msg)   why a file was not used
 */
export async function loadNewest({ dir, meta, make, hooks = [], onChain = null, maxHeight = Infinity, digest2 = null, log = () => {} }) {
  for (const c of listCheckpoints(dir)) {
    const name = path.basename(c.file);
    if (c.height > maxHeight) { log(`checkpoint ${name} not used: it is above block ${maxHeight}`); continue; }
    try {
      const { header, bodyText } = await readCheckpoint(c.file);
      checkMeta(header, meta, c);
      if (sealOf(header, bodyText) !== header.seal) throw new Error('the seal does not match the content');
      if (onChain && !(await onChain(header))) throw new Error('its block is no longer in the best chain');
      const body = JSON.parse(bodyText);
      const ix = restoreEngine(header, body, { make, startHeight: meta.startHeight });
      if (digest2 && header.digest2 !== undefined && digest2(ix) !== header.digest2) throw new Error('digest2 does not match');
      restoreHooks(hooks, body.hooks ?? {});
      return { ix, header, file: c.file };
    } catch (e) {
      log(`checkpoint ${name} not used: ${e.message}`);
    }
  }
  return null;
}
