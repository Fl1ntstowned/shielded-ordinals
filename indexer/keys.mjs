// API keys and request limits for an indexer that serves other people (indexer.mjs turns this on
// when API_KEYS_FILE is set). An indexer you run for yourself needs none of it.
//
//   - A key looks like  shord_<43 characters>.  Only its SHA-256 is stored, so the keys file can't
//     be used to call the API.
//   - A caller sends it as  x-api-key: <key>  or  Authorization: Bearer <key>.
//   - Every key has its own limits: units per minute and units per day. Most routes cost one unit;
//     the heavy ones cost more (the indexer decides; the full state costs 20), so a key can never
//     pull more than its share of bytes however it spreads its calls.
//   - A caller without a key shares a much lower limit with everyone at the same address, or is
//     refused when API_KEY_REQUIRED=1 (a few small routes stay open).
//   - Units are counted per key and per day, UTC (usage.json next to the keys file). The daily
//     limit is enforced from that count.
//
// Manage keys on the machine that holds the file:
//   node indexer/keys.mjs create "<who it is for>" [units per minute] [units per day]
//   node indexer/keys.mjs list
//   node indexer/keys.mjs revoke <id>
// A running indexer picks up the change within a few seconds; no restart.
//
// The same three commands against a RUNNING indexer somewhere else (its ADMIN_SECRET is set):
//   node indexer/keys.mjs create "<who>" [per minute] [per day] --at https://<host> --secret-file ~/.secrets/indexer-admin.txt
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LIMIT = 60; // units a minute
export const DEFAULT_DAILY = 5000; // units a day

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const newKey = () => 'shord_' + crypto.randomBytes(32).toString('base64url');
const KEY_SHAPE = /^shord_[A-Za-z0-9_-]{43}$/;
const today = () => new Date().toISOString().slice(0, 10);
const secondsToMidnightUtc = () => {
  const n = new Date();
  return Math.max(1, Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000));
};
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
};
const wholeAbove0 = (n) => Number.isInteger(n) && n > 0;

/** The keys file: { "<sha256 of the key>": { id, label, limit, daily, created, revoked } }. */
export class KeyStore {
  constructor(file) { this.file = file; this.keys = {}; this.mtime = -1; this.checked = 0; }
  load(force = false) {
    if (!force && Date.now() - this.checked < 3000) return this.keys;
    this.checked = Date.now();
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch { m = 0; }
    if (m !== this.mtime) { this.mtime = m; this.keys = m ? readJson(this.file, {}) : {}; }
    return this.keys;
  }
  /** The record of a presented key, or null (unknown, malformed or revoked). */
  find(key) {
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return null;
    const rec = this.load()[hashKey(key)];
    return rec && !rec.revoked ? rec : null;
  }
  create(label, limit = DEFAULT_LIMIT, daily = DEFAULT_DAILY) {
    if (!wholeAbove0(limit) || !wholeAbove0(daily)) throw new Error('limits must be whole numbers above 0');
    const keys = { ...this.load(true) };
    const key = newKey();
    const rec = { id: crypto.randomBytes(4).toString('hex'), label: String(label).slice(0, 80), limit, daily, created: new Date().toISOString(), revoked: null };
    keys[hashKey(key)] = rec;
    writeJson(this.file, keys);
    this.load(true);
    return { key, ...rec };
  }
  /** Change a key's limits. */
  setLimits(id, { limit, daily }) {
    const keys = { ...this.load(true) };
    const hit = Object.values(keys).find((k) => k.id === id && !k.revoked);
    if (!hit) return false;
    if (limit !== undefined) { if (!wholeAbove0(limit)) throw new Error('limit must be a whole number above 0'); hit.limit = limit; }
    if (daily !== undefined) { if (!wholeAbove0(daily)) throw new Error('daily must be a whole number above 0'); hit.daily = daily; }
    writeJson(this.file, keys);
    this.load(true);
    return true;
  }
  revoke(id) {
    const keys = { ...this.load(true) };
    const hit = Object.values(keys).find((k) => k.id === id && !k.revoked);
    if (!hit) return false;
    hit.revoked = new Date().toISOString();
    writeJson(this.file, keys);
    this.load(true);
    return true;
  }
  list() { return Object.values(this.load(true)); }
}

/** Fixed one-minute windows per caller, in units. Returns { ok, limit, remaining, retryAfter }. */
export class Limiter {
  constructor() { this.hits = new Map(); }
  take(who, limit, now = Date.now(), cost = 1) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    let h = this.hits.get(who);
    if (!h || h.windowStart !== windowStart) { h = { windowStart, n: 0 }; this.hits.set(who, h); }
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.windowStart !== windowStart) this.hits.delete(k);
    const retryAfter = Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
    if (h.n + cost > limit) return { ok: false, limit, remaining: Math.max(0, limit - h.n), retryAfter };
    h.n += cost;
    return { ok: true, limit, remaining: limit - h.n, retryAfter };
  }
}

/** Units per key per day (UTC), written to disk at most every 30 s (and on exit). */
export class Usage {
  constructor(file) {
    this.file = file;
    this.days = readJson(file, {});
    this.dirty = false;
    setInterval(() => this.flush(), 30_000).unref();
    process.on('exit', () => this.flush());
  }
  count(id, cost = 1) {
    const d = (this.days[today()] ??= {});
    d[id] = (d[id] ?? 0) + cost;
    this.dirty = true;
  }
  today(id) { return this.days[today()]?.[id] ?? 0; }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    // keep 400 days
    const keep = Object.keys(this.days).sort().slice(-400);
    this.days = Object.fromEntries(keep.map((k) => [k, this.days[k]]));
    try { writeJson(this.file, this.days); } catch (e) { console.error('usage file:', e.message); this.dirty = true; }
  }
  of(id) { return Object.fromEntries(Object.entries(this.days).filter(([, d]) => d[id]).map(([day, d]) => [day, d[id]])); }
}

/** The caller's address. `hops` = how many proxies in front of this server are trusted (0 = none). */
export function callerAddress(req, hops = 0) {
  const direct = req.socket?.remoteAddress ?? 'unknown';
  if (!hops) return direct;
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  chain.push(direct);
  return chain[Math.max(0, chain.length - 1 - hops)] ?? direct;
}

export const presentedKey = (req) => {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const a = String(req.headers.authorization ?? '');
  return /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : null;
};

/**
 * The gate an indexer puts in front of its routes.
 *   check(req, cost, { open }) -> { ok: true, who, headers } | { ok: false, status, error, headers }
 * `cost`: units this request counts for. `open`: the route may be called without a key even when
 * keys are required (it still shares the keyless limit).
 */
export function makeGate({ keysFile, required = false, publicLimit = 30, defaultLimit = DEFAULT_LIMIT, defaultDaily = DEFAULT_DAILY, trustProxy = 0 }) {
  const store = new KeyStore(keysFile);
  const usage = new Usage(path.join(path.dirname(path.resolve(keysFile)), 'usage.json'));
  const limiter = new Limiter();
  const headersOf = (t, daily) => ({
    'x-ratelimit-limit': String(t.limit), 'x-ratelimit-remaining': String(t.remaining),
    ...(daily ? { 'x-ratelimit-daily-limit': String(daily.limit), 'x-ratelimit-daily-remaining': String(daily.remaining) } : {}),
    ...(t.ok ? {} : { 'retry-after': String(t.retryAfter) }),
  });
  return {
    store, usage, required,
    check(req, cost = 1, { open = false } = {}) {
      const key = presentedKey(req);
      if (key) {
        const rec = store.find(key);
        if (!rec) return { ok: false, status: 401, error: 'This API key is not valid.', headers: {} };
        const limit = rec.limit ?? defaultLimit;
        const dailyLimit = rec.daily ?? defaultDaily;
        const used = usage.today(rec.id);
        if (used + cost > dailyLimit) {
          const t = { ok: false, limit, remaining: 0, retryAfter: secondsToMidnightUtc() };
          return { ok: false, status: 429, error: 'This key has used its allowance for today. It resets at midnight UTC.', headers: headersOf(t, { limit: dailyLimit, remaining: Math.max(0, dailyLimit - used) }) };
        }
        const t = limiter.take('k:' + rec.id, limit, Date.now(), cost);
        if (!t.ok) return { ok: false, status: 429, error: `Too many requests for this key. Try again in ${t.retryAfter} s.`, headers: headersOf(t, { limit: dailyLimit, remaining: dailyLimit - used }) };
        usage.count(rec.id, cost);
        return { ok: true, who: rec.id, headers: headersOf(t, { limit: dailyLimit, remaining: dailyLimit - used - cost }) };
      }
      if (required && !open) return { ok: false, status: 401, error: 'An API key is needed. Send it in the x-api-key header.', headers: {} };
      const t = limiter.take('a:' + callerAddress(req, trustProxy), publicLimit, Date.now(), cost);
      if (!t.ok) return { ok: false, status: 429, error: `Too many requests without an API key. Try again in ${t.retryAfter} s, or use a key.`, headers: headersOf(t) };
      return { ok: true, who: null, headers: headersOf(t) };
    },
  };
}

// ---- command line ----
const row = (k, units) => `${k.id}  ${k.revoked ? 'REVOKED' : 'active '}  ${String(k.limit ?? DEFAULT_LIMIT).padStart(5)}/min ${String(k.daily ?? DEFAULT_DAILY).padStart(7)}/day  ${String(units).padStart(9)} units  ${k.created.slice(0, 10)}  ${k.label}`;
const shown = (k) => `key    ${k.key}\nid     ${k.id}\nfor    ${k.label}\nlimit  ${k.limit} units a minute, ${k.daily} a day\n\nThis is the only time the key is shown. Only its hash is stored.`;
const usageText = 'node indexer/keys.mjs create "<who it is for>" [units per minute] [units per day]\nnode indexer/keys.mjs limits <id> <units per minute> <units per day>\nnode indexer/keys.mjs list\nnode indexer/keys.mjs revoke <id>\n\nAdd  --at https://<host> --secret-file <path>  to do the same on a running indexer.\nThe local keys file is API_KEYS_FILE (default api-keys.json).';

async function remote(argv, at, secretFile) {
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const base = at.replace(/\/+$/, '');
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };
  const [cmd, a, b, c] = argv;
  if (cmd === 'create' && a) {
    console.log(shown(await call('/admin/keys', { label: a, ...(b ? { limit: Number(b) } : {}), ...(c ? { daily: Number(c) } : {}) })));
  } else if (cmd === 'limits' && a && b && c) {
    await call('/admin/keys/limits', { id: a, limit: Number(b), daily: Number(c) });
    console.log(`limits of ${a}: ${b} a minute, ${c} a day`);
  } else if (cmd === 'list') {
    const rows = await call('/admin/keys');
    if (!rows.length) console.log('no keys');
    for (const k of rows) console.log(row(k, Object.values(k.usage ?? {}).reduce((s, n) => s + n, 0)));
  } else if (cmd === 'revoke' && a) {
    await call('/admin/keys/revoke', { id: a });
    console.log(`revoked ${a}`);
  } else throw new Error(usageText);
}

function local(argv) {
  const file = process.env.API_KEYS_FILE?.trim() || 'api-keys.json';
  const store = new KeyStore(file);
  const [cmd, a, b, c] = argv;
  if (cmd === 'create' && a) {
    console.log(shown(store.create(a, b ? Number(b) : DEFAULT_LIMIT, c ? Number(c) : DEFAULT_DAILY)));
  } else if (cmd === 'limits' && a && b && c) {
    if (!store.setLimits(a, { limit: Number(b), daily: Number(c) })) throw new Error(`no active key with id ${a}`);
    console.log(`limits of ${a}: ${b} a minute, ${c} a day`);
  } else if (cmd === 'list') {
    const usage = readJson(path.join(path.dirname(path.resolve(file)), 'usage.json'), {});
    const total = (id) => Object.values(usage).reduce((s, d) => s + (d[id] ?? 0), 0);
    const rows = store.list();
    if (!rows.length) console.log(`no keys in ${file}`);
    for (const k of rows) console.log(row(k, total(k.id)));
  } else if (cmd === 'revoke' && a) {
    if (!store.revoke(a)) throw new Error(`no active key with id ${a}`);
    console.log(`revoked ${a}`);
  } else {
    console.log(usageText);
    if (cmd) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return null; const v = argv[i + 1] ?? null; argv.splice(i, 2); return v; };
  const at = take('--at');
  const secretFile = take('--secret-file');
  const run = at || secretFile
    ? (at && secretFile ? remote(argv, at, secretFile) : Promise.reject(new Error('--at <url> and --secret-file <path> go together')))
    : Promise.resolve().then(() => local(argv));
  run.catch((e) => { console.error(e.message); process.exit(1); });
}
