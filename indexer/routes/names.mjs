// Shielded names (src/v1/names.mjs), read from the registry's name index. Global routes: the same
// answer under any /c/<cid>/ prefix.
//
//   GET /names/info               { start, height, count, digest, index }   open (no key needed)
//   GET /names?after=<i>          every name, in pages of 500, checkable against /names/info
//   GET /names/<name>             { name, address, to, id, height }
//   GET /names/of/<address>       { names: [{ name, label, to, id, height }] }
//
// Bad input (a malformed %-escape, a string that is not a name or not a shielded address, a reserved
// label, an `after` that is not a place in the list) gets a 400 before the gate: free. A valid name
// nobody holds gets a 404 after the gate (1 unit), and that miss is never kept. Names and addresses
// are matched without regard to case, and every spelling of one is one cached answer.
//
// Version: the names height (the registry's last block) and the last 8 hex of that block's hash, so a
// block replaced at the same height changes the answer and its ETag.
import { parseName, isShieldedAddress, RESERVED_LABELS, NAMES_PAGE } from '../../src/v1/names.mjs';
import { versionAt } from '../serve.mjs';

const version = (ctx) => versionAt(ctx.height, ctx.hash);
const syncing = (ctx) => (ctx.names ? null : { status: 503, body: { error: 'still syncing' } });
const bad = (error) => ({ status: 400, body: { error } });
// decodeURIComponent throws on a malformed escape (%E0%A4%A): the caller's mistake, not ours
const decoded = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// What a request asks for, read the same way by parse(), miss() and build() (each is cheap).
/** /names?after=<i>: the place, or null when `after` is given and is not a whole number */
const afterOf = (q) => { const raw = q.get('after'); return raw === null ? 0 : /^\d+$/.test(raw) ? Number(raw) : null; };
/** /names/of/<address>: the address in lowercase, '' for a malformed escape */
const addressOf = (params) => decoded(params.raw)?.toLowerCase() ?? '';
/** /names/<name>: parseName() of it (null when it is not a name or the escape is malformed) */
const nameOf = (params) => { const s = decoded(params.raw); return s === null ? null : parseName(s.trim().toLowerCase()); };

const info = {
  id: 'names-info', scope: 'global', open: true, keep: 'shared',
  match: (p) => (p === '/names/info' ? {} : null),
  parse: () => ({ key: '/names/info', cost: 1 }),
  version,
  miss: syncing,
  // index: the shape tools/names-indexer.mjs --compare reads
  build: (ctx) => { const st = ctx.names.state(); return { ...st, index: st }; },
};

const list = {
  id: 'names-list', scope: 'global', keep: 'own', limit: 8,
  match: (p) => (p === '/names' ? {} : null),
  parse: ({ q, names }) => {
    const after = afterOf(q);
    if (after === null) return bad('after must be a whole number');
    // past the end is a mistake, or a list that a reorg made shorter: read it again from 0
    if (names && after > names.list.length) return bad(`after is past the last name (there are ${names.list.length})`);
    return { key: `/names?after=${after}`, cost: 1 };
  },
  version,
  miss: syncing,
  build: (ctx) => ({ ...ctx.names.state(), ...ctx.names.page(afterOf(ctx.q), NAMES_PAGE) }),
};

const of = {
  id: 'names-of', scope: 'global', keep: 'own', limit: 32,
  match: (p) => (p.startsWith('/names/of/') ? { raw: p.slice('/names/of/'.length) } : null),
  parse: ({ params }) => {
    if (decoded(params.raw) === null) return bad('malformed %-escape in the address');
    const address = addressOf(params);
    if (!isShieldedAddress(address)) return bad('not a shielded address');
    return { key: `/names/of/${address}`, cost: 1 };
  },
  version,
  miss: syncing,
  build: (ctx) => ({ names: ctx.names.of(addressOf(ctx.params)) }),
};

const lookup = {
  id: 'names-lookup', scope: 'global', keep: 'own', limit: 64,
  match: (p) => (p.startsWith('/names/') && p.length > '/names/'.length ? { raw: p.slice('/names/'.length) } : null),
  parse: ({ params }) => {
    if (decoded(params.raw) === null) return bad('malformed %-escape in the name');
    const n = nameOf(params);
    if (!n) return bad('not a valid name');
    if (RESERVED_LABELS.has(n.label)) return bad('that name is reserved');
    return { key: `/names/${n.full}`, cost: 1 };
  },
  version,
  // a valid name nobody holds: charged like any lookup, never kept (unknown names are endless)
  miss: (ctx) => syncing(ctx) ?? (ctx.names.resolve(nameOf(ctx.params).full) ? null : { status: 404, body: { error: 'nobody has that name' } }),
  build: (ctx) => {
    const rec = ctx.names.resolve(nameOf(ctx.params).full);
    return { name: rec.name, address: rec.to, to: rec.to, id: rec.id, height: rec.height }; // address: the older field, kept
  },
};

// order matters: /names/info and /names/of/ before the catch-all /names/<name>
export default [info, list, of, lookup];
