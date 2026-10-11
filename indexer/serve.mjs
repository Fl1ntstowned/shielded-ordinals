// How the indexer serves an answer once it knows which answer a request names (indexer.mjs decides
// that): what it costs, which routes are open, the answer cache, the ETag, and the bytes sent back.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ---- price ---------------------------------------------------------------------------------------
// What a request costs in units (keys.mjs). The full state is the one heavy answer: 20 units.
// /state?since=<n> costs 5 for a poll and 1 more for every 500 notes it returns, up to the full price,
// so ?since=1 is not the whole state at a poll's price. (One function: another formula, for example
// one priced by bytes, is a one-line swap here.)
// A price is always a whole number from 5 to 20: a since past the last note returns no notes (5), and
// a missing or broken note count is the full price, never a lower, negative or NaN one (the gate would
// count those as credit, or as free calls for the rest of the day).
export const STATE_COST = 20;
export const stateCost = (since, noteCount) => {
  if (!(since > 0)) return STATE_COST;
  const returned = Number.isSafeInteger(since) && Number.isSafeInteger(noteCount) ? Math.max(0, noteCount - since) : Infinity;
  return Math.min(STATE_COST, 5 + Math.floor(returned / 500));
};
export const costOf = (path, since = 0, noteCount = null) => (path === '/state' ? stateCost(since, noteCount) : 1);
// Routes anyone may read even when keys are required: tiny, and what a wallet needs to find us.
export const OPEN = new Set(['/status', '/collections']);

/**
 * The `since` of /state: 0 when absent, the number when it is a whole number (digits only), clamped
 * to the note count so every since past the end is one answer (one cache key). null when it is
 * anything else ('abc', '-1', '1e3', '1.5', ''): the caller answers 400, free.
 */
export const parseSince = (raw, noteCount) => {
  if (raw === null || raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw), noteCount);
};

// ---- ETag ----------------------------------------------------------------------------------------
// ETag = version + route: a client that asks again with If-None-Match gets a 304 and no bytes.
export const etagOf = (key, version) => `"${version}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}"`;
/**
 * The version of an answer that follows a chain: "<height>-<last 8 hex of that block's hash>". A
 * block replaced at the same height (a reorg) changes the version, so the answer is built again and
 * a client holding the old one gets the new one, never a 304 for what is no longer on the chain.
 */
export const hashTail = (hash) => (hash ? String(hash).slice(-8) : 'nohash');
export const versionAt = (height, hash) => `${height}-${hashTail(hash)}`;
/**
 * Does If-None-Match name this ETag? A comma list of tags, each strong ("x") or weak (W/"x"),
 * compared without the W/ (weak comparison: the body is the same whatever the encoding), or '*'.
 */
export const notModified = (ifNoneMatch, etag) => {
  if (typeof ifNoneMatch !== 'string' || !ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((t) => {
    const s = t.trim();
    return s === '*' || (s.startsWith('W/') ? s.slice(2).trim() : s) === etag;
  });
};

// ---- encoding ------------------------------------------------------------------------------------
/**
 * The encoding to send for an Accept-Encoding header: br, else gzip, else identity. Each item may
 * carry ;q=; q=0 refuses it. '*' stands for br and gzip unless they are named. Case does not matter.
 *   'gzip, deflate' (Node fetch) -> gzip    'gzip, deflate, br, zstd' (curl --compressed) -> br
 *   'br;q=0, gzip' -> gzip    'gzip;q=0' -> identity    '*' -> br    '' -> identity
 */
export function pickEncoding(header) {
  const q = new Map();
  for (const item of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = item.split(';').map((s) => s.trim());
    if (!name) continue;
    let w = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(p);
      if (m && Number.isFinite(Number(m[1]))) w = Number(m[1]);
    }
    q.set(name, w);
  }
  const ok = (enc) => (q.has(enc) ? q.get(enc) > 0 : q.has('*') && q.get('*') > 0);
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : 'identity';
}

// Only bodies over 1 KB are compressed (below that the headers outweigh the saving).
export const MIN_COMPRESS = 1024;
// Brotli at quality 11 up to 256 KB (/listings: 9.4 KB in about 50 ms), quality 4 above (/state:
// 1.94 MB in about 100 ms, smaller than gzip-9 and faster). Qualities 5-9 are larger AND slower on
// this data; 11 on the full state blocks a thread for seconds.
export const BR_Q11_MAX = 262_144;
const C = zlib.constants;
const run = (fn, buf, opts) => new Promise((ok, no) => fn(buf, opts, (e, out) => (e ? no(e) : ok(out))));
export const compressors = {
  gzip: (buf) => run(zlib.gzip, buf, { level: 9 }),
  br: (buf) => run(zlib.brotliCompress, buf, { params: { [C.BROTLI_PARAM_QUALITY]: buf.length <= BR_Q11_MAX ? 11 : 4, [C.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
};
/** Compression jobs started, per encoding (the tests read it: one job per answer and encoding). */
export const jobs = { gzip: 0, br: 0 };

/**
 * The bytes of an answer in an encoding. Compressed lazily, off the event loop (zlib's thread
 * pool), once per answer and encoding: requests that arrive while the job runs wait for the same
 * job. A failed job is forgotten, so the next request tries again.
 */
export function encoded(entry, enc) {
  if (enc === 'identity' || entry.json.length <= MIN_COMPRESS) return Promise.resolve(entry.json);
  let p = entry.enc[enc];
  if (!p) {
    jobs[enc]++;
    p = entry.enc[enc] = compressors[enc](entry.json).catch((e) => { if (entry.enc[enc] === p) entry.enc[enc] = null; throw e; });
  }
  return p;
}

// ---- the answer cache ----------------------------------------------------------------------------
/**
 * An answer cache. Every answer is built once per version (the state only changes when a block
 * lands), kept as the JSON bytes, and compressed only when someone asks for that encoding, so a
 * thousand readers cost one build and at most one job per encoding.
 *   answer(key, version, build) -> { version, json (Buffer), enc: { gzip, br }, etag }
 *   build() runs only when there is no answer for key at exactly this version.
 * Without `limit`: the indexer's shared cache (past 200 entries it drops all but the /status ones
 * down to 100, and keeps at most 8 partial states). With `limit`: a cache of its own that keeps the
 * `limit` most recently used answers (route modules with keep: 'own').
 */
export function makeAnswers({ limit = 0 } = {}) {
  // (a limit below 1 would never stop evicting)
  if (limit !== 0 && !(Number.isSafeInteger(limit) && limit >= 1)) throw new Error('an answer cache limit is a whole number above 0');
  const built = new Map(); // key -> { version, json, enc, etag }
  let builds = 0;
  const answer = (key, version, build) => {
    const hit = built.get(key);
    if (hit && hit.version === version) {
      if (limit) { built.delete(key); built.set(key, hit); }
      return hit;
    }
    if (limit) {
      built.delete(key);
      while (built.size >= limit) built.delete(built.keys().next().value);
    } else {
      if (built.size > 200) for (const k of built.keys()) { if (!k.startsWith('/status')) built.delete(k); if (built.size <= 100) break; }
      // partial states are as many as there are `since` values, and each can be nearly the whole state: keep a few
      if (key.includes('?since=')) { const parts = [...built.keys()].filter((k) => k.includes('?since=')); if (parts.length >= 8) built.delete(parts[0]); }
    }
    builds++;
    const a = { version, json: Buffer.from(JSON.stringify(build())), enc: { gzip: null, br: null }, etag: etagOf(key, version) };
    built.set(key, a);
    return a;
  };
  return { built, answer, builds: () => builds };
}

/**
 * Send a built answer: 304 when If-None-Match names it, else 200 in the best encoding the client
 * takes (br, gzip, identity) with its exact content-length. `head` holds every other header.
 */
export async function sendAnswer(req, res, entry, head) {
  if (notModified(req.headers['if-none-match'], entry.etag)) { res.writeHead(304, head); return res.end(); }
  const enc = entry.json.length > MIN_COMPRESS ? pickEncoding(req.headers['accept-encoding']) : 'identity';
  const body = await encoded(entry, enc);
  res.writeHead(200, { ...head, ...(enc === 'identity' ? {} : { 'content-encoding': enc }), 'content-length': String(body.length) });
  return res.end(body);
}
