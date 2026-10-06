// The Bitcoin Core source (follow.mjs makeSource({ rpc })) against a STAND-IN node: a local server
// that answers the four JSON-RPC calls the indexer makes (getblockcount, getblockhash, getblock 0,
// getblock 3) with real signet data. It replays a signet test collection once through the stand-in
// node and once through the HTTP API, and the two must reach the same state.
// This checks our side of the RPC conversation. It is not a test against a real bitcoind.
//
//   node test/node-source.mjs [blocks=80]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { fileURLToPath } from 'node:url';
import { follower, loadRules, makeSource, makeApi, verifiedBlock } from '../src/v1/follow.mjs';
import { envelopesOf } from '../src/v1/indexer.mjs';

const API = process.env.CHAIN_API ?? 'https://mempool.space/signet/api';
const RULES_ID = '4de361fc9383ea15d1ed287ea7f83838ef99db1d1371282f00531e9f6c073975i0';
const START = 323965;
const TIP = START + Number(process.argv[2] ?? 80) - 1;
const VKEY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../zk/spend_vkey.json', import.meta.url)), 'utf8'));
const get = makeApi(API);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-node-source-'));

const calls = {};
const rawCache = new Map();
const raw = async (hash) => { if (!rawCache.has(hash)) rawCache.set(hash, await get(`/block/${hash}/raw`, 'buf')); return rawCache.get(hash); };
const methods = {
  getblockcount: async () => TIP,
  getblockhash: async (h) => String(await get(`/block-height/${h}`, 'text')).trim(),
  async getblock(hash, verbosity) {
    const buf = await raw(hash);
    if (verbosity === 0) return buf.toString('hex');
    // verbosity 3: every tx with the coin each input spends. The stand-in fills that in only for
    // txs carrying a SHORD envelope (the only ones the indexer asks about).
    const block = bitcoin.Block.fromBuffer(buf);
    const tx = [];
    for (const t of block.transactions) {
      const txid = t.getId();
      const outs = t.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value }));
      if (!envelopesOf({ outs }).length) { tx.push({ txid, vin: t.ins.map(() => ({})) }); continue; }
      const full = await get(`/tx/${txid}`);
      tx.push({ txid, vin: full.vin.map((v) => (v.prevout ? { prevout: { scriptPubKey: { hex: v.prevout.scriptpubkey } } } : {})) });
    }
    return { hash, tx };
  },
  getrawtransaction: async (txid) => String(await get(`/tx/${txid}/hex`, 'text')).trim(),
};
let sawAuth = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    sawAuth = req.headers.authorization ?? null;
    const { id, method, params } = JSON.parse(body);
    calls[method] = (calls[method] ?? 0) + 1;
    try {
      if (!methods[method]) throw new Error('Method not found');
      res.end(JSON.stringify({ result: await methods[method](...params), error: null, id }));
    } catch (e) { res.end(JSON.stringify({ result: null, error: { code: -1, message: e.message }, id })); }
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const rpcUrl = `http://tester:secret@127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); ok ? pass++ : fail++; };
const digest = (ix) => crypto.createHash('sha256').update(ix.stateDigest()).digest('hex');

async function replay(source, dir) {
  const rules = await loadRules({ source, rulesInscriptionId: RULES_ID });
  const f = follower({ network: 'signet', source, cacheDir: path.join(tmp, dir), rulesInscriptionId: RULES_ID, rules, vkey: VKEY, startHeight: START });
  await f.sync();
  return f.ix();
}

const api = makeSource({ api: API });
const viaApi = await replay({ ...api, tipHeight: async () => TIP }, 'api');
const viaNode = await replay(makeSource({ rpc: rpcUrl }), 'node');

check('the API replay finished', !!viaApi && viaApi.lastHeight === TIP);
check('the node replay finished', !!viaNode && viaNode.lastHeight === TIP);
check('the range holds real activity (mints)', (viaApi?.minted.size ?? 0) > 0);
check('node and API reach the same state', !!viaApi && !!viaNode && digest(viaApi) === digest(viaNode));
check('same notes and same listings', viaApi?.notes.length === viaNode?.notes.length && viaApi?.listings.size === viaNode?.listings.size);
check('the node was sent the RPC user and password', sawAuth === 'Basic ' + Buffer.from('tester:secret').toString('base64'));
check('spent coins came from getblock verbosity 3 (no txindex call for them)', (calls.getblock ?? 0) > 0 && (calls.getrawtransaction ?? 0) <= 1);

// a source that hands over the wrong block is refused
const realHash = String(await get(`/block-height/${START}`, 'text')).trim();
const otherHash = String(await get(`/block-height/${START + 1}`, 'text')).trim();
let refused = false;
try { verifiedBlock(await get(`/block/${otherHash}/raw`, 'buf'), realHash); } catch (e) { refused = /different block/.test(e.message); }
check('a block that is not the one asked for is refused', refused);

console.log(`\nminted ${viaApi?.minted.size}, notes ${viaApi?.notes.length}, listings ${viaApi?.listings.size}; node calls ${JSON.stringify(calls)}`);
console.log(`${pass} passed, ${fail} failed`);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
