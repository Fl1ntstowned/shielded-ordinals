// Rules v2 (an artist royalty on every resale) on the synthetic chain, offline: parsing, the extra
// BUY demand, the artist selling their own piece, a v1 collection unchanged, the registry's view.
//   node test/rules-v2.test.mjs
import * as bitcoin from 'bitcoinjs-lib';
import { SynthChain, testRules, makeIndexer } from './lib/synth.mjs';
import { royalty, saleFee } from '../src/v1/rules.mjs';
import { scanBlock } from '../src/v1/registry.mjs';

let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const V2 = { v: 2, royaltyBps: 100, royaltyMin: 1000 };
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// ---- parsing
const r2 = testRules(V2).rules;
check('v2 parses; the royalty is max(royaltyMin, price × bps / 1e4)', r2.v === 2 && royalty(r2, 200000n) === 2000n && royalty(r2, 20000n) === 1000n);
const rejects = (over) => { try { testRules(over); return false; } catch { return true; } };
check('v2 rejects a rate above 10%, a missing or below-dust min, a min with a 0 rate, and v3',
  rejects({ ...V2, royaltyBps: 1001 }) && rejects({ ...V2, royaltyMin: undefined }) && rejects({ ...V2, royaltyMin: 329 }) && rejects({ ...V2, royaltyBps: 0, royaltyMin: 1000 }) && rejects({ v: 3 }));
check('v2 with a 0 rate pays no royalty', royalty(testRules({ v: 2, royaltyBps: 0 }).rules, 10n ** 9n) === 0n);
const r1 = testRules({ royaltyBps: 500, royaltyMin: 1000 }).rules;
check('v1 ignores royalty keys: no royalty, the sale fee as before', r1.v === 1 && royalty(r1, 10n ** 9n) === 0n && saleFee(r1, 100000n) === 2500n);
check('v1 and v2 rules parse to the same object apart from v and the royalty keys',
  JSON.stringify(Object.keys(testRules().rules)) === JSON.stringify(Object.keys(r2).filter((k) => !['royaltyBps', 'royaltyMin'].includes(k))));

// ---- a v2 collection: mint, list, buy with the royalty; without it the buy is rejected and the listing closes
const c = new SynthChain({ start: 500000 });
const X = c.parent(testRules(V2).json);
c.block([X.tx]);
c.block([c.mint(X, [0, 1, 2])]);
const l1 = c.list(X, { assetId: 0, price: 200000 });
const l2 = c.list(X, { assetId: 1, price: 200000 });
const l3 = c.list(X, { assetId: 2, price: 50000, seller: X.rules.artistScript }); // the artist sells their own piece
c.block([l1, l2, l3]);
const good = c.buy(X, l1.listing); // synth pays the royalty on v2 rules
const shaped = c.buy(X, l2.listing); // the same buy, then re-made without its royalty output (never mined itself)
const bad = c.tx({ ins: [{ txid: l2.listing.lock.txid, vout: l2.listing.lock.vout, script: l2.listing.lock.script }], outs: shaped.tx.outs.filter((o) => !same(o.script, X.rules.artistScript)) });
const self = c.buy(X, l3.listing); // seller script == artist script: two outputs to one script, summed
c.block([good, bad, self]);
const ix = makeIndexer(X);
for (const h of c.heights()) await ix.applyBlock(h, c.reduced(h));
const log = (txid) => ix.log.filter((x) => x.txid === txid);
check('v2: a buy paying price, platform fee and royalty is accepted', log(good.txid)[0]?.accepted === true, log(good.txid));
check('v2: the accepted buy carried a 2,000-sat royalty output to the artist', good.tx.outs.some((o) => same(o.script, X.rules.artistScript) && o.value === 2000));
check('v2: a buy without the royalty is rejected and the spent lock closes the listing', log(bad.txid)[0]?.reason === 'sale payouts missing' && ix.listings.get(l2.listing.nf).state === 'CLOSED', log(bad.txid));
check('v2: artist == seller, price and royalty to the same script are summed and accepted', log(self.txid)[0]?.accepted === true && ix.listings.get(l3.listing.nf).state === 'SOLD', log(self.txid));
check('v2: the royalty floor applies (50,000 × 1% = 500 → 1,000)', royalty(X.rules, 50000n) === 1000n && self.tx.outs.some((o) => same(o.script, X.rules.artistScript) && o.value === 1000));

// ---- a v1 collection on the same code: exactly as before, no royalty demand
const d = new SynthChain({ start: 600000 });
const Y = d.parent(testRules().json);
d.block([Y.tx]);
d.block([d.mint(Y, [0])]);
const ly = d.list(Y, { assetId: 0, price: 200000 });
d.block([ly]);
const by = d.buy(Y, ly.listing);
d.block([by]);
const iy = makeIndexer(Y);
for (const h of d.heights()) await iy.applyBlock(h, d.reduced(h));
check('v1: the buy has no artist output and is accepted', !by.tx.outs.some((o) => same(o.script, Y.rules.artistScript)) && iy.log.filter((x) => x.txid === by.txid)[0]?.accepted === true && iy.listings.get(ly.listing.nf).state === 'SOLD');

// ---- the registry: a v2 parent is a collection, a v3 one is not
const e = new SynthChain({ start: 700000 });
const P2 = e.parent(testRules(V2).json);
const P3 = e.parent({ ...testRules().json, v: 3 });
e.block([P2.tx, P3.tx]);
const scan = scanBlock(bitcoin.Block.fromBuffer(e.blocks.get(e.hashAt(700000)).raw));
check('registry: a v2 parent is found, a v3 one is not', scan.parents.some((p) => p.id === P2.id) && !scan.parents.some((p) => p.id === P3.id) && P2.rules?.v === 2 && P3.rules === null, scan.parents.map((p) => p.id));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
