// Shielded Ordinals v1 — the global registry: every shielded collection on Bitcoin, and a global
// piece number for every piece, the way ord numbers inscriptions. METADATA ONLY: nothing in the
// protocol's acceptance rules depends on it.
//
//   A collection = a parent inscription whose content is valid shord rules JSON.
//   Its number range is taken at its FIRST VALID MINT (so spam parents that never sell anything
//   can't burn numbers), in block order then tx order:
//     first collection to mint: #0 .. #supply-1, the next continues from supply, and so on
//     (numbering starts at 0, like ord's inscription numbers).
//   Global number of a piece = rangeStart + assetId.
//   Provenance tier of a piece = the first PROVENANCE_TIERS threshold its global number is under
//   (Sub 1K, Sub 10K, Sub 100K, Sub 1M): the same rule in every indexer, never a label a site makes up.
//   Numbering starts at REGISTRY_START[network] (the block of the first real launch), so earlier
//   test inscriptions don't count.
// Every indexer that replays the same blocks gets the same numbers.
import * as bitcoin from 'bitcoinjs-lib';
import { parseRules, collectionId } from './rules.mjs';
import { parseEnvelope, T, MAX_MINTS_PER_TX } from './envelope.mjs';
import { gateScript } from './scripts.mjs';
import { readInscriptions } from './inscribe.mjs';
import { toHex } from './core.mjs';
import { NameIndex, NAMES_START, readNameRecord } from './names.mjs';

// mainnet: the block before the Shielded Nakas parent (the 2026-09-26 mainnet test is earlier).
// Every indexer must count from the same block, or the global numbers differ.
export const REGISTRY_START = { mainnet: 969342, signet: 323966 };

/** Provenance tiers by global number: [upper bound (exclusive), label]. A piece is in the first tier
 *  whose bound it is under. */
export const PROVENANCE_TIERS = [[1000, 'Sub 1K'], [10000, 'Sub 10K'], [100000, 'Sub 100K'], [1000000, 'Sub 1M']];
export const provenanceTier = (globalNumber) => {
  if (!Number.isInteger(globalNumber) || globalNumber < 0) return null;
  const t = PROVENANCE_TIERS.find(([bound]) => globalNumber < bound);
  return t ? t[1] : null;
};

const ORD_MARK = Buffer.from([0x03, 0x6f, 0x72, 0x64]); // push "ord"
const SHORD = Buffer.from('SHORD');

/**
 * What the registry needs from one block (small enough to cache): shielded parent inscriptions, and
 * the txs carrying SHORD envelopes (the caller fills in each carrier input's prevout script).
 * Also the block's shielded name inscriptions (names.mjs), in tx order then inscription order.
 * Returns { parents: [{ id, txIndex, text }], carriers: [{ txIndex, txid, ins: [{ txid, vout }], outs }],
 *           names: [{ id, txIndex, name, label, to }] }.
 */
export function scanBlock(block) {
  const parents = [];
  const carriers = [];
  const names = [];
  block.transactions.forEach((t, txIndex) => {
    if (t.ins.some((i) => (i.witness ?? []).some((w) => w.length > 20 && w.includes(ORD_MARK)))) {
      let found = [];
      try { found = readInscriptions(t.toHex()); } catch { found = []; }
      for (const x of found) {
        if (!/^(application\/json|text\/plain)/.test(x.contentType ?? '')) continue;
        const text = Buffer.from(x.body ?? []).toString('utf8');
        if (!text.includes('"shord"')) continue;
        const name = readNameRecord(x.contentType, x.body);
        if (name) { names.push({ id: x.id, txIndex, ...name }); continue; }
        try { parseRules(text); } catch { continue; } // only valid rules make a collection
        parents.push({ id: x.id, txIndex, text });
      }
    }
    if (t.outs.some((o) => o.script[0] === bitcoin.opcodes.OP_RETURN && Buffer.from(o.script).includes(SHORD))) {
      carriers.push({
        txIndex, txid: t.getId(),
        ins: t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })),
        outs: t.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value })),
      });
    }
  });
  return { parents, carriers, names };
}

const opReturnPushes = (outs) => outs
  .filter((o) => o.script[0] === bitcoin.opcodes.OP_RETURN)
  .map((o) => { const c = bitcoin.script.decompile(o.script); return c && c.length === 2 && Buffer.isBuffer(c[1]) ? c[1] : null; })
  .filter(Boolean);

function pays(outs, demands) {
  const paid = new Map();
  for (const o of outs) paid.set(toHex(o.script), (paid.get(toHex(o.script)) ?? 0n) + BigInt(o.value));
  const need = new Map();
  for (const [s, v] of demands) need.set(toHex(s), (need.get(toHex(s)) ?? 0n) + BigInt(v));
  for (const [k, v] of need) if ((paid.get(k) ?? 0n) < v) return false;
  return true;
}

export class Registry {
  constructor(network) {
    this.network = network; // bitcoinjs network
    this.collections = new Map(); // cid hex -> { id, name, supply, height, rules, range: { start, end, height, txid } | null }
    this.next = 0;
    this.names = new NameIndex(NAMES_START[network?.bech32 === 'bc' ? 'mainnet' : 'signet'] ?? null); // shielded names: first inscription of a label wins
    this.lastHeight = null;
  }

  /** A first mint that the indexer would accept (gate coin spent, everything paid, ids in supply). */
  _validFirstMint(c, env, tx) {
    const R = c.rules;
    const mints = env.type === T.MINT ? [env] : env.mints;
    if (!mints.length || mints.length > MAX_MINTS_PER_TX) return false;
    const ids = mints.map((m) => m.assetId);
    if (ids.some((a) => a >= R.supply) || new Set(ids).size !== ids.length) return false;
    const gate = gateScript(R, this.network);
    if (!tx.ins.some((i) => i.script && Buffer.from(i.script).equals(gate))) return false;
    const n = BigInt(mints.length);
    const tickets = BigInt(mints.reduce((s, m) => s + m.ticketsBuy, 0));
    return pays(tx.outs, [[R.artistScript, n * BigInt(R.mintPrice)], [R.platformScript, n * BigInt(R.mintFee)],
      [R.relayerScript, n * BigInt(R.inscribeFee) + tickets * BigInt(R.ticketPrice)]]);
  }

  applyBlock(height, { parents, carriers, names }) {
    if (this.lastHeight !== null && height !== this.lastHeight + 1) throw new Error(`registry gap at ${height}`);
    this.names.apply(height, names); // already in tx order, then inscription order
    const items = [...parents.map((p) => ({ kind: 'parent', ...p })), ...carriers.map((c) => ({ kind: 'carrier', ...c }))]
      .sort((a, b) => a.txIndex - b.txIndex || (a.kind === 'parent' ? -1 : 1));
    for (const it of items) {
      if (it.kind === 'parent') {
        const cid = toHex(collectionId(it.id));
        if (!this.collections.has(cid)) {
          const rules = parseRules(it.text);
          this.collections.set(cid, { id: it.id, name: rules.name, supply: rules.supply, height, rules, range: null });
        }
        continue;
      }
      for (const data of opReturnPushes(it.outs)) {
        let env;
        try { env = parseEnvelope(data); } catch { continue; }
        if (!env || (env.type !== T.MINT && env.type !== T.MINTN)) continue;
        const c = this.collections.get(toHex(env.cid));
        if (!c || c.range || !this._validFirstMint(c, env, it)) continue;
        c.range = { start: this.next, end: this.next + c.supply - 1, height, txid: it.txid };
        this.next += c.supply;
      }
    }
    this.lastHeight = height;
  }

  /** Global number of a piece, or null until its collection's first mint. */
  globalNumber(cidHex, assetId) {
    const c = this.collections.get(cidHex);
    return c?.range ? c.range.start + assetId : null;
  }

  list() {
    return [...this.collections.entries()]
      .map(([cid, c]) => ({ cid, parent: c.id, name: c.name, supply: c.supply, launchedAt: c.height, range: c.range }))
      .sort((a, b) => (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity) || a.launchedAt - b.launchedAt);
  }
}
