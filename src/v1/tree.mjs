// v1 append-only Poseidon Merkle tree (depth must match the circuits: 20).
import { poseidon } from './core.mjs';

export const DEPTH = 20;

export class NoteTree {
  constructor(depth = DEPTH) {
    this.depth = depth;
    this.leaves = [];
    this.zeros = [0n];
    for (let i = 1; i <= depth; i++) this.zeros.push(poseidon([this.zeros[i - 1], this.zeros[i - 1]]));
  }
  append(leaf) {
    if (this.leaves.length >= 2 ** this.depth) throw new Error('note tree full');
    this.leaves.push(leaf);
    this._layers = null;
    return this.leaves.length - 1;
  }
  layers() {
    if (this._layers) return this._layers;
    const layers = [this.leaves.slice()];
    for (let d = 0; d < this.depth; d++) {
      const cur = layers[d];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(poseidon([cur[i], i + 1 < cur.length ? cur[i + 1] : this.zeros[d]]));
      }
      layers.push(next);
    }
    this._layers = layers;
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
  clone() {
    const t = new NoteTree(this.depth);
    t.leaves = this.leaves.slice();
    return t;
  }
}
