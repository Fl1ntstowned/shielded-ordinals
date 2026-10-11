// The piece index (src/v1/pieces.mjs) and its routes (indexer/routes/pieces.mjs), offline:
//   1. the reader, on real Nakas reveals (test/fixtures/nakas-reveals) and made-up ones
//   2. the 9 small Nakas reveals through the index (piece #0 by its pin and its Merkle path)
//   3. synthetic chains through the follower: who is a child, duplicates, the parent's sat flow,
//      invalid metadata, a failed fetch, a reorg, and the rules engine untouched
//   4. the art check and the pins
//   5. pages, one piece, info (content versions, final answers); tools/prepare-art.mjs
//   6. the real indexer serving all of it (keys required), and with PIECES=0
//   node test/pieces.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ordinals from 'micro-ordinals';
import { SynthChain, testRules, serveEsplora, KEYS, p2tr, VKEY } from './lib/synth.mjs';
import { follower, makeSource } from '../src/v1/follow.mjs';
import { PieceIndex, readChildren, readReveal, inscriptionIdField, scriptOps, piecesOf, PER_PAGE, IGNORED_MAX } from '../src/v1/pieces.mjs';
import { readInscriptions, rulesFromChain } from '../src/v1/inscribe.mjs';
import { artRoot, artProof, fileHash, verifyArt } from '../src/v1/art.mjs';
import { piecePins, COLLECTIONS } from '../src/v1/collections.mjs';
import { KeyStore } from '../indexer/keys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = path.join(ROOT, 'indexer', 'indexer.mjs');
const FIX = path.join(ROOT, 'test', 'fixtures', 'nakas-reveals');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-pieces-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const GENESIS = sha('shord-pieces-v1');
const digestOf = (list) => list.reduce((d, [h, id, piece, s]) => sha(`${d}|${h}|${id}|${piece}|${s}`), GENESIS);

// ---- building reveals on a synthetic chain ----------------------------------------------------------
const art = (tag, a) => Buffer.from(`synthetic art ${tag} piece ${a}`);
const rootOf = (tag, supply) => artRoot(Array.from({ length: supply }, (_, a) => fileHash(art(tag, a)))).toString('hex');
/** A child inscription: { tags, body }. meta: undefined = the usual shielded block, null = no tag 5. */
const child = (parentId, piece, { body, meta, parent = parentId, name, tags = {} } = {}) => ({
  tags: {
    contentType: 'image/png', parent,
    ...(meta === null ? {} : { metadata: meta ?? { name: name ?? `Synth #${piece}`, attributes: [{ trait_type: 'Body', value: `b${piece % 3}` }, { trait_type: 'Shielded #', value: String(piece) }], shielded: { number: piece, piece, parent: parentId } } }),
    ...tags,
  },
  body: body ?? Buffer.from(`body ${piece}`),
});
/** A reveal tx: `ins` first (coins the test names, spent by key path), then the input carrying every envelope. */
function revealTx(chain, ins, children, outs) {
  const script = Buffer.from(ordinals.p2tr_ord_reveal(KEYS.reveal.xonly, children.map((c) => ({ tags: c.tags, body: Buffer.from(c.body) }))).script);
  const control = Buffer.concat([Buffer.from([0xc0]), KEYS.reveal.xonly]);
  return chain.tx({
    ins: [...ins.map((i) => ({ witness: [Buffer.alloc(64, 2)], ...i })), { witness: [Buffer.alloc(64, 1), script, control] }],
    outs: outs ?? [{ script: p2tr(KEYS.seller.xonly), value: 546 }, ...children.map(() => ({ script: p2tr(KEYS.ret.xonly), value: 330 }))],
  });
}
/** chain.source plus prevoutValues from a table (txid -> values), counting what is asked. */
function sourceWith(chain, values = new Map()) {
  const asked = { txHex: [], prevoutValues: [] };
  let failTx = false;
  return {
    asked, values,
    failTxHex: (v) => { failTx = v; },
    src: {
      ...chain.source,
      txHex: async (txid, hash) => { asked.txHex.push(txid); if (failTx) throw new Error('/tx: 503'); return chain.source.txHex(txid, hash); },
      prevoutValues: async (_hash, txid) => { asked.prevoutValues.push(txid); if (!values.has(txid)) throw new Error(`no values for ${txid}`); return values.get(txid); },
    },
  };
}
/** Drive a PieceIndex straight over the chain's cached blocks (what the follower hands its hooks). */
async function drive(px, chain, src, from = chain.start, to = chain.tipHeight()) {
  for (let h = from; h <= to; h++) { await px.beforeBlock(h, chain.hashAt(h), chain.reduced(h), src); px.afterBlock(h); }
  return px;
}

// ==== 1. the reader ==================================================================================
const blocks = JSON.parse(fs.readFileSync(path.join(FIX, 'blocks.json'), 'utf8'));
const fixHex = (txid) => fs.readFileSync(path.join(FIX, `${txid}.hex`), 'utf8').trim();
{
  let agree = true, envs = 0;
  for (const b of blocks) {
    const mine = readChildren(fixHex(b.txid));
    const theirs = readInscriptions(fixHex(b.txid));
    envs += mine.length;
    agree &&= mine.length === theirs.length && mine.every((e, i) => e.id === theirs[i].id && e.contentType === theirs[i].contentType && e.sha256 === sha(theirs[i].body) && e.size === theirs[i].body.length && same(e.parents, theirs[i].parents));
  }
  check('reader: on the 10 real Nakas txs, the same inscriptions as the release reader (ids, content type, body hash, parents)', agree && envs === 11, envs);
  const r = readReveal(fixHex('eb5540826f52c447f0f5b18505c34cd9908d847119e2d307fd7622175c4d31f0'));
  check('reader: a reveal\'s inputs, output values and per-envelope fields (pointer, parent, shielded, metadata)', r.reader === 1 && r.ins[0] === '11c4f09ca4184cd9b7d4b1105848cca37b7f6bb733835b7146ece965d7aa664b:0' && r.outs[0] === 546
    && r.envelopes.length === 2 && r.envelopes.every((e) => e.input === 1 && same(e.parents, ['896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0']) && e.metadata?.name && e.metadataError === null && !('body' in e))
    && r.envelopes[0].pointer === 546 && r.envelopes[1].pointer === 876 && same(r.envelopes.map((e) => e.shielded), [{ piece: 7, parent: '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0' }, { piece: 8, parent: '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0' }]), r.envelopes);
}
{
  const c = new SynthChain({ start: 700000 });
  const PID = 'aa'.repeat(32) + 'i0';
  const bad = { tags: { contentType: 'image/png', parent: PID, unknown: [[new Uint8Array([5]), new Uint8Array([0xbf, 0xff, 0xff])]] }, body: Buffer.from('middle') };
  const t = revealTx(c, [{ txid: 'aa'.repeat(32), vout: 0 }], [child(PID, 1), bad, child(PID, 2)]);
  const mine = readChildren(t.tx.toHex());
  check('tolerant reader: 3 children, the middle with unreadable tag-5 CBOR: 3 envelopes, the middle flagged, the others whole', mine.length === 3 && mine[1].metadataError === 'unreadable' && mine[1].metadata === null && mine[1].sha256 === sha('middle')
    && mine[0].shielded?.piece === 1 && mine[2].shielded?.piece === 2 && mine.every((e, i) => e.id === `${t.txid}i${i}`), mine);
  check('tolerant reader: the release reader loses all three (why the index has its own)', readInscriptions(t.tx.toHex()).length === 0);
  // a parent tag written with the fixed 4-byte index (36 bytes, i0 = 00000000) still names the parent, as in ord
  const fixedParent = { tags: { contentType: 'image/png', metadata: { shielded: { piece: 3 } }, unknown: [[new Uint8Array([3]), new Uint8Array([...Buffer.from('aa'.repeat(32), 'hex'), 0, 0, 0, 0])]] }, body: Buffer.from('fixed') };
  const tf = revealTx(c, [{ txid: 'aa'.repeat(32), vout: 0 }], [fixedParent]);
  const fx = readChildren(tf.tx.toHex());
  check('reader: a 36-byte parent tag with a zero 4-byte index names <txid>i0', fx.length === 1 && same(fx[0].parents, [PID]) && fx[0].shielded?.piece === 3, fx);
  const txid = Buffer.from('ab'.repeat(32), 'hex');
  check('parent field: 32 bytes is i0, 33 bytes names i1..i255, a trailing zero byte is refused (as ord)', inscriptionIdField(txid) === `${'ab'.repeat(32)}i0` && inscriptionIdField(Buffer.concat([txid, Buffer.from([7])])) === `${'ab'.repeat(32)}i7`
    && inscriptionIdField(Buffer.concat([txid, Buffer.from([0])])) === null && inscriptionIdField(Buffer.concat([txid, Buffer.from([1, 1])])) === `${'ab'.repeat(32)}i257` && inscriptionIdField(txid.subarray(1)) === null && inscriptionIdField(Buffer.alloc(37)) === null
    && inscriptionIdField(Buffer.concat([txid, Buffer.from([1, 1, 0])])) === null);
  check('parent field: the fixed 4-byte index may end in zero bytes (ord InscriptionId::from_value): 00000000 is i0, 07000000 is i7',
    inscriptionIdField(Buffer.concat([txid, Buffer.from([0, 0, 0, 0])])) === `${'ab'.repeat(32)}i0` && inscriptionIdField(Buffer.concat([txid, Buffer.from([7, 0, 0, 0])])) === `${'ab'.repeat(32)}i7`
    && inscriptionIdField(Buffer.concat([txid, Buffer.from([1, 1, 0, 0])])) === `${'ab'.repeat(32)}i257`);
  const env = Buffer.from('0063036f72640101510068', 'hex'); // OP_0 OP_IF "ord" 01 01(tag 1 = 'Q') OP_0 OP_ENDIF
  check('script reader: an empty push in any encoding is OP_0; an unknown opcode is an opcode; a push past the end refuses the script', same(scriptOps(Buffer.from('4c00', 'hex')), [0]) && same(scriptOps(Buffer.from('4d0000', 'hex')), [0])
    && same(scriptOps(Buffer.from('bb', 'hex')), ['op187']) && (() => { try { scriptOps(Buffer.from('4c05aa', 'hex')); return false; } catch { return true; } })() && scriptOps(Buffer.concat([env, Buffer.from('bb', 'hex')])).filter((x) => x === 'ENDIF').length === 1);
}

// ==== 2. real Nakas reveals through the index =======================================================
const NAKAS = '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0';
{
  const { rules } = rulesFromChain(fixHex(blocks[0].txid), NAKAS);
  const pins = piecePins('mainnet', NAKAS);
  const pin = pins['647652c78ba433efed478ff657746a378af7999789aa0d2c058024671205e81di0'];
  check('Nakas pin: piece #0 child, its content hash, a 12-hash path that verifies against artRoot a6146695...128d',
    rules.artRoot === 'a6146695afd979a5b8f355c7963e3e4c38e471013ab30f5a085a1c42bc20128d' && Object.keys(pins).length === 1 && pin.piece === 0 && pin.proof.length === 12
    && verifyArt(Buffer.from(rules.artRoot, 'hex'), 0, Buffer.from(pin.sha256, 'hex'), pin.proof.map((x) => (x ? Buffer.from(x, 'hex') : null))) && COLLECTIONS.mainnet['shielded-nakas'].pieces.pinned === pins);
  const px = new PieceIndex({ rulesInscriptionId: NAKAS, rules, network: 'mainnet', pinned: pins });
  const asked = [];
  const src = { txHex: async (t) => { asked.push(t); return fixHex(t); } };
  for (const b of blocks) {
    const t = bitcoin.Transaction.fromHex(fixHex(b.txid));
    // the cached block as the follower keeps it (every tx's spent coins), with an unrelated tx in front
    const txs = [{ txid: 'ff'.repeat(32), ins: [{ txid: 'ee'.repeat(32), vout: 0 }] }, { txid: b.txid, ins: t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })) }];
    await px.beforeBlock(b.height, b.hash, txs, src);
    px.afterBlock(b.height);
  }
  const at = (a) => px.childOf(a);
  check('Nakas: piece 1 -> 13fdb17b...i0, piece 2 -> 08957465...i0, piece 3 -> fb2b13f0...i0 (from shielded.piece)',
    at(1)?.id === '13fdb17bcc0ecfaa49668eb23f1f06a66b1c59cf0a0d6c3b7eef53d38ca04dc8i0' && at(2)?.id === '08957465de47f4de86c5a79cdf105c00618615d12f079cab671e37cce85dbe3ei0'
    && at(3)?.id === 'fb2b13f0fba15839e8a4c0edddd498a4a13047551cca0a59f887fa728eed2cdbi0' && [1, 2, 3].every((a) => at(a).via === 'metadata'));
  check('Nakas: piece 0 -> 647652c7...i0 via "pinned" (no shielded block; its path proves it)', at(0)?.id === '647652c78ba433efed478ff657746a378af7999789aa0d2c058024671205e81di0' && at(0).via === 'pinned' && at(0).sha256 === pin.sha256 && at(0).metadata?.name === 'Shielded NAKAS #1');
  check('Nakas: the 9 reveals give pieces 0..9, none ignored, the parent at the last reveal\'s output 0, art not checkable yet',
    px.pieces.size === 10 && [...px.pieces.keys()].sort((a, b) => a - b).join() === '0,1,2,3,4,5,6,7,8,9' && px.ignored.length === 0
    && px.parentAtText() === '7b9a5ad4765a940780d1af185ab3858116900953835c4bcaf3c8726076d39436:0' && px.art().verified === null && px.art().have === 10 && px.art().of === 3333);
  check('Nakas: only the parent\'s reveal and the txs that spend the parent are read', same(asked, blocks.map((b) => b.txid)));
  const expect = digestOf(blocks.slice(1).flatMap((b) => readChildren(fixHex(b.txid)).map((e) => [b.height, e.id, e.shielded?.piece ?? 0, e.sha256])));
  check('Nakas: the running digest is sha256(prev|height|child|piece|content sha256) in chain order', px.digest === expect);
  const unpinned = new PieceIndex({ rulesInscriptionId: NAKAS, rules, network: 'mainnet' });
  for (const b of blocks) {
    const t = bitcoin.Transaction.fromHex(fixHex(b.txid));
    await unpinned.beforeBlock(b.height, b.hash, [{ txid: b.txid, ins: t.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })) }], src);
    unpinned.afterBlock(b.height);
  }
  check('Nakas: without the pin, piece 0 is left unassigned with a reason (never by name or elimination)', !unpinned.childOf(0) && same(unpinned.ignored, [{ id: '647652c78ba433efed478ff657746a378af7999789aa0d2c058024671205e81di0', reason: 'no shielded.piece' }]));
}

// ==== 3. synthetic chains through the follower ======================================================
const S1 = 600000;
const c1 = new SynthChain({ start: S1 });
const SUP = 8;
const P = c1.parent(testRules({ name: 'Pieces Test', supply: SUP, artRoot: rootOf('p', SUP) }).json);
const PT = P.id.split('i')[0];
const other = 'cd'.repeat(32) + 'i0';
const coin = (label) => crypto.createHash('sha256').update(`coin ${label}`).digest('hex');
c1.block([P.tx]); // S1
c1.block([c1.mint(P, [0, 1, 2, 3, 4, 5, 6, 7])]); // S1+1
const pc = (a, o = {}) => child(P.id, a, { body: art('p', a), name: `Pieces Test #${a}`, ...o });
const fake = revealTx(c1, [{ txid: coin('fake'), vout: 0 }], [pc(5)]); // claims the parent, spends something else
const R1 = revealTx(c1, [{ txid: PT, vout: 0 }], [pc(1), pc(2)]);
const R2 = revealTx(c1, [{ txid: R1.txid, vout: 0 }], [pc(2, { body: Buffer.from('second claim on 2') }), pc(3), child(other, 4)]);
c1.block([fake, R1, R2]); // S1+2: the parent moves twice
const R3 = revealTx(c1, [{ txid: coin('x'), vout: 0 }, { txid: R2.txid, vout: 0 }], [
  pc(4), pc(2, { body: Buffer.from('later claim on 2') }), pc(8), pc(9, { meta: { shielded: { piece: 'x' } } }),
  pc(6, { meta: { shielded: { piece: 6, parent: other } } }), pc(1, { meta: null }), pc(3, { meta: { shielded: 3 } }),
], [{ script: p2tr(KEYS.seller.xonly), value: 1000 }, { script: p2tr(KEYS.seller.xonly), value: 546 }, { script: p2tr(KEYS.ret.xonly), value: 330 }]);
c1.block([R3]); // S1+3: the parent at input 1
const R4 = revealTx(c1, [{ txid: coin('y'), vout: 0 }, { txid: R3.txid, vout: 1 }], [pc(5)], [{ script: p2tr(KEYS.seller.xonly), value: 500 }, { script: p2tr(KEYS.seller.xonly), value: 1000 }, { script: p2tr(KEYS.ret.xonly), value: 330 }]);
c1.block([R4]); // S1+4: lands at output 1, offset 200
const R5 = revealTx(c1, [{ txid: R4.txid, vout: 1 }], [pc(6)], [{ script: p2tr(KEYS.seller.xonly), value: 100 }, { script: p2tr(KEYS.seller.xonly), value: 300 }, { script: p2tr(KEYS.ret.xonly), value: 330 }]);
c1.block([R5]); // S1+5: input 0, offset 200 -> output 1, offset 100 (no spent-coin values needed)
const R6 = revealTx(c1, [{ txid: R5.txid, vout: 1 }], [pc(7)], [{ script: p2tr(KEYS.seller.xonly), value: 50 }]);
c1.block([R6]); // S1+6: offset 100 of 50 sats of outputs: the parent's sat goes to the fees
const R7 = revealTx(c1, [{ txid: R6.txid, vout: 0 }], [pc(0)]);
c1.block([R7]); // S1+7: a child after the parent is lost
const VALUES = new Map([[R3.txid, [1000, 546, 10_000]], [R4.txid, [700, 1000, 10_000]]]);
const expected = [[S1 + 2, `${R1.txid}i0`, 1], [S1 + 2, `${R1.txid}i1`, 2], [S1 + 2, `${R2.txid}i1`, 3], [S1 + 3, `${R3.txid}i0`, 4], [S1 + 4, `${R4.txid}i0`, 5], [S1 + 5, `${R5.txid}i0`, 6], [S1 + 6, `${R6.txid}i0`, 7]];
const expectedDigest = digestOf(expected.map(([h, id, a]) => [h, id, a, sha(art('p', a))]));

const fdir = path.join(tmp, 'follow-1');
const s1 = sourceWith(c1, VALUES);
const px1 = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet', cacheDir: fdir });
const f1 = follower({ network: 'signet', source: s1.src, cacheDir: fdir, rulesInscriptionId: P.id, rules: P.rules, vkey: VKEY, startHeight: S1, hooks: [px1] });
await f1.sync();
{
  check('follower: synced to the tip with the piece index as a hook', f1.ix()?.lastHeight === S1 + 7 && px1.height === S1 + 7 && piecesOf(f1.hooks) === px1);
  check('children: each piece goes to the first valid child, in block, tx and inscription order', same([...px1.pieces].map(([a, x]) => [x.height, x.id, a]).sort((x, y) => x[2] - y[2]), expected.slice().sort((x, y) => x[2] - y[2])) && px1.pieces.get(1).via === 'metadata');
  check('children: the running digest over them', px1.digest === expectedDigest);
  check('the parent moving twice in one block is followed (reveal A, then reveal B spending A:0)', px1.childOf(3)?.id === `${R2.txid}i1` && px1.childOf(3).height === S1 + 2);
  check('a fake child (names the parent, does not spend it) is never assigned, and its tx is never fetched', !s1.asked.txHex.includes(fake.txid) && px1.childOf(5)?.id === `${R4.txid}i0`);
  check('an inscription in a parent-spending tx that names another parent is not a child (not even ignored)', !px1.ignored.some((x) => x.id === `${R2.txid}i2`));
  check('duplicates: a second child for a piece, in the same block or a later one, is ignored with the piece', px1.ignored[0]?.id === `${R2.txid}i0` && px1.ignored[0].reason === 'piece already has a child' && px1.ignored[0].piece === 2
    && px1.ignored[1]?.id === `${R3.txid}i1` && px1.ignored[1].reason === 'piece already has a child' && px1.ignored[1].piece === 2, px1.ignored);
  check('invalid shielded blocks: out of range, not an integer, another parent, none, not an object; each unassigned with its reason',
    same(px1.ignored.slice(2).map((x) => [x.id.slice(-2), x.reason]), [['i2', 'shielded.piece is out of range'], ['i3', 'shielded.piece is not an integer'], ['i4', 'shielded.parent names another parent'], ['i5', 'no shielded.piece'], ['i6', 'shielded is not an object']]) && px1.ignoredTotal === 7, px1.ignored);
  check('sat flow: the parent at input 1 uses the spent-coin values; at input 0 (any offset) it does not', same(s1.asked.prevoutValues, [R3.txid, R4.txid]));
  check('sat flow: input 1 after a 1000-sat coin lands on output 1; offset 200 of input 0 lands on output 1 at offset 100', px1.childOf(5)?.id === `${R4.txid}i0` && px1.childOf(6)?.id === `${R5.txid}i0`);
  check('sat flow: the parent\'s sat sent to the fees makes it "lost"; that tx\'s own child counts, a later one is never read', px1.parentAtText() === 'lost' && px1.childOf(7)?.id === `${R6.txid}i0` && !px1.childOf(0) && !s1.asked.txHex.includes(R7.txid));
  check('reads: the parent\'s reveal and each parent-spending tx once', same(s1.asked.txHex, [PT, R1.txid, R2.txid, R3.txid, R4.txid, R5.txid, R6.txid]));
  const cached = fs.readdirSync(path.join(fdir, 'signet-pieces')).sort();
  const sample = JSON.parse(fs.readFileSync(path.join(fdir, 'signet-pieces', `${R3.txid}.json`), 'utf8'));
  check('cache: one file per read tx (hashes and metadata, no bodies), spent-coin values kept with it', cached.length === 7 && same(sample.inValues, VALUES.get(R3.txid)) && !JSON.stringify(sample).includes(Buffer.from('later claim on 2').toString('hex')));
  const plain = follower({ network: 'signet', source: s1.src, cacheDir: fdir, rulesInscriptionId: P.id, rules: P.rules, vkey: VKEY, startHeight: S1 });
  await plain.sync();
  check('consensus guard: with and without the piece index, the state digest is byte-identical', plain.ix().stateDigest() === f1.ix().stateDigest() && plain.ix().minted.size === SUP);
  const asked = s1.asked.txHex.length;
  const forked = c1.source.fork(S1 + 3);
  await quiet(() => f1.sync());
  check('reorg: the follower rebuilds; same pieces and digest on the new blocks, and no tx is fetched again (cache by txid)', f1.hashAt(S1 + 7) === forked.hashes.at(-1) && px1.digest === expectedDigest && px1.parentAtText() === 'lost' && s1.asked.txHex.length === asked && s1.asked.prevoutValues.length === 2);
  const again = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet' });
  again.restore(JSON.parse(JSON.stringify(px1.snapshot())));
  const ix = f1.ix();
  check('snapshot/restore: the same index (info, pages, pieces)', same(again.info({ ix, height: 1 }), px1.info({ ix, height: 1 })) && again.page(0, { ix, height: 1 }).version === px1.page(0, { ix, height: 1 }).version && same(again.piece(4, { ix, height: 1 }), px1.piece(4, { ix, height: 1 })));
  let refused = false;
  try { again.restore({ ...px1.snapshot(), parent: other }); } catch { refused = true; }
  check('snapshot/restore: a saved state of another parent is refused', refused);
}
{
  // checkpoints (src/v1/checkpoint.mjs) carry the piece index under its id 'pieces': a restart loads
  // it with the engine and reads no tx again
  const dir = path.join(tmp, 'follow-checkpoint');
  const opts = { network: 'signet', cacheDir: dir, rulesInscriptionId: P.id, rules: P.rules, vkey: VKEY, startHeight: S1, checkpoints: true, checkpointEvery: 1 };
  const pxA = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet', cacheDir: dir });
  const fA = follower({ ...opts, source: sourceWith(c1, VALUES).src, hooks: [pxA] });
  await quiet(() => fA.sync());
  await fA.flush();
  const s = sourceWith(c1, VALUES);
  const pxB = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet', cacheDir: path.join(dir, 'no-tx-cache') });
  const fB = follower({ ...opts, source: s.src, hooks: [pxB] });
  await quiet(() => fB.sync());
  check('checkpoint: a restart loads the piece index with the engine (same pieces, ignored, parent and digest) and reads no tx',
    fA.checkpointInfo()?.height === S1 + 7 && fB.checkpointInfo()?.height === S1 + 7 && fB.ix().stateDigest() === fA.ix().stateDigest()
    && same(pxB.snapshot(), pxA.snapshot()) && pxB.digest === expectedDigest && s.asked.txHex.length === 0 && s.asked.prevoutValues.length === 0);
}
{
  // a failed fetch stops the round before the block, like a failed block download
  const s = sourceWith(c1, VALUES);
  const dir = path.join(tmp, 'follow-fail');
  const px = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet', cacheDir: dir });
  const f = follower({ network: 'signet', source: s.src, cacheDir: dir, rulesInscriptionId: P.id, rules: P.rules, vkey: VKEY, startHeight: S1, hooks: [px] });
  c1.setTip(S1 + 1);
  await f.sync();
  c1.setTip(null);
  s.failTxHex(true);
  await quiet(() => f.sync());
  check('fetch failure: the round stops before block h (engine and index stay at h-1, nothing assigned)', f.ix().lastHeight === S1 + 1 && px.height === S1 + 1 && px.pieces.size === 0 && f.hashAt(S1 + 2) === null);
  s.failTxHex(false);
  await f.sync();
  check('fetch failure: the next round ends on the same piece digest', f.ix().lastHeight === S1 + 7 && px.digest === expectedDigest && f.ix().stateDigest() === f1.ix().stateDigest());
  const nov = follower({ network: 'signet', source: { ...c1.source }, cacheDir: path.join(tmp, 'follow-novalues'), rulesInscriptionId: P.id, rules: P.rules, vkey: VKEY, startHeight: S1, hooks: [new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet' })] });
  await quiet(() => nov.sync());
  check('a source that cannot give spent-coin values stops where they are needed (never guesses)', nov.ix() === null);
}

// ==== 4. the art check and the pins ==================================================================
async function artCase({ supply = 4, bodies, pinned, kids }) {
  const c = new SynthChain({ start: 650000 });
  const Q = c.parent(testRules({ name: 'Art Test', supply, artRoot: rootOf('q', supply) }).json);
  c.block([Q.tx]);
  c.block([c.mint(Q, Array.from({ length: supply }, (_, a) => a))]);
  const list = (kids ?? ((q) => Array.from({ length: supply }, (_, a) => child(q.id, a, { body: bodies?.[a] ?? art('q', a), ...(a === 0 && pinned ? { meta: { name: 'no shielded block' } } : {}) }))))(Q);
  const R = revealTx(c, [{ txid: Q.id.split('i')[0], vout: 0 }], list);
  c.block([R]);
  const px = new PieceIndex({ rulesInscriptionId: Q.id, rules: Q.rules, network: 'signet', pinned: typeof pinned === 'function' ? pinned(R) : pinned });
  return { px: await drive(px, c, sourceWith(c).src), R, Q };
}
{
  const hs = Array.from({ length: 4 }, (_, a) => fileHash(art('q', a)));
  const proof0 = artProof(hs, 0).map((x) => (x ? x.toString('hex') : null));
  const pin = (R, over = {}) => ({ [`${R.txid}i0`]: { piece: 0, sha256: hs[0].toString('hex'), proof: proof0, ...over } });
  const all = await artCase({ pinned: (R) => pin(R) });
  check('art: every leaf present (piece 0 by its pin) -> verified true', all.px.art().verified === true && all.px.childOf(0)?.via === 'pinned' && same(all.px.summary(), { withChild: 4, pages: 1, art: { have: 4, of: 4, verified: true } }));
  const tampered = await artCase({ bodies: { 2: Buffer.from('not the art of piece 2') } });
  check('art: one body tampered -> verified false', tampered.px.art().verified === false && tampered.px.pieces.size === 4);
  const missing = await artCase({ kids: (q) => [1, 2, 3].map((a) => child(q.id, a, { body: art('q', a) })) });
  check('art: a leaf missing -> verified null', missing.px.art().verified === null && missing.px.pieces.size === 3 && missing.px.art().have === 3);
  const wrong = await artCase({ pinned: (R) => pin(R, { proof: proof0.map((x, i) => (i === 0 ? 'ee'.repeat(32) : x)) }) });
  check('pins: a pin whose path does not verify against artRoot is refused; the child stays unassigned', !wrong.px.childOf(0) && same(wrong.px.ignored, [{ id: `${wrong.R.txid}i0`, reason: 'pin proof does not verify against artRoot' }]) && wrong.px.art().verified === null);
  const other2 = await artCase({ pinned: (R) => pin(R, { sha256: hs[1].toString('hex'), proof: artProof(hs, 1).map((x) => (x ? x.toString('hex') : null)), piece: 1 }) });
  check('pins: a pin whose path holds but whose hash is not the child\'s content is refused', !other2.px.childOf(0) && other2.px.ignored[0]?.reason === 'content differs from the pin' && other2.px.childOf(1)?.via === 'metadata');
}

// ==== 5. pages, one piece, info =======================================================================
{
  const ix = f1.ix();
  const small = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet', perPage: 3 });
  await drive(small, c1, sourceWith(c1, VALUES).src);
  const tip = S1 + 7;
  const p0 = small.page(0, { ix, height: tip, globalStart: 0 });
  check('page: rows [assetId, mint height, child tx (page dictionary), inscription index, inscribed height, [trait, value...]]; unchilded pieces have nulls',
    same(p0.body.rows[0], [0, S1 + 1, null, null, null, []]) && same(p0.body.rows[1], [1, S1 + 1, 0, 0, S1 + 2, [0, 0]]) && same(p0.body.txs, [R1.txid]) && same(p0.body.traits, ['Body']) && same(p0.body.values, ['b1', 'b2']), p0.body);
  check('page: the "Shielded #" trait and the shielded block are left out; the name follows "<base> #{global}"', p0.body.name === 'Pieces Test #{global}' && p0.body.rows.every((r) => r.length === 6) && p0.body.globalStart === 0
    && same(Object.keys(p0.body), ['v', 'page', 'pages', 'from', 'to', 'final', 'contentType', 'name', 'globalStart', 'txs', 'traits', 'values', 'rows']) && p0.body.contentType === 'image/png' && p0.body.pages === 3);
  const shifted = small.page(0, { ix, height: tip, globalStart: 100 });
  check('page: with another global start the names no longer follow the rule and are sent; no global start -> no rule', shifted.body.name === null && shifted.body.rows[1][6] === 'Pieces Test #1' && small.page(0, { ix, height: tip }).body.name === null);
  const v = [tip, tip + 1, tip + 40].map((h) => small.page(0, { ix, height: h }).version);
  check('page: the version is a hash of the answer: the same from block to block while its pieces do not change', v[0] === v[1] && v[1] === v[2] && v[0] === sha(JSON.stringify(small.page(0, { ix, height: tip }).body)).slice(0, 16));
  const notYet = small.page(1, { ix, height: S1 + 8, globalStart: 0 });
  const nowFinal = small.page(1, { ix, height: S1 + 9, globalStart: 0 });
  check('page: final once every piece of the page is minted and inscribed 6 blocks deep (then its version changes once)', !notYet.final && nowFinal.final && nowFinal.body.final === true && notYet.version !== nowFinal.version && !small.page(0, { ix, height: S1 + 99, globalStart: 0 }).final);
  check('final: never without the registry\'s numbers (the answer would change when they arrive): a page without globalStart, a piece without global',
    small.page(1, { ix, height: S1 + 99 }).final === false && small.page(1, { ix, height: S1 + 99 }).body.final === false && px1.piece(4, { ix, height: S1 + 99, global: null }).final === false && px1.piece(4, { ix, height: S1 + 99, global: 4 }).final === true);
  check('page: a page with a lost-parent gap is never final; the last page is shorter', small.page(2, { ix, height: S1 + 99 }).body.from === 6 && small.page(2, { ix, height: S1 + 99 }).body.to === 7 && small.page(2, { ix, height: S1 + 99 }).body.rows.length === 2);
  const one = px1.piece(4, { ix, height: tip, global: 4 });
  check('piece: mint, child (id, height, tx, content type, size, sha256, delegate, via), metadata as inscribed, tier', one.mint?.txid === ix.minted.get(4).txid && one.child?.id === `${R3.txid}i0` && one.child.size === art('p', 4).length && one.child.sha256 === sha(art('p', 4))
    && one.child.via === 'metadata' && one.child.delegate === null && one.metadata?.shielded?.piece === 4 && one.metadata.attributes.length === 2 && one.tier === 'Sub 1K' && one.global === 4 && one.final === false
    && px1.piece(4, { ix, height: tip + 10, global: 4 }).final === true && px1.piece(0, { ix, height: tip + 10, global: null }).child === null && px1.piece(0, { ix, height: tip, global: null }).tier === null);
  const info = px1.info({ ix, height: tip });
  check('info: parent, parentAt, supply, minted, withChild, pages, perPage, art, ignored, digest, height', same(Object.keys(info), ['parent', 'parentAt', 'supply', 'minted', 'withChild', 'pages', 'perPage', 'art', 'ignored', 'digest', 'height'])
    && info.parentAt === 'lost' && info.minted === 8 && info.withChild === 7 && info.pages === 1 && info.perPage === PER_PAGE && info.art.verified === null && info.digest === expectedDigest);
  const many = new PieceIndex({ rulesInscriptionId: P.id, rules: P.rules, network: 'signet' });
  for (let i = 0; i < IGNORED_MAX + 5; i++) many._ignore({ id: `x${i}`, reason: 'test' });
  check('info: the ignored list is capped; the total is still given', many.ignored.length === IGNORED_MAX && many.info({ ix, height: 1 }).ignoredTotal === IGNORED_MAX + 5);
}

{
  // tools/prepare-art.mjs puts shielded.piece in every metadata entry, so any inscriber carries it
  const artist = path.join(tmp, 'artist');
  const out = path.join(tmp, 'prepared');
  fs.mkdirSync(path.join(artist, 'images'), { recursive: true });
  fs.mkdirSync(path.join(artist, 'json'), { recursive: true });
  for (let n = 1; n <= 3; n++) {
    fs.writeFileSync(path.join(artist, 'images', `${n}.png`), `png ${n}`);
    fs.writeFileSync(path.join(artist, 'json', `${n}.json`), JSON.stringify([{ meta: { name: `Test #${n}`, attributes: [{ trait_type: 'Body', value: `v${n}` }] } }]));
  }
  const r = await new Promise((ok) => { const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'prepare-art.mjs'), artist, out, '--name', 'Test', '--seed', '00'.repeat(32)], { stdio: 'ignore' }); p.on('exit', ok); });
  const meta = r === 0 ? JSON.parse(fs.readFileSync(path.join(out, 'metadata.json'), 'utf8')) : {};
  check('prepare-art: every metadata.json entry carries shielded.piece = its assetId', r === 0 && Object.keys(meta).length === 3 && Object.entries(meta).every(([a, m]) => same(m.shielded, { piece: Number(a) }) && m.attributes.length === 1), meta);
}

// ==== 6. the real indexer =============================================================================
// Two collections: A (supply 3333: pages, listings, eviction) and B (supply 16: fully inscribed, so
// final and immutable). Proofs are taken as valid in the server process so a LIST is accepted.
const S2 = 800000;
const c2 = new SynthChain({ start: S2 });
const A = c2.parent(testRules({ name: 'Synth Pieces', supply: 3333, artRoot: rootOf('a', 3333) }).json);
const B = c2.parent(testRules({ name: 'Synth Final', supply: 16, artRoot: rootOf('b', 16) }).json);
c2.block([A.tx, B.tx]); // S2
c2.block([c2.mint(A, [0, 1, 2, 3, 4]), c2.mint(B, Array.from({ length: 16 }, (_, a) => a))]); // S2+1: A takes global 0.., B 3333..
const ac = (a, o = {}) => child(A.id, a, { body: art('a', a), name: `Synth Pieces #${a}`, ...o });
const RA = revealTx(c2, [{ txid: A.id.split('i')[0], vout: 0 }], [ac(0, { name: 'Synth Pieces #1' }), ac(1), ac(2), ac(3)]);
const RB = revealTx(c2, [{ txid: B.id.split('i')[0], vout: 0 }], Array.from({ length: 16 }, (_, a) => child(B.id, a, { body: art('b', a), name: `Synth Final #${3333 + a}` })));
c2.block([RA, RB]); // S2+2
const L1 = c2.list(A, { assetId: 1, price: 50000 });
const L4 = c2.list(A, { assetId: 4, price: 60000 });
c2.block([L1, L4]); // S2+3
c2.block([]); // S2+4
c2.block([]); // S2+5  <- server "early" stops here
c2.block([c2.mint(A, 2500)]); // S2+6: a change in page 2 only
const RA2 = revealTx(c2, [{ txid: RA.txid, vout: 0 }], [ac(2500)]);
c2.block([RA2]); // S2+7
c2.block([]); // S2+8
c2.block([]); // S2+9  (B's children are 8 deep: final)
const TIP = c2.tipHeight();
const esplora = await serveEsplora(c2);

const data = (src) => 'data:text/javascript,' + encodeURIComponent(src);
const fileUrl = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
// The server as it is, plus: proofs taken as valid, a count of every answer built (serve.mjs
// makeAnswers), and a test route that reports the counts.
const wrapServe = `export * from ${JSON.stringify(fileUrl('indexer', 'serve.mjs'))};
import * as real from ${JSON.stringify(fileUrl('indexer', 'serve.mjs'))};
globalThis.__builds = {};
export function makeAnswers(o) { const a = real.makeAnswers(o); return { ...a, answer: (key, version, build) => a.answer(key, version, () => { globalThis.__builds[key] = (globalThis.__builds[key] ?? 0) + 1; return build(); }) }; }`;
const wrapRoutes = `import real from ${JSON.stringify(fileUrl('indexer', 'routes', 'index.mjs'))};
export const routes = [...real, { id: 'test-builds', scope: 'global', open: true, keep: 'own', limit: 1, match: (p) => (p === '/test/builds' ? {} : null),
  parse: () => ({ key: '/test/builds', cost: 1 }), version: () => String(Math.random()), build: () => ({ ...globalThis.__builds }) }];
export default routes;`;
const hooks = `export async function resolve(specifier, context, next) {
  if (String(context.parentURL).endsWith('/indexer/indexer.mjs') && specifier === './serve.mjs') return { url: ${JSON.stringify(data(wrapServe))}, shortCircuit: true };
  if (String(context.parentURL).endsWith('/indexer/indexer.mjs') && specifier === './routes/index.mjs') return { url: ${JSON.stringify(data(wrapRoutes))}, shortCircuit: true };
  return next(specifier, context);
}`;
const PRELOAD = ['--import', data(`import { register } from 'node:module'; register(${JSON.stringify(data(hooks))});
const { Indexer } = await import(${JSON.stringify(fileUrl('src', 'v1', 'indexer.mjs'))}); Indexer.prototype._verify = async () => true;`)];

const keysFile = path.join(tmp, 'keys', 'api-keys.json');
const KEY = { 'x-api-key': new KeyStore(keysFile).create('pieces test', 100000, 1000000).key };
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['API_KEYS_FILE', 'API_KEY_REQUIRED', 'ADMIN_SECRET', 'COLLECTION', 'RULES_FILE', 'RULES_BLOCK', 'START_HEIGHT', 'RULES_INSCRIPTION_ID', 'STOP_HEIGHT', 'PIECES',
    'FOLLOW_ALL', 'REGISTRY_START', 'BITCOIN_RPC', 'BITCOIN_RPC_COOKIE', 'CHAIN_API', 'MEMPOOL_API', 'CACHE_DIR', 'PORT', 'NETWORK', 'PUBLIC_LIMIT', 'TRUST_PROXY']) delete env[k];
  return { ...env, NETWORK: 'signet', CHAIN_API: esplora.url, RULES_INSCRIPTION_ID: A.id, START_HEIGHT: String(S2), REGISTRY_START: String(S2), API_KEYS_FILE: keysFile, API_KEY_REQUIRED: '1', PUBLIC_LIMIT: '1000' };
};
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = (port, p, headers = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: { ...KEY, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (x) => chunks.push(x));
    res.on('end', () => { const body = Buffer.concat(chunks); ok({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body.toString()) }); });
  });
  r.on('error', no);
  r.end();
});
async function serve(name, extra = {}) {
  const port = await freePort();
  const stop = Number(extra.STOP_HEIGHT ?? TIP);
  const proc = spawn(process.execPath, [...PRELOAD, INDEXER], { env: { ...cleanEnv(), CACHE_DIR: path.join(tmp, `serve-${name}`), PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = [];
  proc.stderr.on('data', (x) => err.push(x));
  proc.stdout.on('data', () => {});
  const done = new Promise((ok) => proc.on('exit', ok));
  for (let i = 0; i < 300; i++) {
    try {
      const r = await get(port, '/collections');
      if (r.status === 200 && r.json().length === 2 && r.json().every((x) => x.lastHeight === stop)) return { port, proc, done, err: () => Buffer.concat(err).toString() };
    } catch { /* not listening yet */ }
    if (proc.exitCode !== null) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  console.log(Buffer.concat(err).toString());
  throw new Error(`the indexer (${name}) never reached block ${stop}`);
}
const builds = async (port) => (await get(port, '/test/builds')).json();

const early = await serve('early', { STOP_HEIGHT: String(S2 + 5) });
const main = await serve('main');
try {
  const port = main.port;
  // the same chain read in this process: what the server's index must agree with
  const ref = new PieceIndex({ rulesInscriptionId: A.id, rules: A.rules, network: 'signet' });
  await drive(ref, c2, c2.source);
  const info = (await get(port, '/pieces/info')).json();
  check('server /pieces/info: counts, parentAt, art, ignored, and the same digest as an index run in this process', info.minted === 6 && info.withChild === 5 && info.supply === 3333 && info.pages === 4 && info.perPage === 1000
    && same(info.ignored, []) && info.parentAt === `${RA2.txid}:0` && info.digest === ref.digest && info.art.verified === null && info.height === TIP, info);
  const binfo = (await get(port, `/c/${B.cidHex}/pieces/info`)).json();
  check('server /c/<cid>/pieces/info: a fully inscribed collection verifies its artRoot', binfo.withChild === 16 && binfo.art.verified === true && binfo.art.have === 16);
  const pg = await get(port, '/pieces?page=0', { 'accept-encoding': 'gzip' });
  const page = JSON.parse(pg.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(pg.body) : pg.body);
  check('server /pieces?page=0: rows 0..4, the name rule from the registry\'s range, the odd name sent', pg.status === 200 && page.rows.length === 5 && page.name === 'Synth Pieces #{global}' && page.globalStart === 0
    && same(page.rows[0].slice(2), [0, 0, S2 + 2, [0, 0], 'Synth Pieces #1']) && page.rows[1].length === 6 && same(page.rows[4], [4, S2 + 1, null, null, null, []]) && page.final === false && !/immutable/.test(pg.headers['cache-control']), page);
  const one = (await get(port, '/pieces/1')).json();
  check('server /pieces/<id>: mint, child, metadata, global number and tier', one.assetId === 1 && one.global === 1 && one.tier === 'Sub 1K' && one.child?.id === `${RA.txid}i1` && one.child.via === 'metadata' && one.mint?.height === S2 + 1 && one.metadata?.shielded?.piece === 1);
  const bone = (await get(port, `/c/${B.cidHex}/pieces/2`)).json();
  check('server /c/<cid>/pieces/<id>: the second collection\'s global numbers continue after the first', bone.global === 3335 && bone.tier === 'Sub 10K' && bone.final === true);
  const left = (r) => r.headers['x-ratelimit-remaining'];
  const bad = await Promise.all(['/pieces?page=4', '/pieces?page=01', '/pieces?page=-1', '/pieces?page=1.0', '/pieces', '/pieces?page=%200', '/pieces/3333', '/pieces/01', '/pieces/abc', `/c/${B.cidHex}/pieces/16`].map((u) => get(port, u)));
  const b1 = await builds(port);
  check('server: a bad page or piece number gets 404 before the gate (no charge) and nothing is built', bad.every((r) => r.status === 404 && left(r) === undefined) && !Object.keys(b1).some((k) => /page=(4|01|-1)|\/pieces\/(3333|01|abc|16)$/.test(k)), bad.map((r) => [r.status, left(r)]));
  const noKey = await get(port, '/pieces?page=0', { 'x-api-key': '' });
  check('server: the pieces routes need a key when keys are required (1 unit each)', noKey.status === 401);
  const lst = (await get(port, '/listings')).json();
  check('server /listings: inscriptionId from the piece index; null for a piece with no child yet', lst.length === 2 && lst.find((l) => l.assetId === 1)?.inscriptionId === `${RA.txid}i1` && lst.find((l) => l.assetId === 4)?.inscriptionId === null, lst);
  const col = (await get(port, '/collection')).json();
  check('server /collection: the pieces summary', same(col.pieces, { withChild: 5, pages: 4, art: { have: 5, of: 3333, verified: null } }));

  // ETags from the content: the same page answers alike at two heights and in two processes
  const e0 = await get(early.port, '/pieces?page=0');
  const m0 = await get(port, '/pieces?page=0');
  const e2 = await get(early.port, '/pieces?page=2');
  const m2 = await get(port, '/pieces?page=2');
  check('ETag: page 0 is unchanged from block S+5 to the tip (another page changed): same ETag, same bytes', e0.headers.etag === m0.headers.etag && e0.body.equals(m0.body) && e2.headers.etag !== m2.headers.etag);
  const nm = await get(port, '/pieces?page=0', { 'if-none-match': e0.headers.etag });
  check('ETag: If-None-Match with the earlier ETag gets 304 at the tip (1 unit)', nm.status === 304 && Number(left(m2)) - Number(left(nm)) === 1);
  const fe = await get(early.port, `/c/${B.cidHex}/pieces?page=0`);
  const fm = await get(port, `/c/${B.cidHex}/pieces?page=0`);
  check('final: not final at S+5 (4 blocks deep), final at the tip: immutable, private', fe.json().final === false && !/immutable/.test(fe.headers['cache-control']) && fm.json().final === true
    && fm.headers['cache-control'] === 'private, max-age=31536000, immutable' && fe.headers.etag !== fm.headers.etag);
  const fnm = await get(port, `/c/${B.cidHex}/pieces?page=0`, { 'if-none-match': fm.headers.etag });
  check('final: the 304 carries the immutable header too', fnm.status === 304 && fnm.headers['cache-control'] === 'private, max-age=31536000, immutable');

  // 3,333 different pieces never push /state out of the shared answer cache
  const st1 = await get(port, '/state');
  const before = await builds(port);
  for (let a = 0; a < 3333; a++) { const r = await get(port, `/pieces/${a}`); if (r.status !== 200) throw new Error(`/pieces/${a}: ${r.status}`); }
  const st2 = await get(port, '/state');
  const after = await builds(port);
  check('cache: 3,333 /pieces/<id> answers do not evict /state (built once, before and after)', st1.status === 200 && st2.body.equals(st1.body) && before['/state'] === 1 && after['/state'] === 1 && after['/pieces/3332'] === 1, { before: before['/state'], after: after['/state'] });
} finally {
  main.proc.kill(); early.proc.kill();
  await main.done; await early.done;
}
{
  const plain = await serve('off', { PIECES: '0' });
  const on = await serve('on-again');
  try {
    const so = (await get(plain.port, '/status')).json();
    const sn = (await get(on.port, '/status')).json();
    const cols = [(await get(plain.port, '/collections')).json(), (await get(on.port, '/collections')).json()];
    check('consensus guard (server): PIECES=0 gives the byte-identical /status digest, for every collection', so.digest === sn.digest && so.lastHeight === TIP && same(cols[0].map((x) => x.digest), cols[1].map((x) => x.digest)));
    const off = await get(plain.port, '/pieces/info');
    const lst = (await get(plain.port, '/listings')).json();
    const col = (await get(plain.port, '/collection')).json();
    check('PIECES=0: the pieces routes answer 404, /listings inscriptionId is null, /collection has no pieces', off.status === 404 && lst.every((l) => l.inscriptionId === null) && !('pieces' in col));
  } finally {
    plain.proc.kill(); on.proc.kill();
    await plain.done; await on.done;
  }
}

await esplora.close();
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
