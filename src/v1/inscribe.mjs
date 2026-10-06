// Shielded Ordinals v1 — ord inscriptions (Node / backend only: @scure/btc-signer + micro-ordinals).
//
//   readInscriptions / rulesFromChain   the indexer reads the collection's rules straight out of the
//                                       parent's reveal tx on Bitcoin; no ord server needed
// Envelope numbering follows ord: inscription i<n> of a tx is the n-th envelope counting input by input.
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex } from '@scure/base';
import { parseRules } from './rules.mjs';


/** Every inscription in a raw tx, in ord order: { id, contentType, body, parents, metadata }. */
export function readInscriptions(txHex) {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const txid = tx.id;
  const found = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness;
    if (!w || w.length < 2) continue;
    // [..., script, controlBlock] (+ optional annex starting 0x50)
    const hasAnnex = w.length >= 2 && w[w.length - 1][0] === 0x50;
    const script = w[w.length - (hasAnnex ? 3 : 2)];
    let ins;
    try { ins = ordinals.parseInscriptions(btc.Script.decode(script)); } catch { continue; }
    for (const x of ins ?? []) {
      const p = x.tags.parent;
      found.push({ id: `${txid}i${found.length}`, contentType: x.tags.contentType, body: x.body, parents: p === undefined ? [] : [].concat(p), metadata: x.tags.metadata });
    }
  }
  return found;
}

/** The rules, read from the parent inscription itself. */
export function rulesFromChain(parentTxHex, parentId) {
  const ins = readInscriptions(parentTxHex).find((x) => x.id === parentId);
  if (!ins) throw new Error(`no inscription ${parentId} in that tx`);
  if (!/^(application\/json|text\/plain)/.test(ins.contentType ?? '')) throw new Error('parent is not a JSON rules inscription');
  const text = Buffer.from(ins.body).toString('utf8');
  return { text, rules: parseRules(text) };
}
