// How the indexer serves an answer once it knows which answer a request names (indexer.mjs decides
// that): what it costs, which routes are open, the answer cache, the ETag, and the bytes sent back.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// What a request costs in units (keys.mjs): the full state is the one heavy answer.
export const costOf = (path, since) => (path === '/state' ? (since > 0 ? 5 : 20) : 1);
// Routes anyone may read even when keys are required: tiny, and what a wallet needs to find us.
export const OPEN = new Set(['/status', '/collections']);

// ETag = version + route: a client that asks again with If-None-Match gets a 304 and no bytes.
export const etagOf = (key, version) => `"${version}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}"`;

/**
 * An answer cache. Every answer is built once per version (the state only changes when a block
 * lands) and kept compressed, so a thousand readers cost one build.
 *   answer(key, version, build) -> { version, json, gz, etag }   build() runs only on a miss
 * Without `limit`: the indexer's shared cache (past 200 entries it drops all but the /status ones
 * down to 100, and keeps at most 8 partial states). With `limit`: a cache of its own that keeps the
 * `limit` most recently used answers (route modules with keep: 'own').
 */
export function makeAnswers({ limit = 0 } = {}) {
  const built = new Map(); // key -> { version, json, gz, etag }
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
    const json = JSON.stringify(build());
    const a = { version, json, gz: json.length > 1024 ? zlib.gzipSync(json) : null, etag: etagOf(key, version) };
    built.set(key, a);
    return a;
  };
  return { built, answer };
}

/** Send a built answer: 304 when the client already holds it, gzip when it asks for that, else plain. */
export function sendAnswer(req, res, entry, head) {
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, head); return res.end(); }
  if (entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { res.writeHead(200, { ...head, 'content-encoding': 'gzip' }); return res.end(entry.gz); }
  res.writeHead(200, head);
  return res.end(entry.json);
}
