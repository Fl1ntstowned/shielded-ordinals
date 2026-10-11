// How answers go out (indexer/serve.mjs and the server in indexer/indexer.mjs), offline: encoding
// negotiation, br and gzip, content-length, ETags and If-None-Match, the price of /state?since, the
// gate's 403, x-cost and the CORS headers. The real indexer runs as a child process on a synthetic
// chain (test/lib/synth.mjs) served as an esplora API, with its real rules engine and registry.
//   node test/serve.test.mjs
//   SERVE_PAYLOADS=<dir> node test/serve.test.mjs   also checks the compressed sizes of captured
//     hosted-API answers: <dir>/state.json, <dir>/since-state.json, <dir>/listings.json
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SynthChain, testRules, serveEsplora } from './lib/synth.mjs';
import { KeyStore } from '../indexer/keys.mjs';
import {
  pickEncoding, notModified, parseSince, costOf, stateCost, etagOf, versionAt, makeAnswers, sendAnswer, encoded, jobs, compressors, MIN_COMPRESS, BR_Q11_MAX,
} from '../indexer/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = path.join(ROOT, 'indexer', 'indexer.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-serve-'));
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); ok ? pass++ : fail++; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const C = zlib.constants;
const brAt = (buf, q) => zlib.brotliCompressSync(buf, { params: { [C.BROTLI_PARAM_QUALITY]: q, [C.BROTLI_PARAM_SIZE_HINT]: buf.length } });

// ---- pickEncoding ----------------------------------------------------------------------------------
{
  const table = [
    ['gzip', 'gzip'], ['gzip, deflate', 'gzip'], ['gzip, deflate, br, zstd', 'br'], ['br;q=0, gzip', 'gzip'], ['gzip;q=0', 'identity'],
    ['*', 'br'], ['', 'identity'], ['identity', 'identity'], ['GZIP', 'gzip'],
    // and around the table
    [undefined, 'identity'], ['deflate, gzip, br, zstd', 'br'], ['BR', 'br'], ['br;q=0, *', 'gzip'], ['*;q=0', 'identity'], ['gzip ; q=0 , deflate', 'identity'],
    ['gzip;q=0.5, br;q=0.1', 'br'], ['br;q=0.000, gzip;q=0', 'identity'], ['identity;q=1, *;q=0', 'identity'], ['deflate', 'identity'], ['x-gzip', 'identity'],
  ];
  const got = table.map(([h]) => pickEncoding(h));
  check('pickEncoding: the table (br, then gzip, then identity; q=0 refuses; * covers br and gzip; any case)', table.every(([, want], i) => got[i] === want), table.map(([h, want], i) => [h, want, got[i]]).filter(([, w, g]) => w !== g));
}

// ---- notModified -----------------------------------------------------------------------------------
{
  const e = '"600007-1a2b3c4d-0123456789ab"';
  const yes = [e, `W/${e}`, `"x", ${e}`, `"x" , W/${e} ,"y"`, '*', ` ${e} `];
  const no = [undefined, '', '"x"', '600007-1a2b3c4d-0123456789ab', `W/"x"`, `${e.slice(0, -2)}"`];
  check('notModified: exact, W/, a list, * (and spaces) match', yes.every((h) => notModified(h, e)), yes.filter((h) => !notModified(h, e)));
  check('notModified: nothing, another tag or an unquoted one does not', no.every((h) => !notModified(h, e)), no.filter((h) => notModified(h, e)));
}

// ---- since and the price of /state -------------------------------------------------------------------
{
  const n = 7037;
  check('price: /state is 20; since=0 is the full price', costOf('/state') === 20 && costOf('/state', 0, n) === 20 && stateCost(0, n) === 20);
  check('price: since=1 at 7,037 notes costs 19 (was 5)', costOf('/state', 1, n) === 19);
  check('price: a poll (since = the note count, or a few below) costs 5', costOf('/state', n, n) === 5 && costOf('/state', n - 3, n) === 5 && costOf('/state', n - 499, n) === 5);
  check('price: 1 more per 500 notes returned, at most 20', costOf('/state', n - 500, n) === 6 && costOf('/state', n - 1000, n) === 7 && costOf('/state', 1, 100_000) === 20);
  check('price: every other route is 1', ['/status', '/listings', '/registry', '/collection', '/collections', '/names/info'].every((p) => costOf(p, 5, n) === 1));
  // never below 5 or NaN: the gate would count a negative price as credit and NaN as free calls
  const odd = [costOf('/state', 1), costOf('/state', 7037), stateCost(9000, n), stateCost(1, NaN), stateCost(1, undefined), stateCost(1.5, n), stateCost(1e30, n), stateCost(NaN, n)];
  check('price: without a note count (or a bad one) a since costs the full 20; past the end 5; never negative or NaN', same(odd, [20, 20, 5, 20, 20, 20, 20, 20]), odd);
  const sweep = [];
  for (let c = 0; c <= 12_000; c += 397) for (let s = 0; s <= c + 600; s += 211) sweep.push(costOf('/state', s, c));
  check('price: every since and note count gives a whole number from 5 to 20', sweep.every((u) => Number.isInteger(u) && u >= 5 && u <= 20), sweep.filter((u) => !(Number.isInteger(u) && u >= 5 && u <= 20)).slice(0, 5));
  const ok = [[null, 0], ['0', 0], ['5', 5], ['007', 7], ['7037', 7037], ['7038', 7037], ['99999999999999999999999', 7037]];
  const bad = ['abc', '-1', '1e3', '1.5', '', ' 5', '5 ', '+5', '0x10', '５'];
  check('parseSince: absent is 0, digits are the number, clamped to the note count', ok.every(([s, want]) => parseSince(s, n) === want), ok.map(([s]) => [s, parseSince(s, n)]));
  check('parseSince: anything else (abc, -1, 1e3, 1.5, empty, spaces, +, hex, other digits) is null', bad.every((s) => parseSince(s, n) === null), bad.map((s) => [s, parseSince(s, n)]));
}

// ---- the answer cache and the encodings, in process ---------------------------------------------------
const rows = (k) => ({ rows: Array.from({ length: k }, (_, i) => ({ i, h: sha(`row ${i}`), s: 'shielded '.repeat(i % 7) })) });
{
  const answers = makeAnswers();
  const a1 = answers.answer('/x', versionAt(600007, 'aa'.repeat(28) + '11111111'), () => rows(200));
  const a2 = answers.answer('/x', versionAt(600007, 'aa'.repeat(28) + '11111111'), () => { throw new Error('built twice'); });
  const b = answers.answer('/x', versionAt(600007, 'bb'.repeat(28) + '22222222'), () => rows(201));
  check('cache: one build per version; the version is "<height>-<last 8 hex of the hash>"', a1 === a2 && a1.version === '600007-11111111' && answers.builds() === 2);
  check('cache: the same height with another block hash rebuilds, with another ETag', b !== a1 && b.etag !== a1.etag && b.etag === etagOf('/x', '600007-22222222') && JSON.parse(b.json).rows.length === 201);
  check('cache: the ETag is strong, "<version>-<12 hex of sha256(key)>"', a1.etag === `"600007-11111111-${sha('/x').slice(0, 12)}"` && !a1.etag.startsWith('W/'));
  check('cache: the answer is kept as the JSON bytes (a Buffer)', Buffer.isBuffer(a1.json) && a1.json.equals(Buffer.from(JSON.stringify(rows(200)))));
  // non-ASCII text: the byte length, not the string length, is what is sent
  const u = answers.answer('/u', '1-x', () => ({ s: 'naka ✓ 名前 '.repeat(200) }));
  check('cache: non-ASCII bodies are counted in bytes', u.json.length === Buffer.byteLength(JSON.stringify({ s: 'naka ✓ 名前 '.repeat(200) })) && u.json.length > JSON.stringify({ s: 'naka ✓ 名前 '.repeat(200) }).length);

  // exactly what each encoding produces
  const small = Buffer.from(JSON.stringify(rows(300))); // under 256 KB
  const large = Buffer.from(JSON.stringify(rows(4000))); // over 256 KB
  check('test data: one answer under 256 KB, one over', small.length > MIN_COMPRESS && small.length <= BR_Q11_MAX && large.length > BR_Q11_MAX, [small.length, large.length]);
  const [gS, bS, bL] = await Promise.all([compressors.gzip(small), compressors.br(small), compressors.br(large)]);
  check('encodings: gzip is level 9', gS.equals(zlib.gzipSync(small, { level: 9 })));
  check('encodings: br is quality 11 up to 256 KB and quality 4 above (with the size hint)', bS.equals(brAt(small, 11)) && bL.equals(brAt(large, 4)));
  check('encodings: both round-trip to exactly the JSON bytes', zlib.gunzipSync(gS).equals(small) && zlib.brotliDecompressSync(bS).equals(small) && zlib.brotliDecompressSync(bL).equals(large));

  // a failed job is forgotten and tried again
  const e = answers.answer('/fails', '1-x', () => rows(100));
  const real = compressors.gzip;
  compressors.gzip = () => Promise.reject(new Error('zlib broke'));
  const first = await encoded(e, 'gzip').then(() => 'ok', (err) => err.message);
  compressors.gzip = real;
  const second = await encoded(e, 'gzip');
  check('encodings: a failed job is not kept; the next request compresses again', first === 'zlib broke' && zlib.gunzipSync(second).equals(e.json));
}

// over HTTP, in process: sendAnswer with the shared cache
const get = (port, p, headers = {}, method = 'GET') => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks);
      ok({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body.toString()) });
    });
  });
  r.on('error', no);
  r.end();
});
{
  const answers = makeAnswers();
  const bodies = { '/big': rows(600), '/edge': { x: 'a'.repeat(1024 - 8) }, '/over': { x: 'a'.repeat(1025 - 8) } };
  const server = http.createServer((req, res) => {
    const a = answers.answer(req.url, '1-abcdef12', () => bodies[req.url]);
    sendAnswer(req, res, a, { 'content-type': 'application/json', 'cache-control': 'no-cache', etag: a.etag, vary: 'accept-encoding' }).catch(() => res.destroy());
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const json = Buffer.from(JSON.stringify(bodies['/big']));
  const before = { ...jobs };
  const ten = await Promise.all(Array.from({ length: 10 }, () => get(port, '/big', { 'accept-encoding': 'gzip, deflate, br' })));
  check('10 parallel br requests for one answer run exactly one compression job', jobs.br - before.br === 1 && jobs.gzip === before.gzip
    && ten.every((r) => r.status === 200 && r.headers['content-encoding'] === 'br' && r.body.equals(ten[0].body)), [jobs.br - before.br, ten.map((r) => r.headers['content-encoding'])]);
  const again = await get(port, '/big', { 'accept-encoding': 'br' });
  check('a later br request reuses the job', jobs.br - before.br === 1 && again.body.equals(ten[0].body));
  const three = await Promise.all([undefined, 'gzip', 'br'].map((ae) => get(port, '/big', ae ? { 'accept-encoding': ae } : {})));
  check('identity, gzip and br each send content-length = the bytes sent', three.every((r) => Number(r.headers['content-length']) === r.body.length && r.headers['transfer-encoding'] === undefined), three.map((r) => [r.headers['content-length'], r.body.length]));
  check('identity is the JSON; gunzip and brotliDecompress give exactly the JSON bytes',
    three[0].headers['content-encoding'] === undefined && three[0].body.equals(json) && zlib.gunzipSync(three[1].body).equals(json) && zlib.brotliDecompressSync(three[2].body).equals(json));
  const edge = await get(port, '/edge', { 'accept-encoding': 'br, gzip' });
  const over = await get(port, '/over', { 'accept-encoding': 'br, gzip' });
  check('an answer of exactly 1,024 B stays identity; 1,025 B is compressed', edge.body.length === 1024 && edge.headers['content-encoding'] === undefined && edge.headers['content-length'] === '1024'
    && over.headers['content-encoding'] === 'br' && zlib.brotliDecompressSync(over.body).length === 1025, [edge.body.length, edge.headers['content-encoding'], over.headers['content-encoding']]);
  const etag = three[0].headers.etag;
  const nm = await Promise.all([etag, `W/${etag}`, `"x", W/${etag}`, '*'].map((h) => get(port, '/big', { 'if-none-match': h, 'accept-encoding': 'br' })));
  check('If-None-Match exact, W/, a list and * each give 304 with no body', nm.every((r) => r.status === 304 && r.body.length === 0 && r.headers.etag === etag));
  server.close();
}

// ---- the real indexer on a synthetic chain ------------------------------------------------------------
const chain = new SynthChain({ start: 600000 });
const P = chain.parent(testRules({ name: 'Serve Primary', supply: 1200 }).json);
chain.block([P.tx]); // 600000
for (let b = 0; b < 5; b++) chain.block(Array.from({ length: 11 }, (_, t) => chain.mint(P, Array.from({ length: 20 }, (_, i) => (b * 11 + t) * 20 + i)))); // 600001-600005: 1,100 notes
chain.block([chain.nameTx('carol.naka')]); // 600006
chain.block([]); // 600007
const TIP = chain.tipHeight();
const N = 1100;
const esplora = await serveEsplora(chain);
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const keysFile = path.join(tmp, 'keys', 'api-keys.json');
const store = new KeyStore(keysFile);
const KEY = store.create('serve test', 100_000, 1_000_000).key;
const SMALL = store.create('ten a minute', 10, 1000).key;
const DAY = store.create('fifteen a day', 100, 15).key;
const env = { ...process.env };
for (const k of ['API_KEYS_FILE', 'API_KEY_REQUIRED', 'ADMIN_SECRET', 'COLLECTION', 'RULES_FILE', 'RULES_BLOCK', 'START_HEIGHT', 'RULES_INSCRIPTION_ID', 'STOP_HEIGHT',
  'FOLLOW_ALL', 'REGISTRY_START', 'BITCOIN_RPC', 'BITCOIN_RPC_COOKIE', 'CHAIN_API', 'MEMPOOL_API', 'CACHE_DIR', 'PORT', 'NETWORK', 'PUBLIC_LIMIT', 'TRUST_PROXY']) delete env[k];
const port = await freePort();
const proc = spawn(process.execPath, [INDEXER], {
  env: { ...env, NETWORK: 'signet', CHAIN_API: esplora.url, RULES_INSCRIPTION_ID: P.id, START_HEIGHT: String(TIP - 7), REGISTRY_START: String(TIP - 7),
    CACHE_DIR: path.join(tmp, 'cache'), PORT: String(port), API_KEYS_FILE: keysFile, PUBLIC_LIMIT: '10' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const err = [];
proc.stderr.on('data', (d) => err.push(d));
const K = { 'x-api-key': KEY };
const waitFor = async (ok, what, tries = 300) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(port, '/status', K); if (r.status === 200 && ok(r.json())) return r; } catch { /* not listening yet */ }
    if (proc.exitCode !== null) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  console.log(Buffer.concat(err).toString().slice(-2000));
  throw new Error(`the indexer never reached ${what}`);
};
try {
  await waitFor((s) => s.lastHeight === TIP, 'the tip');
  const day = (r) => Number(r.headers['x-ratelimit-daily-remaining']);
  const V = versionAt(TIP, chain.hashAt(TIP));

  // encodings on the wire
  const plain = await get(port, '/state', K);
  const st = plain.json();
  check('server: the state at the tip has 1,100 notes and is over 256 KB (brotli quality 4)', st.noteCount === N && plain.body.length > BR_Q11_MAX, [st.noteCount, plain.body.length]);
  check('server: identity sends content-length and no content-encoding', plain.headers['content-encoding'] === undefined && Number(plain.headers['content-length']) === plain.body.length && plain.headers['transfer-encoding'] === undefined);
  const gz = await get(port, '/state', { ...K, 'accept-encoding': 'gzip' });
  check("server: 'gzip' gets gzip (1f8b), content-length, vary, no-cache, the ETag", gz.headers['content-encoding'] === 'gzip' && gz.body[0] === 0x1f && gz.body[1] === 0x8b && Number(gz.headers['content-length']) === gz.body.length
    && zlib.gunzipSync(gz.body).equals(plain.body) && gz.headers.vary === 'accept-encoding' && gz.headers['cache-control'] === 'no-cache' && gz.headers.etag === plain.headers.etag);
  const br = await get(port, '/state', { ...K, 'accept-encoding': 'gzip, deflate, br' });
  check("server: 'gzip, deflate, br' gets br, quality 4 for an answer over 256 KB", br.headers['content-encoding'] === 'br' && Number(br.headers['content-length']) === br.body.length
    && zlib.brotliDecompressSync(br.body).equals(plain.body) && br.body.equals(brAt(plain.body, 4)));
  const part = await get(port, '/state?since=700', { ...K, 'accept-encoding': 'br' });
  const partPlain = await get(port, '/state?since=700', K);
  check('server: br is quality 11 for an answer of 256 KB or less', part.headers['content-encoding'] === 'br' && partPlain.body.length <= BR_Q11_MAX && part.body.equals(brAt(partPlain.body, 11)), [partPlain.body.length]);
  const refused = await Promise.all(['gzip;q=0', 'br;q=0, gzip', '*', 'identity'].map((ae) => get(port, '/state', { ...K, 'accept-encoding': ae })));
  check("server: 'gzip;q=0' identity, 'br;q=0, gzip' gzip, '*' br, 'identity' identity", same(refused.map((r) => r.headers['content-encoding'] ?? 'identity'), ['identity', 'gzip', 'br', 'identity']));
  const small = await get(port, '/status', { ...K, 'accept-encoding': 'br, gzip' });
  check('server: /status (under 1 KB) is plain, with content-length', small.headers['content-encoding'] === undefined && Number(small.headers['content-length']) === small.body.length && small.body.length <= MIN_COMPRESS);
  const nf = await get(port, '/nope', K);
  check('server: an error answer has content-length too', nf.status === 404 && Number(nf.headers['content-length']) === nf.body.length);

  // ETags and If-None-Match, with what each call is charged
  check('server: the ETag is "<height>-<last 8 hex of the block hash>-<12 hex of the key>"', plain.headers.etag === etagOf('/state', V), plain.headers.etag);
  const tag = plain.headers.etag;
  let last = await get(port, '/status', K);
  const nm = [];
  for (const h of [tag, `W/${tag}`, `"nope", W/${tag}`, '*']) {
    const r = await get(port, '/state', { ...K, 'if-none-match': h });
    nm.push([h, r.status, r.body.length, r.headers['x-cost'], day(last) - day(r)]);
    last = r;
  }
  check('server: If-None-Match exact, W/, a list and * each give 304 at 1 unit (x-cost 1)', nm.every(([, s, len, cost, charged]) => s === 304 && len === 0 && cost === '1' && charged === 1), nm);
  const miss = await get(port, '/state', { ...K, 'if-none-match': '"nope"' });
  check('server: an ETag that does not match gets the answer at its price (x-cost 20)', miss.status === 200 && miss.headers['x-cost'] === '20' && day(last) - day(miss) === 20);

  // since
  last = await get(port, '/status', K);
  const bads = [];
  for (const s of ['abc', '-1', '1e3', '1.5', '']) bads.push(await get(port, `/state?since=${encodeURIComponent(s)}`, K));
  const after = await get(port, '/status', K);
  check('server: since=abc, -1, 1e3, 1.5 or empty gives 400, before the gate, and charges nothing', bads.every((r) => r.status === 400 && r.json().error === 'since must be a whole number' && r.headers['x-cost'] === undefined && r.headers['x-ratelimit-remaining'] === undefined)
    && day(last) - day(after) === 1, bads.map((r) => [r.status, r.headers['x-cost']]).concat([[day(last), day(after)]]));
  const one = await get(port, '/state?since=1', K);
  check(`server: since=1 at ${N} notes costs ${costOf('/state', 1, N)} (x-cost = the charge) and returns ${N - 1} notes`, one.headers['x-cost'] === String(costOf('/state', 1, N)) && costOf('/state', 1, N) === 7
    && day(after) - day(one) === 7 && one.json().notes.length === N - 1);
  const poll = await get(port, `/state?since=${N}`, K);
  const past = await get(port, '/state?since=999999', K);
  check('server: since above the note count is the note count: one cache key and ETag, a poll\'s price', past.status === 200 && past.headers.etag === poll.headers.etag && past.headers.etag === etagOf(`/state?since=${N}`, V)
    && past.body.equals(poll.body) && past.headers['x-cost'] === '5' && past.json().notes.length === 0, [past.headers.etag, poll.headers.etag]);
  const zero = await get(port, '/state?since=0', K);
  check('server: since=0 is the full state (key /state, 20 units)', zero.headers.etag === tag && zero.headers['x-cost'] === '20' && zero.body.equals(plain.body));

  // the gate
  const s403 = await get(port, '/state', { 'x-api-key': SMALL });
  const sOk = await get(port, '/status', { 'x-api-key': SMALL });
  check('gate: a call over the key\'s whole minute gives 403 with cost and limit, x-cost 0, and charges nothing', s403.status === 403 && same(s403.json(), { error: 'This answer costs 20 units; this key allows 10 a minute. Ask for a higher limit.', cost: 20, limit: 10 })
    && s403.headers['x-cost'] === '0' && s403.headers['retry-after'] === undefined && sOk.status === 200 && sOk.headers['x-ratelimit-remaining'] === '9', [s403.status, s403.body.toString(), sOk.headers['x-ratelimit-remaining']]);
  const d403 = await get(port, '/state', { 'x-api-key': DAY });
  check('gate: a call over the key\'s whole day gives 403 with cost and limit', d403.status === 403 && same(d403.json(), { error: 'This answer costs 20 units; this key allows 15 a day. Ask for a higher limit.', cost: 20, limit: 15 }), d403.body.toString());
  const dPoll = await get(port, `/state?since=${N}`, { 'x-api-key': DAY });
  check('gate: the same key still gets what fits (a 5-unit poll)', dPoll.status === 200 && dPoll.headers['x-cost'] === '5' && dPoll.headers['x-ratelimit-daily-remaining'] === '10');
  const k403 = await get(port, '/state');
  check('gate: without a key, a call over the per-address minute gives 403 with cost and limit', k403.status === 403 && same(k403.json(), { error: 'This answer costs 20 units; a caller without an API key gets 10 a minute. Use an API key.', cost: 20, limit: 10 }) && k403.headers['x-cost'] === '0', k403.body.toString());
  const kOk = await get(port, '/status');
  check('gate: keyless calls that fit still pass, with x-cost', kOk.status === 200 && kOk.headers['x-cost'] === '1');
  const bad = await get(port, '/state', { 'x-api-key': 'shord_' + 'a'.repeat(43) });
  check('gate: a wrong key is still 401 (x-cost 0)', bad.status === 401 && bad.headers['x-cost'] === '0');
  const prev = await get(port, '/status', K);
  const reg = await get(port, '/registry', K);
  check('gate: x-cost is on every gated answer and equals the charge (1 for /registry)', reg.headers['x-cost'] === '1' && day(prev) - day(reg) === 1);

  // headers
  const opt = await get(port, '/state', {}, 'OPTIONS');
  check('headers: OPTIONS has allow-headers, allow-methods GET and max-age 7200', opt.status === 204 && opt.headers['access-control-max-age'] === '7200' && opt.headers['access-control-allow-methods'] === 'GET'
    && opt.headers['access-control-allow-headers'] === 'x-api-key, authorization, if-none-match' && opt.headers['access-control-allow-origin'] === '*');
  check('headers: a GET 200 has allow-origin and exposes x-cost, but no allow-headers, allow-methods or max-age', plain.headers['access-control-allow-origin'] === '*' && /\bx-cost\b/.test(plain.headers['access-control-expose-headers'])
    && /\betag\b/.test(plain.headers['access-control-expose-headers']) && plain.headers['access-control-allow-headers'] === undefined && plain.headers['access-control-allow-methods'] === undefined && plain.headers['access-control-max-age'] === undefined);
  check('headers: errors carry allow-origin too', nf.headers['access-control-allow-origin'] === '*' && s403.headers['access-control-allow-origin'] === '*');

  // a block replaced at the same height
  const before = {};
  for (const p of ['/status', '/state', '/registry', '/collections', '/names/info', '/names/carol.naka', '/collection']) before[p] = await get(port, p, K);
  check('reorg: before, every answer is versioned by the tip block', ['/status', '/state', '/registry', '/names/info', '/collection'].every((p) => before[p].headers.etag === etagOf(p, V)));
  const forked = chain.source.fork(TIP);
  const V2 = versionAt(TIP, forked.hashes[0]);
  console.log('      (waiting for the indexer\'s next sync round, up to 20 s)');
  await waitFor((s) => s.blockHash === forked.hashes[0], 'the replaced block', 250);
  // the registry replays next to the primary and may publish a moment later
  for (let i = 0; i < 100 && (await get(port, '/names/info', K)).headers.etag !== etagOf('/names/info', V2); i++) await new Promise((res) => setTimeout(res, 200));
  const nowStatus = await get(port, '/status', K);
  check('reorg: same height, new block hash: /status is rebuilt (new blockHash) with another ETag', nowStatus.json().lastHeight === TIP && nowStatus.json().blockHash === forked.hashes[0]
    && nowStatus.headers.etag === etagOf('/status', V2) && nowStatus.headers.etag !== before['/status'].headers.etag);
  const stale = await get(port, '/state', { ...K, 'if-none-match': before['/state'].headers.etag });
  check('reorg: the old /state ETag no longer gives a 304: the answer is sent again (rebuilt) with the new ETag', stale.status === 200 && stale.headers.etag === etagOf('/state', V2) && stale.headers['x-cost'] === '20');
  const now = {};
  for (const p of ['/registry', '/collections', '/names/info', '/names/carol.naka', '/collection']) now[p] = await get(port, p, { ...K, 'if-none-match': before[p].headers.etag });
  check('reorg: /registry, /collections, the names and /collection change ETag too (no stale 304)', Object.entries(now).every(([p, r]) => r.status === 200 && r.headers.etag !== before[p].headers.etag)
    && now['/registry'].headers.etag === etagOf('/registry', V2) && now['/names/info'].headers.etag === etagOf('/names/info', V2), Object.entries(now).map(([p, r]) => [p, r.status, before[p].headers.etag, r.headers.etag]));
} finally {
  proc.kill();
  await new Promise((ok) => (proc.exitCode !== null ? ok() : proc.on('exit', ok)));
  await esplora.close();
}

// ---- sizes on captured hosted-API answers (optional) ------------------------------------------------
const dir = process.env.SERVE_PAYLOADS?.trim();
if (dir) {
  const files = { state: 'state.json', since: 'since-state.json', listings: 'listings.json' };
  const size = {};
  for (const [k, f] of Object.entries(files)) {
    const json = fs.readFileSync(path.join(dir, f));
    const e = { json, enc: { gzip: null, br: null } };
    const [g, b] = [await encoded(e, 'gzip'), await encoded(e, 'br')];
    size[k] = { raw: json.length, gzip: g.length, br: b.length };
    if (!zlib.gunzipSync(g).equals(json) || !zlib.brotliDecompressSync(b).equals(json)) size[k].roundTrip = false;
  }
  console.log(`      sizes: ${JSON.stringify(size)}`);
  check('sizes: /listings br <= 9.5 KB and gzip <= 11.8 KB', size.listings.br <= 9_500 && size.listings.gzip <= 11_800 && size.listings.roundTrip === undefined, size.listings);
  check('sizes: /state br <= 1.95 MB and gzip <= 2.28 MB', size.state.br <= 1_950_000 && size.state.gzip <= 2_280_000 && size.state.roundTrip === undefined, size.state);
  check('sizes: /state?since br <= 0.63 MB', size.since.br <= 630_000 && size.since.roundTrip === undefined, size.since);
} else console.log('      (SERVE_PAYLOADS not set: the size checks on captured answers are skipped)');

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held open; the OS cleans its temp folder */ }
process.exit(fail ? 1 : 0);
