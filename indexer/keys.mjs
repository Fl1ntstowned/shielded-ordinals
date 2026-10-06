// API keys and request limits for an indexer that serves other people (indexer.mjs turns this on
// when API_KEYS_FILE is set). An indexer you run for yourself needs none of it.
//
//   - A key looks like  shord_<43 characters>.  Only its SHA-256 is stored, so the keys file can't
//     be used to call the API.
//   - A caller sends it as  x-api-key: <key>  or  Authorization: Bearer <key>.
//   - Every key has its own limit (requests per minute). A caller without a key shares a much
//     lower limit with everyone at the same address, or is refused when API_KEY_REQUIRED=1.
//   - Calls are counted per key and per day (usage.json next to the keys file).
//
// Manage keys on the machine that holds the file:
//   node indexer/keys.mjs create "<who it is for>" [requests per minute]
//   node indexer/keys.mjs list
//   node indexer/keys.mjs revoke <id>
// A running indexer picks up the change within a few seconds; no restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const newKey = () => 'shord_' + crypto.randomBytes(32).toString('base64url');
const KEY_SHAPE = /^shord_[A-Za-z0-9_-]{43}$/;
const today = () => new Date().toISOString().slice(0, 10);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
};

/** The keys file: { "<sha256 of the key>": { id, label, limit, created, revoked } }. */
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
  create(label, limit) {
    const keys = { ...this.load(true) };
    const key = newKey();
    const rec = { id: crypto.randomBytes(4).toString('hex'), label: String(label).slice(0, 80), limit, created: new Date().toISOString(), revoked: null };
    keys[hashKey(key)] = rec;
    writeJson(this.file, keys);
    this.load(true);
    return { key, ...rec };
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

/** Fixed one-minute windows per caller. Returns { ok, limit, remaining, retryAfter }. */
export class Limiter {
  constructor() { this.hits = new Map(); }
  take(who, limit, now = Date.now()) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    let h = this.hits.get(who);
    if (!h || h.windowStart !== windowStart) { h = { windowStart, n: 0 }; this.hits.set(who, h); }
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.windowStart !== windowStart) this.hits.delete(k);
    const retryAfter = Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
    if (h.n >= limit) return { ok: false, limit, remaining: 0, retryAfter };
    h.n++;
    return { ok: true, limit, remaining: limit - h.n, retryAfter };
  }
}

/** Calls per key per day, written to disk at most every 30 s (and on exit). */
export class Usage {
  constructor(file) {
    this.file = file;
    this.days = readJson(file, {});
    this.dirty = false;
    setInterval(() => this.flush(), 30_000).unref();
    process.on('exit', () => this.flush());
  }
  count(id) {
    const d = (this.days[today()] ??= {});
    d[id] = (d[id] ?? 0) + 1;
    this.dirty = true;
  }
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
 *   check(req) -> { ok: true, who, headers } | { ok: false, status, error, headers }
 */
export function makeGate({ keysFile, required = false, publicLimit = 30, defaultLimit = 600, trustProxy = 0 }) {
  const store = new KeyStore(keysFile);
  const usage = new Usage(path.join(path.dirname(path.resolve(keysFile)), 'usage.json'));
  const limiter = new Limiter();
  const headersOf = (t) => ({ 'x-ratelimit-limit': String(t.limit), 'x-ratelimit-remaining': String(t.remaining), ...(t.ok ? {} : { 'retry-after': String(t.retryAfter) }) });
  return {
    store, usage,
    check(req) {
      const key = presentedKey(req);
      if (key) {
        const rec = store.find(key);
        if (!rec) return { ok: false, status: 401, error: 'This API key is not valid.', headers: {} };
        const t = limiter.take('k:' + rec.id, rec.limit ?? defaultLimit);
        if (!t.ok) return { ok: false, status: 429, error: `Too many requests for this key. Try again in ${t.retryAfter} s.`, headers: headersOf(t) };
        usage.count(rec.id);
        return { ok: true, who: rec.id, headers: headersOf(t) };
      }
      if (required) return { ok: false, status: 401, error: 'An API key is needed. Send it in the x-api-key header.', headers: {} };
      const t = limiter.take('a:' + callerAddress(req, trustProxy), publicLimit);
      if (!t.ok) return { ok: false, status: 429, error: `Too many requests without an API key. Try again in ${t.retryAfter} s, or use a key.`, headers: headersOf(t) };
      return { ok: true, who: null, headers: headersOf(t) };
    },
  };
}

// ---- command line ----
// Same three commands against a RUNNING indexer somewhere else (its ADMIN_SECRET is set):
//   node indexer/keys.mjs create "<who>" [limit] --at https://<host> --secret-file ~/.secrets/indexer-admin.txt
async function remote(cmd, a, b, at, secretFile) {
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const base = at.replace(/\/+$/, '');
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };
  if (cmd === 'create' && a) {
    const k = await call('/admin/keys', { label: a, limit: b ? Number(b) : 600 });
    console.log(`key    ${k.key}\nid     ${k.id}\nfor    ${k.label}\nlimit  ${k.limit} requests a minute\n\nThis is the only time the key is shown. Only its hash is stored.`);
  } else if (cmd === 'list') {
    const rows = await call('/admin/keys');
    if (!rows.length) console.log('no keys');
    for (const k of rows) {
      const total = Object.values(k.usage ?? {}).reduce((s, n) => s + n, 0);
      console.log(`${k.id}  ${k.revoked ? 'REVOKED' : 'active '}  ${String(k.limit).padStart(5)}/min  ${String(total).padStart(9)} calls  ${k.created.slice(0, 10)}  ${k.label}`);
    }
  } else if (cmd === 'revoke' && a) {
    await call('/admin/keys/revoke', { id: a });
    console.log(`revoked ${a}`);
  } else throw new Error('create "<who>" [limit] | list | revoke <id>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return null; const v = argv[i + 1] ?? null; argv.splice(i, 2); return v; };
  const at = take('--at');
  const secretFile = take('--secret-file');
  if (at || secretFile) {
    if (!at || !secretFile) { console.error('--at <url> and --secret-file <path> go together'); process.exit(1); }
    remote(argv[0], argv[1], argv[2], at, secretFile).catch((e) => { console.error(e.message); process.exit(1); });
  } else {
  const file = process.env.API_KEYS_FILE?.trim() || 'api-keys.json';
  const store = new KeyStore(file);
  const [cmd, a, b] = argv;
  if (cmd === 'create' && a) {
    const limit = b ? Number(b) : 600;
    if (!Number.isInteger(limit) || limit < 1) { console.error('requests per minute must be a whole number above 0'); process.exit(1); }
    const k = store.create(a, limit);
    console.log(`key    ${k.key}`);
    console.log(`id     ${k.id}`);
    console.log(`for    ${k.label}`);
    console.log(`limit  ${k.limit} requests a minute`);
    console.log('\nThis is the only time the key is shown. Only its hash is stored.');
  } else if (cmd === 'list') {
    const usage = readJson(path.join(path.dirname(path.resolve(file)), 'usage.json'), {});
    const total = (id) => Object.values(usage).reduce((s, d) => s + (d[id] ?? 0), 0);
    const rows = store.list();
    if (!rows.length) console.log(`no keys in ${file}`);
    for (const k of rows) console.log(`${k.id}  ${k.revoked ? 'REVOKED' : 'active '}  ${String(k.limit).padStart(5)}/min  ${String(total(k.id)).padStart(9)} calls  ${k.created.slice(0, 10)}  ${k.label}`);
  } else if (cmd === 'revoke' && a) {
    console.log(store.revoke(a) ? `revoked ${a}` : `no active key with id ${a}`);
    if (!store.list().some((k) => k.id === a)) process.exit(1);
  } else {
    console.log('node indexer/keys.mjs create "<who it is for>" [requests per minute]\nnode indexer/keys.mjs list\nnode indexer/keys.mjs revoke <id>\n\nThe keys file is API_KEYS_FILE (default api-keys.json).');
    process.exit(cmd ? 1 : 0);
  }
  }
}
