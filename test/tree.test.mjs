// The incremental NoteTree (src/v1/tree.mjs) against the frozen full-rebuild tree it replaced
// (test/lib/tree-v0.mjs): same roots, layers and paths after every batch of appends. Offline.
//   node test/tree.test.mjs
import { performance } from 'node:perf_hooks';
import { NoteTree, DEPTH } from '../src/v1/tree.mjs';
import { NoteTree as TreeV0 } from './lib/tree-v0.mjs';

let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); ok ? pass++ : fail++; };

// fixed-seed PRNG (mulberry32), so every run sees the same sequences
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (r, n) => Math.floor(r() * n); // 0 .. n-1
// a random 248-bit leaf: always below the BN254 field modulus
const leaf = (r) => { let x = 0n; for (let i = 0; i < 8; i++) x = (x << 31n) | BigInt(int(r, 2 ** 31)); return x; };

const sameLayers = (a, b) => a.length === b.length && a.every((l, d) => l.length === b[d].length && l.every((v, i) => v === b[d][i]));
const samePath = (a, b) => a.pathIndices.length === b.pathIndices.length
  && a.pathIndices.every((v, i) => v === b.pathIndices[i]) && a.pathElements.every((v, i) => v === b.pathElements[i]);
const v0Of = (leaves, depth = DEPTH) => { const t = new TreeV0(depth); t.leaves = leaves.slice(); return t; };

// 1. random append batches against tree-v0, after every batch
function randomRun(seed, depth, minLeaves, maxBatch) {
  const r = rng(seed);
  const t = new NoteTree(depth);
  const ref = new TreeV0(depth);
  const cap = 2 ** depth;
  let steps = 0, rootsBad = 0, layersBad = 0, pathsBad = 0, posBad = 0, paths = 0;
  while (t.leaves.length < minLeaves && t.leaves.length < cap) {
    const n = Math.min(int(r, maxBatch + 1), cap - t.leaves.length);
    for (let i = 0; i < n; i++) {
      const x = leaf(r);
      const pos = t.append(x);
      if (pos !== ref.append(x)) posBad++;
    }
    // vary which call sees the new leaves first: root(), layers() or path()
    const first = int(r, 3);
    const len = t.leaves.length;
    const firstPath = len ? int(r, len) : 0;
    if (first === 2 && !samePath(t.path(firstPath), ref.path(firstPath))) pathsBad++;
    if (first === 1 && !sameLayers(t.layers(), ref.layers())) layersBad++;
    if (t.root() !== ref.root()) rootsBad++;
    if (first !== 1 && !sameLayers(t.layers(), ref.layers())) layersBad++;
    const want = len ? [0, len - 1, ...Array.from({ length: 48 }, () => int(r, len))] : Array.from({ length: 50 }, () => int(r, 64));
    for (const pos of want) { paths++; if (!samePath(t.path(pos), ref.path(pos))) pathsBad++; }
    steps++;
  }
  return { t, ref, steps, leaves: t.leaves.length, rootsBad, layersBad, pathsBad, posBad, paths };
}

let a0 = performance.now();
const big = randomRun(20251010, DEPTH, 5001, 300);
check(`depth ${DEPTH}, seed 20251010: ${big.steps} batches of 0-300 to ${big.leaves} leaves, root() equals tree-v0 after every batch`, big.leaves > 5000 && big.rootsBad === 0);
check('  layers() equals tree-v0 after every batch', big.layersBad === 0);
check(`  path(pos) equals tree-v0 at 50 positions per batch (${big.paths} paths)`, big.pathsBad === 0);
check('  append() returns the same positions', big.posBad === 0);
console.log(`      (${((performance.now() - a0) / 1000).toFixed(1)} s, most of it the tree-v0 rebuilds)`);

a0 = performance.now();
const small = randomRun(7, 10, 2 ** 10, 300);
check(`depth 10, seed 7: ${small.steps} batches to a full tree of ${small.leaves} leaves, roots, layers and paths equal tree-v0`,
  small.leaves === 1024 && small.rootsBad + small.layersBad + small.pathsBad + small.posBad === 0);
const tiny = randomRun(99, 6, 2 ** 6, 5);
check(`depth 6, seed 99: ${tiny.steps} batches of 0-5 to a full tree, roots, layers and paths equal tree-v0`,
  tiny.leaves === 64 && tiny.rootsBad + tiny.layersBad + tiny.pathsBad + tiny.posBad === 0);
console.log(`      (${((performance.now() - a0) / 1000).toFixed(1)} s)`);

// 2. treeAt-style `leaves` assignment, and clones
{
  const src = big.t;
  for (const k of [0, 1, 2, 3, 1000, 1001]) {
    const t = new NoteTree(DEPTH);
    t.leaves = src.leaves.slice(0, k);
    const ref = v0Of(src.leaves.slice(0, k));
    const pos = [0, 1, Math.max(0, k - 1), k, int(rng(k + 1), Math.max(1, k))];
    check(`treeAt-style leaves assignment of ${k} leaves on a fresh tree: root, layers and paths equal tree-v0`,
      t.root() === ref.root() && sameLayers(t.layers(), ref.layers()) && pos.every((p) => samePath(t.path(p), ref.path(p))));
  }

  // assignment on a tree that already has layers drops them (tree-v0 would keep stale ones)
  const t = new NoteTree(DEPTH);
  for (const x of src.leaves.slice(0, 40)) t.append(x);
  t.root();
  t.leaves = src.leaves.slice(100, 133);
  check('assigning leaves to a tree with layers rebuilds from the new leaves', t.root() === v0Of(src.leaves.slice(100, 133)).root());
  for (const x of src.leaves.slice(200, 211)) t.append(x);
  const after = [...src.leaves.slice(100, 133), ...src.leaves.slice(200, 211)];
  check('  and later appends stay incremental and equal tree-v0', t.root() === v0Of(after).root() && sameLayers(t.layers(), v0Of(after).layers()));
  t.leaves = src.leaves.slice(300, 344); // the same count as before, other leaves
  check('  assigning as many leaves as it had, but other ones, also rebuilds', t.leaves.length === after.length && t.root() === v0Of(src.leaves.slice(300, 344)).root());

  // the leaves changed without append(): the next call does a full build, as tree-v0 would from scratch
  const u = new NoteTree(DEPTH);
  for (const x of src.leaves.slice(0, 50)) u.append(x);
  u.root();
  u.leaves.push(src.leaves[50], src.leaves[51]);
  check('leaves pushed without append() are still hashed (full rebuild)', u.root() === v0Of(src.leaves.slice(0, 52)).root());

  // clones
  const base = new NoteTree(DEPTH);
  for (const x of src.leaves.slice(0, 300)) base.append(x);
  const root300 = base.root();
  const layers300 = base.layers().map((l) => l.slice());
  const c = base.clone();
  const cLayers = c.layers(); // read before the original changes, compared after without calling c again
  check('a clone owns its arrays (no leaves or layer array is shared with the original)',
    c.leaves !== base.leaves && cLayers !== base.layers() && cLayers.every((l, d) => l !== base.layers()[d]));
  for (const x of src.leaves.slice(300, 340)) base.append(x);
  base.root();
  check('a clone does not change when the original gets new appends',
    sameLayers(cLayers, layers300) && c.leaves.length === 300 && c.root() === root300 && sameLayers(c.layers(), layers300));
  check('  and the original has the new leaves', base.root() === v0Of(src.leaves.slice(0, 340)).root());
  const rootBase = base.root();
  for (const x of src.leaves.slice(500, 520)) c.append(x);
  check('the original does not change when the clone gets new appends', base.root() === rootBase && base.leaves.length === 340);
  check('  and the clone equals tree-v0 on its own leaves', c.root() === v0Of([...src.leaves.slice(0, 300), ...src.leaves.slice(500, 520)]).root());

  const dirty = new NoteTree(DEPTH);
  for (const x of src.leaves.slice(0, 70)) dirty.append(x);
  dirty.root();
  for (const x of src.leaves.slice(70, 90)) dirty.append(x); // not hashed yet
  const dc = dirty.clone();
  for (const x of src.leaves.slice(90, 95)) dirty.append(x);
  check('a clone taken between an append and the next root() has the right root',
    dc.root() === v0Of(src.leaves.slice(0, 90)).root() && dirty.root() === v0Of(src.leaves.slice(0, 95)).root());
  const fresh = new NoteTree(DEPTH);
  for (const x of src.leaves.slice(0, 9)) fresh.append(x);
  const fc = fresh.clone(); // no layers built yet
  fresh.append(src.leaves[9]);
  check('a clone of a tree whose layers were never built is independent', fc.root() === v0Of(src.leaves.slice(0, 9)).root() && fresh.root() === v0Of(src.leaves.slice(0, 10)).root());
}

// 3. empty trees and a full tree
{
  const e = new NoteTree(DEPTH);
  const ref = new TreeV0(DEPTH);
  check(`an empty tree's root is zeros[${DEPTH}] and equals tree-v0`, e.root() === e.zeros[DEPTH] && e.root() === ref.root() && e.zeros.every((z, i) => z === ref.zeros[i]));
  check('an empty tree\'s layers and path(0) equal tree-v0', sameLayers(e.layers(), ref.layers()) && samePath(e.path(0), ref.path(0)));
  const r = rng(3);
  const x = leaf(r);
  e.append(x); ref.append(x);
  check('the first append after an empty root() equals tree-v0', e.root() === ref.root() && samePath(e.path(0), ref.path(0)));

  const s = new NoteTree(3);
  const sref = new TreeV0(3);
  check('an empty depth-3 tree\'s root is zeros[3]', s.root() === s.zeros[3] && s.root() === sref.root());
  let ok = true;
  for (let i = 0; i < 8; i++) { const y = leaf(r); if (s.append(y) !== i) ok = false; sref.append(y); if (i % 3 === 0 && s.root() !== sref.root()) ok = false; }
  const fullRoot = s.root();
  let msg = null;
  try { s.append(leaf(r)); } catch (err) { msg = err.message; }
  check('a depth-3 tree takes 8 leaves, then append() throws \'note tree full\'', ok && msg === 'note tree full');
  check('  and the full tree is unchanged by the refused append', s.leaves.length === 8 && s.root() === fullRoot && fullRoot === sref.root() && sameLayers(s.layers(), sref.layers()));
}

// 4. speed: one more leaf on a tree of today's size
{
  const r = rng(7034);
  const t = new NoteTree(DEPTH);
  t.leaves = Array.from({ length: 7034 }, () => leaf(r));
  let a = performance.now();
  t.root();
  const build = performance.now() - a;
  t.append(leaf(r)); t.root(); // warm the incremental path
  const ms = [];
  for (let i = 0; i < 9; i++) {
    const x = leaf(r);
    a = performance.now();
    t.append(x);
    t.root();
    ms.push(performance.now() - a);
  }
  const sorted = ms.slice().sort((x, y) => x - y);
  console.log(`      (full build of 7,034 leaves ${build.toFixed(0)} ms; append 1 + root(): ${ms.map((x) => x.toFixed(1)).join(', ')} ms)`);
  check('at 7,034 leaves, appending 1 leaf and calling root() takes under 20 ms', sorted[4] < 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
