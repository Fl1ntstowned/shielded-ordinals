// Shielded Ordinals v1 — the indexer. Deterministic replay of Bitcoin blocks for ONE collection.
// Two honest indexers fed the same blocks reach the same tree, nullifier set, listings and roots.
//
// A tx is { txid, ins: [{ txid, vout, script }], outs: [{ script, value }] } where ins[].script is
// the scriptPubKey of the coin being spent (needed for the mint-gate rule).
//
// Acceptance rules
//   every envelope   cid must match this collection (other cids are ignored, not rejected)
//   paid envelopes   MINT, BUY, and TRANSFER/LIST with buy > 0. At most ONE per tx; its payments
//                    are checked against the tx outputs, summed per scriptPubKey.
//   MINT             spends a P2TR(gateKey) coin; assetId < supply and never minted;
//                    pays mintPrice -> artist, mintFee -> platform, inscribeFee + k*ticketPrice -> relayer
//                    payout (= the platform script unless the rules name a separate relayer script).
//   MINTN            batch of 1..20 MINTs in one envelope: one gate coin; pays count*mintPrice ->
//                    artist, count*mintFee + all tickets -> platform; already-minted pieces skipped.
//   TRANSFER         anchor in [H-100, H-1]; nullifier unseen; Groth16 (mode 0) verifies.
//   LIST             same, mode 1; the tx must create the listing lock P2TR(lockKey, returnKey leaf).
//   BUY              listing ACTIVE and this tx spends its lock; pays price -> seller script,
//                    saleFee + k*ticketPrice -> platform. The buyer's note keeps the piece's tickets + k.
//   CLAIM            listing CLOSED (lock spent without a sale), or ACTIVE and this tx spends the lock;
//                    BIP340 signature by the listing's returnKey. Returns the piece as a new note.
//   lock spent by a tx with no valid BUY -> listing CLOSED (cancelled; the seller CLAIMs it back).
import * as snarkjs from 'snarkjs';
import * as bitcoin from 'bitcoinjs-lib';
import { NoteTree } from './tree.mjs';
import { noteCommitment, schnorrVerify, toHex } from './core.mjs';
import { parseEnvelope, MAGIC, T, TYPE_NAME } from './envelope.mjs';
import { collectionId, saleFee, dustFor, vkeyHash, MAX_TICKETS_PER_BUY, DEPTH, ANCHOR_WINDOW, K_MIN } from './rules.mjs';
import { gateScript, lockScript } from './scripts.mjs';

export { DEPTH, ANCHOR_WINDOW, K_MIN };


export const outpointKey = (txid, vout) => `${txid}:${vout}`;

// OP_RETURN outputs whose single push starts with SHORD, in output order.
export function envelopesOf(tx) {
  const found = [];
  tx.outs.forEach((o, vout) => {
    const script = Buffer.from(o.script);
    if (script[0] !== bitcoin.opcodes.OP_RETURN) return;
    const chunks = bitcoin.script.decompile(script);
    if (!chunks || chunks.length !== 2 || !Buffer.isBuffer(chunks[1])) return;
    if (chunks[1].subarray(0, 5).equals(MAGIC)) found.push({ vout, data: chunks[1] });
  });
  return found;
}

export class Indexer {
  // rulesInscriptionId + rules pin the collection (the deployment profile). In production the
  // indexer reads the parent inscription's content itself and parses it with parseRules().
  constructor({ rulesInscriptionId, rules, network = bitcoin.networks.bitcoin, vkey }) {
    this.rulesInscriptionId = rulesInscriptionId;
    this.rules = rules;
    this.network = network;
    this.cid = collectionId(rulesInscriptionId);
    this.gateScript = gateScript(rules, network);
    if (!vkey) throw new Error('spend verification key required');
    if (rules.spendVkeyHash && vkeyHash(vkey) !== rules.spendVkeyHash) throw new Error('this verification key is not the one the collection pinned (spendVkeyHash)');
    this.vkey = vkey;
    this.tree = new NoteTree(DEPTH);
    this.nullifiers = new Set();
    this.roots = new Map(); // height -> root after that block
    this.leafCounts = new Map();
    this.notes = []; // { pos, cm, epk, ct, txid, height, kind }
    this.minted = new Map(); // assetId -> { txid, height }
    this.listings = new Map(); // listingNf -> listing
    this.lockIndex = new Map(); // "txid:vout" -> listingNf (ACTIVE listings only)
    this.lastHeight = null;
    this.log = [];
  }

  async applyBlock(height, txs) {
    if (this.lastHeight !== null && height !== this.lastHeight + 1) throw new Error(`replay gap at ${height}`);
    for (const tx of txs) await this._applyTx(height, tx);
    this.roots.set(height, this.tree.root());
    this.leafCounts.set(height, this.tree.leaves.length);
    this.lastHeight = height;
  }

  async _applyTx(height, tx) {
    // listings whose lock this tx spends
    const spentLocks = new Set();
    for (const i of tx.ins) {
      const nf = this.lockIndex.get(outpointKey(i.txid, i.vout));
      if (nf !== undefined) spentLocks.add(nf);
    }

    const parsed = [];
    for (const { vout, data } of envelopesOf(tx)) {
      let env;
      try {
        env = parseEnvelope(data);
      } catch (e) {
        this._reject(height, tx.txid, vout, null, 'parse: ' + e.message);
        continue;
      }
      if (!env || !env.cid.equals(this.cid)) continue;
      parsed.push({ vout, env });
    }

    const isPaid = (e) => e.type === T.MINT || e.type === T.MINTN || e.type === T.BUY || ((e.type === T.TRANSFER || e.type === T.LIST) && e.buy > 0);
    const paidCount = parsed.filter((p) => isPaid(p.env)).length;
    const sold = new Set();
    const txNullifiers = new Set();

    for (const { vout, env } of parsed) {
      let r;
      if (isPaid(env) && paidCount > 1) r = { ok: false, reason: 'more than one paid envelope in the tx' };
      else r = await this._apply(height, tx, env, { spentLocks, sold, txNullifiers });
      if (r.ok) this.log.push({ height, txid: tx.txid, vout, type: TYPE_NAME[env.type], accepted: true, ...r.info });
      else this._reject(height, tx.txid, vout, env.type, r.reason);
    }

    // a lock spent without a sale cancels the listing; the seller CLAIMs the piece back
    for (const nf of spentLocks) {
      const l = this.listings.get(nf);
      this.lockIndex.delete(outpointKey(l.lock.txid, l.lock.vout));
      if (l.state === 'ACTIVE' && !sold.has(nf)) {
        l.state = 'CLOSED';
        l.closedTxid = tx.txid;
        this.log.push({ height, txid: tx.txid, type: 'LOCK_SPENT', accepted: true, listing: String(nf).slice(0, 16), closed: true });
      }
    }
  }

  _reject(height, txid, vout, type, reason) {
    this.log.push({ height, txid, vout, type: type ? TYPE_NAME[type] : undefined, accepted: false, reason });
  }

  // sum outputs per scriptPubKey, then require each demanded amount
  _pays(tx, demands) {
    const paid = new Map();
    for (const o of tx.outs) {
      const k = toHex(o.script);
      paid.set(k, (paid.get(k) ?? 0n) + BigInt(o.value));
    }
    const need = new Map();
    for (const [script, amt] of demands) {
      const k = toHex(script);
      need.set(k, (need.get(k) ?? 0n) + BigInt(amt));
    }
    for (const [k, amt] of need) if ((paid.get(k) ?? 0n) < amt) return false;
    return true;
  }

  _anchorOk(height, a) {
    return a <= height - K_MIN && a >= height - ANCHOR_WINDOW && this.roots.has(a);
  }

  async _verify(pub, proof) {
    try {
      return await snarkjs.groth16.verify(this.vkey, pub.map(String), proof);
    } catch {
      return false;
    }
  }

  async _apply(height, tx, env, ctx) {
    const R = this.rules;
    const tix = (k) => BigInt(k) * BigInt(R.ticketPrice);

    if (env.type === T.MINT) {
      if (env.assetId >= R.supply) return { ok: false, reason: 'assetId beyond supply' };
      if (this.minted.has(env.assetId)) return { ok: false, reason: 'already minted' };
      if (env.ticketsBuy > MAX_TICKETS_PER_BUY) return { ok: false, reason: 'too many tickets' };
      if (!tx.ins.some((i) => i.script && Buffer.from(i.script).equals(this.gateScript))) return { ok: false, reason: 'no mint gate input' };
      const demands = [[R.artistScript, R.mintPrice], [R.platformScript, R.mintFee], [R.relayerScript, BigInt(R.inscribeFee) + tix(env.ticketsBuy)]];
      if (!this._pays(tx, demands)) return { ok: false, reason: 'mint payouts missing' };
      if (ctx.dry) return { ok: true, info: { assetIds: [env.assetId] } };
      this.minted.set(env.assetId, { txid: tx.txid, height });
      this._addNote(noteCommitment(env.assetId, env.ticketsBuy, env.inner), env, tx.txid, height, 'mint');
      return { ok: true, info: { assetId: env.assetId } };
    }

    // Batch mint: the whole batch is paid for (count × price, count × fee, every ticket) and gated
    // by one gate coin. A piece someone else already minted is skipped rather than failing the
    // batch, so the buyer still gets every other piece they paid for.
    if (env.type === T.MINTN) {
      const ids = env.mints.map((e) => e.assetId);
      if (ids.some((a) => a >= R.supply)) return { ok: false, reason: 'assetId beyond supply' };
      if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate piece in batch' };
      if (env.mints.some((e) => e.ticketsBuy > MAX_TICKETS_PER_BUY)) return { ok: false, reason: 'too many tickets' };
      if (!tx.ins.some((i) => i.script && Buffer.from(i.script).equals(this.gateScript))) return { ok: false, reason: 'no mint gate input' };
      const n = BigInt(env.mints.length);
      const tickets = env.mints.reduce((s, e) => s + e.ticketsBuy, 0);
      const demands = [[R.artistScript, n * BigInt(R.mintPrice)], [R.platformScript, n * BigInt(R.mintFee)],
        [R.relayerScript, n * BigInt(R.inscribeFee) + tix(tickets)]];
      if (!this._pays(tx, demands)) return { ok: false, reason: 'mint payouts missing' };
      const fresh = env.mints.filter((e) => !this.minted.has(e.assetId));
      if (!fresh.length) return { ok: false, reason: 'already minted' };
      if (ctx.dry) return { ok: true, info: { assetIds: fresh.map((e) => e.assetId), skipped: ids.filter((a) => this.minted.has(a)) } };
      for (const e of fresh) {
        this.minted.set(e.assetId, { txid: tx.txid, height });
        this._addNote(noteCommitment(e.assetId, e.ticketsBuy, e.inner), e, tx.txid, height, 'mint');
      }
      const skipped = ids.filter((a) => !fresh.some((e) => e.assetId === a));
      return { ok: true, info: { assetIds: fresh.map((e) => e.assetId), ...(skipped.length ? { skipped } : {}) } };
    }

    if (env.type === T.TRANSFER || env.type === T.LIST) {
      if (!this._anchorOk(height, env.hanchor)) return { ok: false, reason: `anchor ${env.hanchor} outside window` };
      if (this.nullifiers.has(env.nf) || ctx.txNullifiers.has(env.nf)) return { ok: false, reason: 'double spend (nullifier seen)' };
      const isList = env.type === T.LIST;
      if (isList && env.assetId >= R.supply) return { ok: false, reason: 'assetId beyond supply' };
      if (isList && env.price < BigInt(dustFor(env.sellerScript))) return { ok: false, reason: 'price below dust' };
      if (env.buy > MAX_TICKETS_PER_BUY) return { ok: false, reason: 'too many tickets' };
      const pub = [this.roots.get(env.hanchor), env.nf, env.hbody, isList ? 0n : env.cmOut, env.spend, env.buy,
        isList ? 1 : 0, isList ? env.assetId : 0, isList ? env.tickets : 0];
      if (env.buy > 0 && !this._pays(tx, [[R.relayerScript, tix(env.buy)]])) return { ok: false, reason: 'ticket payment missing' };
      let lockVout = -1;
      if (isList) {
        const lock = lockScript(R, env.returnKey, this.network);
        lockVout = tx.outs.findIndex((o) => Buffer.from(o.script).equals(lock));
        if (lockVout < 0) return { ok: false, reason: 'listing lock output missing' };
      }
      if (!(await this._verify(pub, env.proof))) return { ok: false, reason: 'proof invalid' };
      if (ctx.dry) return { ok: true, info: isList ? { assetId: env.assetId } : {} };
      this.nullifiers.add(env.nf);
      ctx.txNullifiers.add(env.nf);
      if (!isList) {
        this._addNote(env.cmOut, env, tx.txid, height, 'transfer');
        return { ok: true, info: {} };
      }
      const listing = {
        nf: env.nf, assetId: env.assetId, tickets: env.tickets, price: env.price, sellerScript: env.sellerScript,
        returnKey: env.returnKey, lock: { txid: tx.txid, vout: lockVout, value: Number(tx.outs[lockVout].value) }, state: 'ACTIVE', height,
      };
      this.listings.set(env.nf, listing);
      this.lockIndex.set(outpointKey(tx.txid, lockVout), env.nf);
      return { ok: true, info: { assetId: env.assetId, price: String(env.price) } };
    }

    if (env.type === T.BUY) {
      const l = this.listings.get(env.listingNf);
      if (!l || l.state !== 'ACTIVE') return { ok: false, reason: 'listing not active' };
      if (!ctx.spentLocks.has(env.listingNf)) return { ok: false, reason: 'buy does not spend the listing lock' };
      if (ctx.sold.has(env.listingNf)) return { ok: false, reason: 'listing already sold in this tx' };
      if (env.ticketsBuy > MAX_TICKETS_PER_BUY) return { ok: false, reason: 'too many tickets' };
      const demands = [[l.sellerScript, l.price], [R.platformScript, saleFee(R, l.price)], [R.relayerScript, tix(env.ticketsBuy)]];
      if (!this._pays(tx, demands)) return { ok: false, reason: 'sale payouts missing' };
      if (ctx.dry) return { ok: true, info: { assetId: l.assetId, listingNf: l.nf } };
      l.state = 'SOLD';
      l.soldTxid = tx.txid;
      ctx.sold.add(env.listingNf);
      this._addNote(noteCommitment(l.assetId, l.tickets + env.ticketsBuy, env.inner), env, tx.txid, height, 'buy');
      return { ok: true, info: { assetId: l.assetId, price: String(l.price) } };
    }

    if (env.type === T.CLAIM) {
      const l = this.listings.get(env.listingNf);
      if (!l) return { ok: false, reason: 'no such listing' };
      const closing = l.state === 'ACTIVE' && ctx.spentLocks.has(env.listingNf);
      if (l.state !== 'CLOSED' && !closing) return { ok: false, reason: `listing is ${l.state}` };
      if (env.spend > l.tickets) return { ok: false, reason: 'no ticket left' };
      if (!schnorrVerify(env.sig, env.sigHash, l.returnKey)) return { ok: false, reason: 'bad return-key signature' };
      if (ctx.dry) return { ok: true, info: { assetId: l.assetId, listingNf: l.nf } };
      l.state = 'CLAIMED';
      l.claimTxid = tx.txid;
      this._addNote(noteCommitment(l.assetId, l.tickets - env.spend, env.inner), env, tx.txid, height, 'claim');
      return { ok: true, info: { assetId: l.assetId } };
    }
    return { ok: false, reason: 'unknown type' };
  }

  // Read-only: what would happen if `tx` were mined in the next block? Every envelope for this
  // collection is checked exactly as applyBlock would, without changing any state. A co-signer
  // runs this on its OWN indexer before it signs a mint gate or a listing lock.
  // Returns { envelopes: [{ type, ok, reason, info }], paid: count of paid envelopes, spentLocks }.
  async wouldAccept(tx, height = this.lastHeight + 1) {
    const spentLocks = new Set();
    for (const i of tx.ins) {
      const nf = this.lockIndex.get(outpointKey(i.txid, i.vout));
      if (nf !== undefined) spentLocks.add(nf);
    }
    const envs = [];
    for (const { data } of envelopesOf(tx)) {
      let env;
      try { env = parseEnvelope(data); } catch (e) { envs.push({ ok: false, reason: 'parse: ' + e.message }); continue; }
      if (env && env.cid.equals(this.cid)) envs.push({ env });
    }
    const isPaid = (e) => e.type === T.MINT || e.type === T.MINTN || e.type === T.BUY || ((e.type === T.TRANSFER || e.type === T.LIST) && e.buy > 0);
    const paid = envs.filter((x) => x.env && isPaid(x.env)).length;
    const ctx = { spentLocks, sold: new Set(), txNullifiers: new Set(), dry: true };
    const out = [];
    for (const x of envs) {
      if (!x.env) { out.push(x); continue; }
      const r = paid > 1 && isPaid(x.env) ? { ok: false, reason: 'more than one paid envelope in the tx' } : await this._apply(height, tx, x.env, ctx);
      out.push({ type: TYPE_NAME[x.env.type], env: x.env, ...r });
    }
    return { envelopes: out, paid, spentLocks };
  }

  // Relayer pre-check: would this UNPAID envelope (TRANSFER / LIST with buy 0, or a CLAIM of a
  // CLOSED listing) be accepted if mined at `height`? Read-only. `pendingNfs` = nullifiers already
  // relayed but not yet mined. A relayer only spends fees on envelopes that pass this.
  // selfPublished: the sender's own wallet pays the miner (spend 0, and buy > 0 tops up credits;
  // the carrier then pays buy x ticketPrice itself). Otherwise one ticket pays the relayer.
  async checkRelay(env, height = this.lastHeight + 1, pendingNfs = new Set(), { selfPublished = false } = {}) {
    const R = this.rules;
    if (!env.cid.equals(this.cid)) return { ok: false, reason: 'another collection' };
    if (selfPublished ? env.spend !== 0 : env.spend !== 1) {
      return { ok: false, reason: selfPublished ? 'a self-published envelope spends no ticket' : 'relayed envelopes must spend one ticket' };
    }
    if (env.type === T.CLAIM) {
      const l = this.listings.get(env.listingNf);
      if (!l || l.state !== 'CLOSED') return { ok: false, reason: 'listing is not closed' };
      if (l.tickets < env.spend) return { ok: false, reason: 'no ticket left on this piece' };
      if (pendingNfs.has(env.listingNf)) return { ok: false, reason: 'claim already pending' };
      if (!schnorrVerify(env.sig, env.sigHash, l.returnKey)) return { ok: false, reason: 'bad return-key signature' };
      return { ok: true };
    }
    if (env.type !== T.TRANSFER && env.type !== T.LIST) return { ok: false, reason: 'not a relayable envelope' };
    if (!selfPublished && env.buy !== 0) return { ok: false, reason: 'ticket top-ups are paid by the sender' };
    if (env.buy > MAX_TICKETS_PER_BUY) return { ok: false, reason: 'too many tickets' };
    // leave a margin so a slow block doesn't push the anchor out of the window
    if (!this._anchorOk(height, env.hanchor) || env.hanchor < height - ANCHOR_WINDOW + 10) return { ok: false, reason: 'anchor too old or unknown: rebuild the proof' };
    if (this.nullifiers.has(env.nf) || pendingNfs.has(env.nf)) return { ok: false, reason: 'double spend (nullifier seen)' };
    const isList = env.type === T.LIST;
    if (isList && env.assetId >= R.supply) return { ok: false, reason: 'assetId beyond supply' };
    if (isList && env.price < BigInt(dustFor(env.sellerScript))) return { ok: false, reason: 'price below dust' };
    const pub = [this.roots.get(env.hanchor), env.nf, env.hbody, isList ? 0n : env.cmOut, env.spend, env.buy,
      isList ? 1 : 0, isList ? env.assetId : 0, isList ? env.tickets : 0];
    if (!(await this._verify(pub, env.proof))) return { ok: false, reason: 'proof invalid' };
    return { ok: true };
  }

  _addNote(cm, env, txid, height, kind) {
    const pos = this.tree.append(cm);
    this.notes.push({ pos, cm, epk: Buffer.from(env.epk), ct: Buffer.from(env.ct), txid, height, kind });
  }

  treeAt(height) {
    const t = new NoteTree(DEPTH);
    t.leaves = this.tree.leaves.slice(0, this.leafCounts.get(height));
    return t;
  }

  // canonical digest of the whole state, for comparing two independent indexers
  stateDigest() {
    const listings = [...this.listings.values()].map((l) => [String(l.nf), l.state, l.assetId, l.tickets, String(l.price)]);
    return JSON.stringify({
      root: String(this.tree.root()),
      leaves: this.tree.leaves.length,
      nfs: [...this.nullifiers].map(String).sort(),
      minted: [...this.minted.keys()].sort((a, b) => a - b),
      listings: listings.sort(),
    });
  }
}
