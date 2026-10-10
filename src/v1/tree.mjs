// v1 append-only Poseidon Merkle tree (depth must match the circuits: 20).
//
// The layers are kept between calls. append() only notes where the new leaves start, and the next
// layers(), root() or path() hashes just the nodes above them (the right edge of every layer). A
// block with k new notes costs about k + depth hashes instead of a rebuild of the whole tree. The
// roots, layers and paths are exactly those of a full rebuild; test/tree.test.mjs checks this
// against the frozen full-rebuild tree in test/lib/tree-v0.mjs.
//
// The arrays that layers() returns and `leaves` are the tree's own state, and later calls update
// them in place: callers must not mutate them. Add leaves with append(), or replace all of them by
// assigning `leaves` (as Indexer.treeAt does on a fresh tree); that drops the layers, and the next
// call rebuilds them in full.
import { poseidon } from './core.mjs';

export const DEPTH = 20;

export class NoteTree {
  constructor(depth = DEPTH) {
    this.depth = depth;
    this._leaves = [];
    this._layers = null; // [leaves copy, ..., [root]] once built
    this._dirty = null; // first leaf whose ancestors are not hashed yet (null: layers are current)
    this.zeros = [0n];
    for (let i = 1; i <= depth; i++) this.zeros.push(poseidon([this.zeros[i - 1], this.zeros[i - 1]]));
  }
  get leaves() {
    return this._leaves;
  }
  set leaves(leaves) {
    this._leaves = leaves;
    this._layers = null;
    this._dirty = null;
  }
  append(leaf) {
    if (this._leaves.length >= 2 ** this.depth) throw new Error('note tree full');
    const pos = this._leaves.length;
    this._leaves.push(leaf);
    if (this._layers) {
      this._layers[0].push(leaf);
      this._dirty = Math.min(this._dirty ?? Infinity, pos);
    }
    return pos;
  }
  layers() {
    const layers = this._layers;
    // no layers yet, or the leaves were changed without append(): full build
    if (!layers || layers[0].length !== this._leaves.length) return this._build();
    if (this._dirty !== null) {
      const from = this._dirty;
      for (let d = 0; d < this.depth; d++) {
        const cur = layers[d];
        const next = layers[d + 1];
        const size = Math.ceil(cur.length / 2);
        // nodes left of the first dirty one keep their hash; writes run left to right from at most
        // next.length, so the array grows without holes
        for (let i = from >> (d + 1); i < size; i++) {
          next[i] = poseidon([cur[2 * i], 2 * i + 1 < cur.length ? cur[2 * i + 1] : this.zeros[d]]);
        }
        if (next.length > size) next.length = size;
      }
      this._dirty = null;
    }
    return layers;
  }
  _build() {
    const layers = [this._leaves.slice()];
    for (let d = 0; d < this.depth; d++) {
      const cur = layers[d];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(poseidon([cur[i], i + 1 < cur.length ? cur[i + 1] : this.zeros[d]]));
      }
      layers.push(next);
    }
    this._layers = layers;
    this._dirty = null;
    return layers;
  }
  root() {
    const top = this.layers()[this.depth];
    return top.length ? top[0] : this.zeros[this.depth];
  }
  path(pos) {
    const layers = this.layers();
    const pathElements = [];
    const pathIndices = [];
    let idx = pos;
    for (let d = 0; d < this.depth; d++) {
      const sib = idx ^ 1;
      pathElements.push(sib < layers[d].length ? layers[d][sib] : this.zeros[d]);
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  }
  // an independent copy: appends to either one never change the other
  clone() {
    const t = new NoteTree(this.depth);
    t._leaves = this._leaves.slice();
    if (this._layers) {
      t._layers = this._layers.map((layer) => layer.slice());
      t._dirty = this._dirty;
    }
    return t;
  }
}
