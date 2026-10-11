// API keys and request limits (indexer/keys.mjs), offline.
//   node test/api-keys.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGate, KeyStore, Limiter, hashKey, callerAddress, DEFAULT_LIMIT, DEFAULT_DAILY } from '../indexer/keys.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shord-keys-'));
const file = path.join(dir, 'api-keys.json');
let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); ok ? pass++ : fail++; };
const req = (headers = {}, addr = '10.0.0.1') => ({ headers, socket: { remoteAddress: addr } });

const gate = makeGate({ keysFile: file, publicLimit: 3 });
const made = gate.store.create('test developer', 5, 12);

check('a key has the documented shape', /^shord_[A-Za-z0-9_-]{43}$/.test(made.key));
const onDisk = fs.readFileSync(file, 'utf8');
check('the keys file holds the hash, never the key', !onDisk.includes(made.key) && onDisk.includes(hashKey(made.key)));

// no key: the low shared limit per address
const open = [1, 2, 3, 4].map(() => gate.check(req()));
check('without a key the first calls pass', open.slice(0, 3).every((r) => r.ok));
check('without a key the limit refuses the next call with 429 and Retry-After', open[3].status === 429 && Number(open[3].headers['retry-after']) >= 1);
check('another address has its own allowance', gate.check(req({}, '10.0.0.2')).ok);

// with a key
const k1 = gate.check(req({ 'x-api-key': made.key }));
check('a valid key passes and reports what is left', k1.ok && k1.headers['x-ratelimit-limit'] === '5' && k1.headers['x-ratelimit-remaining'] === '4');
check('Authorization: Bearer works the same', gate.check(req({ authorization: `Bearer ${made.key}` })).ok);
check('a key is not held back by the keyless limit of its address', gate.check(req({ 'x-api-key': made.key })).ok);
for (let i = 0; i < 2; i++) gate.check(req({ 'x-api-key': made.key }));
const over = gate.check(req({ 'x-api-key': made.key }, '10.9.9.9'));
check('a key has its own limit, from any address', over.status === 429);
check('a wrong key is refused with 401 (it does not fall back to keyless)', gate.check(req({ 'x-api-key': 'shord_' + 'a'.repeat(43) }, '10.0.0.3')).status === 401);
check('a malformed key is refused with 401', gate.check(req({ 'x-api-key': 'hello' }, '10.0.0.3')).status === 401);
check('units are counted for the key (refused ones are not)', Object.values(gate.usage.of(made.id))[0] === 5);
check('the answer says what is left today', k1.headers['x-ratelimit-daily-limit'] === '12' && k1.headers['x-ratelimit-daily-remaining'] === '11');

// cost: a heavy route counts for more
const heavy = gate.store.create('heavy user', 25, 100);
const h1 = gate.check(req({ 'x-api-key': heavy.key }, '10.0.0.7'), 20);
check('a 20-unit call passes and leaves 5', h1.ok && h1.headers['x-ratelimit-remaining'] === '5');
check('a second 20-unit call in the same minute is refused', gate.check(req({ 'x-api-key': heavy.key }, '10.0.0.7'), 20).status === 429);
check('a 1-unit call still fits', gate.check(req({ 'x-api-key': heavy.key }, '10.0.0.7'), 1).ok);

// a call that costs more than the whole allowance could never pass: 403 at once, not an endless 429
const small = gate.store.create('small key', 10, 50);
const f1 = gate.check(req({ 'x-api-key': small.key }, '10.0.0.10'), 20);
check('a call over the key\'s whole minute gets 403 with cost and limit, and no retry-after', f1.status === 403 && f1.cost === 20 && f1.limit === 10
  && f1.error === 'This answer costs 20 units; this key allows 10 a minute. Ask for a higher limit.' && f1.headers['retry-after'] === undefined && f1.headers['x-ratelimit-limit'] === '10');
check('a 403 counts nothing: the whole minute is still there', gate.usage.today(small.id) === 0 && gate.check(req({ 'x-api-key': small.key }, '10.0.0.10'), 10).ok && gate.usage.today(small.id) === 10);
check('once the minute is used, a call that fits gets the usual 429', gate.check(req({ 'x-api-key': small.key }, '10.0.0.10'), 1).status === 429);
const dayOnly = gate.store.create('small day', 100, 30);
const f2 = gate.check(req({ 'x-api-key': dayOnly.key }, '10.0.0.10'), 40);
check('a call over the key\'s whole day gets 403 with cost and the daily limit', f2.status === 403 && f2.cost === 40 && f2.limit === 30 && f2.error === 'This answer costs 40 units; this key allows 30 a day. Ask for a higher limit.' && gate.usage.today(dayOnly.id) === 0);
check('a call of exactly the limit passes', gate.check(req({ 'x-api-key': dayOnly.key }, '10.0.0.10'), 30).ok);
const f3 = gate.check(req({}, '10.0.0.11'), 5);
check('without a key, a call over the per-address minute gets 403 with cost and limit', f3.status === 403 && f3.cost === 5 && f3.limit === 3
  && f3.error === 'This answer costs 5 units; a caller without an API key gets 3 a minute. Use an API key.');
check('without a key, the 403 takes nothing from the address\'s minute', gate.check(req({}, '10.0.0.11'), 3).ok);

// the daily cap
const day = gate.store.create('daily cap', 1000, 30);
for (let i = 0; i < 30; i++) gate.check(req({ 'x-api-key': day.key }, '10.0.0.8'), 1);
const capped = gate.check(req({ 'x-api-key': day.key }, '10.0.0.8'), 1);
check('the daily cap refuses with 429 and says when it resets', capped.status === 429 && /today/.test(capped.error) && Number(capped.headers['retry-after']) >= 1 && capped.headers['x-ratelimit-daily-remaining'] === '0');
check('raising the limits lets the key through again', gate.store.setLimits(day.id, { daily: 31 }) && gate.check(req({ 'x-api-key': day.key }, '10.0.0.8'), 1).ok);
check('limits refuse nonsense', (() => { try { gate.store.setLimits(day.id, { daily: 0 }); return false; } catch { return true; } })());
check('defaults are 60 a minute and 5000 a day', DEFAULT_LIMIT === 60 && DEFAULT_DAILY === 5000 && gate.store.create('defaults').limit === 60 && gate.store.create('defaults 2').daily === 5000);

// revoke
check('revoke answers true for a live key', gate.store.revoke(made.id) === true);
check('a revoked key is refused at once', gate.check(req({ 'x-api-key': made.key }, '10.0.0.4')).status === 401);
check('revoking twice answers false', gate.store.revoke(made.id) === false);

// a change made by another process (the command line) is picked up without a restart
const cli = fileURLToPath(new URL('../indexer/keys.mjs', import.meta.url));
const out = execFileSync(process.execPath, [cli, 'create', 'made by the command line', '7'], { env: { ...process.env, API_KEYS_FILE: file }, encoding: 'utf8' });
const cliKey = /key\s+(shord_\S+)/.exec(out)?.[1];
check('the command line prints a new key once', !!cliKey);
gate.store.checked = 0; // (the running indexer looks again after 3 s; the test does not wait)
check('the running gate accepts it without a restart', gate.check(req({ 'x-api-key': cliKey })).ok);
const list = execFileSync(process.execPath, [cli, 'list'], { env: { ...process.env, API_KEYS_FILE: file }, encoding: 'utf8' });
check('list shows the keys, one revoked, and no key text', /REVOKED/.test(list) && /active/.test(list) && !list.includes(cliKey) && !list.includes(made.key));

// keys required
const strict = makeGate({ keysFile: file, required: true });
check('with keys required, a call without one gets 401', strict.check(req()).status === 401);
check('with keys required, a valid key passes', strict.check(req({ 'x-api-key': cliKey })).ok);
check('with keys required, an open route still answers keyless (shared limit)', strict.check(req({}, '10.0.0.9'), 1, { open: true }).ok);
check('with keys required, a keyless call over the limit is 401 on a keyed route and 403 on an open one', strict.check(req({}, '10.0.0.12'), 50).status === 401 && strict.check(req({}, '10.0.0.12'), 50, { open: true }).status === 403);

// who is calling, behind proxies
const fwd = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '3.3.3.3' } };
check('no trusted proxy: the connecting address counts (a forged header is ignored)', callerAddress(fwd, 0) === '3.3.3.3');
check('one trusted proxy: the address it reports', callerAddress(fwd, 1) === '2.2.2.2');
check('two trusted proxies: the client in front of both', callerAddress(fwd, 2) === '1.1.1.1');
check('more hops than the header has: never past the first entry', callerAddress(fwd, 9) === '1.1.1.1');

// the limiter's window
const lim = new Limiter();
const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
lim.take('x', 1, t0);
check('the limit holds inside the minute', !lim.take('x', 1, t0 + 59_000).ok);
check('and resets in the next minute', lim.take('x', 1, t0 + 60_000).ok);
check('a fresh store on the same file sees the same keys', new KeyStore(file).list().length === gate.store.list().length && gate.store.list().length >= 6);

gate.usage.flush();
check('usage is written next to the keys file', fs.existsSync(path.join(dir, 'usage.json')));
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
