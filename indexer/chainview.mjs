// One view of the chain for every follower in the indexer (the registry and each collection), backed
// by a persistent, linked index of block hashes. A restart asks the chain source about 2 questions
// instead of one per block, and an idle round asks 2 (the tip, and one batch of hashes).
//
//   <CACHE_DIR>/<network>-hashes.json   [[height, hash, prevHash], ...] from the first block any
//                                        follower reads. An entry is kept only if its prevHash is the
//                                        hash of the entry before it, so the file is one chain: when
//                                        its top block is in the best chain, every block under it is.
//
// Each sync round (newRound()) the first question about a block brings the index up to the tip:
//   - it checks the index's top block against the source (the first round after a start: the last
//     12), with the source's batched hashesFrom (esplora /blocks/<h>: 10 blocks a call);
//   - after a reorg it walks back in batches to the last block that still matches, drops every entry
//     above it, and carries on from there;
//   - it appends the new blocks up to the tip, each one linked to the one before.
// After that every hashAt(h) is answered from memory: a replay from the block cache asks the source
// nothing, and a follower's reorg check (src/v1/follow.mjs stillOnChain) needs only its last block.
//
// chainView({ source, file, base, stop }) returns a source for follow.mjs (makeSource's shape) with:
//   linked: true      every hash it gives builds on the one under it
//   tipHeight()       the round's tip (at most `stop`, STOP_HEIGHT)
//   hashAt(h)         the hash of block h in the best chain; null above the round's tip
//   knownHash(h)      the same from memory only (no waiting, no request): the index entry or null
//   newRound()        forget the tip: the next question checks the index against the source again
//   index()           { start, top, size } of the index (tests, logs)
import fs from 'node:fs';
import path from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;
const VERIFY = 12; // blocks checked against the source on the first round after a start

/** The index file: the linked run of entries from its first one, stopping at the first entry that
 *  does not follow the one before it. A file that starts above `base` is not used. */
export function loadHashIndex(file, base, log = () => {}) {
  const idx = { start: null, hashes: [], prevs: [] };
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return idx; }
  if (!Array.isArray(rows)) return idx;
  for (const [i, r] of rows.entries()) {
    const ok = Array.isArray(r) && r.length === 3 && Number.isSafeInteger(r[0]) && HEX64.test(r[1]) && typeof r[2] === 'string';
    if (ok && idx.start === null && r[0] <= base) { idx.start = r[0]; idx.hashes.push(r[1]); idx.prevs.push(r[2]); continue; }
    if (ok && idx.start !== null && r[0] === idx.start + idx.hashes.length && r[2] === idx.hashes[idx.hashes.length - 1]) { idx.hashes.push(r[1]); idx.prevs.push(r[2]); continue; }
    log(`block hash index: entry ${i} (${Array.isArray(r) ? r[0] : '?'}) does not follow the one before it; the index stops there`);
    break;
  }
  return idx;
}

export function chainView({ source, file, base, stop = null, log = (m) => console.error(m) }) {
  if (typeof source.hashesFrom !== 'function') throw new Error('the chain source has no hashesFrom');
  const idx = loadHashIndex(file, base, log);
  let verified = false; // the first round checks the last VERIFY entries, later rounds only the top
  let tip = null;
  let tipP = null;
  let ready = null;
  let dirty = false; // the index differs from the file
  const below = new Map(); // heights under the index (a follower that starts earlier than `base`)

  const size = () => idx.hashes.length;
  const top = () => (size() ? idx.start + size() - 1 : null);
  const at = (h) => (size() && h >= idx.start && h <= top() ? idx.hashes[h - idx.start] : null);
  const truncate = (h) => { const keep = Math.max(0, h - idx.start + 1); idx.hashes.length = keep; idx.prevs.length = keep; if (!keep) idx.start = null; dirty = true; };
  const push = ([h, hash, prev]) => {
    dirty = true;
    if (!size()) { idx.start = h; idx.hashes.push(hash); idx.prevs.push(prev); return; }
    if (h !== top() + 1) throw new Error(`block hash index: block ${h} does not follow block ${top()}`);
    if (prev !== at(h - 1)) throw new Error(`block hash index: block ${h} does not build on block ${h - 1}; the chain changed while it was read, trying again next round`);
    idx.hashes.push(hash);
    idx.prevs.push(prev);
  };
  const save = () => {
    const rows = idx.hashes.map((hash, i) => [idx.start + i, hash, idx.prevs[i]]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(rows));
    fs.renameSync(file + '.tmp', file);
    dirty = false;
  };

  const tipHeight = () => (tipP ??= source.tipHeight().then((t) => (tip = stop === null ? t : Math.min(t, stop))).catch((e) => { tipP = null; throw e; }));

  // the source's view of [lo .. hi] (hi <= t) added to `got` (height -> [hash, prev]): one batch for
  // each run of heights it does not hold yet
  async function fetchRange(lo, hi, t, got = new Map()) {
    for (let x = lo; x <= hi; x++) {
      if (got.has(x)) continue;
      for (const [h, hash, prev] of await source.hashesFrom(x, t)) got.set(h, [hash, prev]);
      if (!got.has(x)) throw new Error(`the chain source returned no block at ${x}`);
    }
    return got;
  }

  async function refresh() {
    const t = await tipHeight();
    if (size() ? t < idx.start : t < base) return; // nothing to check or add yet
    let got = new Map();
    if (size()) {
      const T = Math.min(top(), t);
      let lo = verified ? T : Math.max(idx.start, T - VERIFY + 1);
      let hi = T;
      got = await fetchRange(lo, hi, t);
      // the highest block in [lo .. hi] where the index and the source agree; walk back while none does
      let m = null;
      for (;;) {
        for (let h = hi; h >= lo && m === null; h--) if (got.get(h)?.[0] === at(h)) m = h;
        if (m !== null || lo <= idx.start) break;
        hi = lo - 1;
        lo = Math.max(idx.start, hi - 9);
        log(`block hash index: block ${hi + 1} is no longer in the best chain; looking further back`);
        got = await fetchRange(lo, hi, t, got);
      }
      if (m === null) { log('block hash index: no block in it is in the best chain; starting it again'); truncate(idx.start - 1); }
      else if (m < top() && got.has(m + 1)) { log(`block hash index: the best chain changed after block ${m}`); truncate(m); }
    }
    if (!size()) {
      if (t < base) { save(); return; }
      got = await fetchRange(base, base, t, got);
      const first = got.get(base);
      push([base, first[0], first[1]]);
    }
    // what the checks already fetched, then batches of 10 up to the tip
    for (let h = top() + 1; h <= t && got.has(h); h++) push([h, ...got.get(h)]);
    while (top() < t) {
      const was = top();
      for (const r of await source.hashesFrom(was + 1, t)) if (r[0] === top() + 1) push(r);
      if (top() === was) throw new Error(`the chain source returned no block at ${was + 1}`);
    }
    verified = true;
    if (dirty) save();
  }

  return {
    ...source,
    linked: true,
    tipHeight,
    async hashAt(h) {
      await (ready ??= refresh().catch((e) => { ready = null; throw e; }));
      if (h > tip) return null;
      const x = at(h);
      if (x) return x;
      if (size() && h >= idx.start) return null;
      // under the index: asked once, kept for the process
      if (!below.has(h)) below.set(h, source.hashAt(h).catch((e) => { below.delete(h); throw e; }));
      return below.get(h);
    },
    knownHash: (h) => (tip !== null && h > tip ? null : at(h)),
    newRound() { tip = null; tipP = null; ready = null; },
    index: () => ({ start: idx.start, top: top(), size: size() }),
  };
}
