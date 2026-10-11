// Route modules: answers served next to the built-in routes of indexer/indexer.mjs. One file per
// feature in this folder, one line each in the list at the bottom.
//
// The server tries, in order: OPTIONS (any path), /health, /admin/, the built-in routes, the names
// routes, then these modules in list order (the first whose match() accepts the path), then 404.
//
// A module is a plain object:
//   id         unique name, e.g. 'changes'
//   scope      'collection'  an answer about one collection. Unprefixed it answers for the primary
//                            collection; it also answers under /c/<cid>/ for that collection. A
//                            collection that is not followed (another verification key) gets 409.
//              'global'      one answer for the whole indexer, the same under any /c/<cid>/ prefix.
//   open       true: needs no API key even when keys are required (the caller's per-IP allowance pays)
//   match(path) -> params | null
//              path is the URL path without the /c/<cid> prefix and without the query.
//   parse({ params, q, ix, col }) -> { key, cost } | { status, body }
//              Must be cheap and build nothing. q = URLSearchParams.
//              { key, cost }: key names the answer (the route plus every query value that changes it;
//              the cache key is the collection prefix + key), cost = units the gate charges for it,
//              a whole number, 1 or more (anything else, or no key, is a 500 and charges nothing).
//              { status, body }: sent as it is (a 400 for a bad query), before the gate, free.
//   version(ctx) -> string
//              optional. The answer is rebuilt, and its ETag changes, when this changes.
//              Default `${height}`.
//   build(ctx) -> body           the JSON answer
//   keep       'shared'  kept in the server's answer cache with the built-in answers
//              'own'     kept in a cache of its own: the `limit` most recently used answers (default
//                        32), for routes with many keys that must never push /state out of the cache
//   limit      optional, with keep: 'own' only: a whole number, 1 or more
//   headers?(ctx) -> object      optional extra headers on the answer (200 and 304)
//
// ctx = { col, ix, params, q, height, hash, registry, names, hooks }
//   col        the collection: { cid, id, rules, start, chain } (the primary for a global route)
//   ix         its rules engine (src/v1/indexer.mjs), at block `height`
//   height     collection: ix.lastHeight. global: the registry's last block (ix.lastHeight until it has one)
//   hash       the hash of block `height`
//   registry   the Registry (src/v1/registry.mjs), or null while it syncs
//   names      the registry's NameIndex (src/v1/names.mjs), or null
//   hooks      the follower hooks of that collection (src/v1/follow.mjs)
// The ETag is "<version>-<first 12 hex of sha256(cache key)>". A 304 costs 1 unit.
// A module only reads: nothing here may change the rules engine, the registry or a hook.

import pieces from './pieces.mjs';

export const routes = [
  ...pieces, // /pieces?page=, /pieces/<assetId>, /pieces/info
];

export default routes;
