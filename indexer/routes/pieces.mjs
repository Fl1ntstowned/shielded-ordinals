// The piece index of a file-mint collection (src/v1/pieces.mjs), 1 unit each, also under /c/<cid>/:
//   GET /pieces?page=<k>      1000 pieces per page, compact rows (docs/API.md)
//   GET /pieces/<assetId>     one piece: mint, child inscription, metadata as inscribed
//   GET /pieces/info          where the parent is, counts, the art check, ignored children, digest
// The ETag comes from the answer itself, so a page whose pieces did not change keeps its ETag from
// block to block. An answer about pieces that are all minted and inscribed, at least 6 blocks deep,
// is final: it is sent with cache-control "private, max-age=31536000, immutable".
// A bad page or piece number is a 404 before the gate, free. No art bytes are served.
import crypto from 'node:crypto';
import { piecesOf } from '../../src/v1/pieces.mjs';

const WHOLE = /^(0|[1-9]\d{0,8})$/; // a canonical whole number: no sign, no leading zero, no spaces
const IMMUTABLE = { 'cache-control': 'private, max-age=31536000, immutable' };
const noIndex = { status: 404, body: { error: 'this collection has no piece index (not a file-mint collection, or PIECES=0)' } };
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
const indexOf = (col) => piecesOf(col?.chain?.hooks);
const rangeStart = (ctx) => ctx.registry?.collections.get(ctx.col.cid)?.range?.start ?? null;

const pageOf = (ctx) => indexOf(ctx.col).page(Number(ctx.q.get('page')), { ix: ctx.ix, height: ctx.height, globalStart: rangeStart(ctx) });
const pieceOf = (ctx) => {
  const start = rangeStart(ctx);
  const a = Number(ctx.params.text);
  return indexOf(ctx.col).piece(a, { ix: ctx.ix, height: ctx.height, global: start === null ? null : start + a });
};
const infoOf = (ctx) => indexOf(ctx.col).info({ ix: ctx.ix, height: ctx.height });

export const routes = [
  {
    id: 'pieces-info', scope: 'collection', keep: 'shared',
    match: (p) => (p === '/pieces/info' ? {} : null),
    parse: ({ col }) => (indexOf(col) ? { key: '/pieces/info', cost: 1 } : noIndex),
    version: (ctx) => hashOf(infoOf(ctx)),
    build: (ctx) => infoOf(ctx),
  },
  {
    id: 'pieces-page', scope: 'collection', keep: 'own', limit: 128,
    match: (p) => (p === '/pieces' ? {} : null),
    parse: ({ q, col }) => {
      const px = indexOf(col);
      if (!px) return noIndex;
      const k = q.get('page');
      if (k === null || !WHOLE.test(k) || Number(k) >= px.pages()) return { status: 404, body: { error: `page must be a whole number from 0 to ${px.pages() - 1}`, pages: px.pages() } };
      return { key: `/pieces?page=${Number(k)}`, cost: 1 };
    },
    version: (ctx) => pageOf(ctx).version,
    build: (ctx) => pageOf(ctx).body,
    headers: (ctx) => (pageOf(ctx).final ? IMMUTABLE : {}),
  },
  {
    // one answer per piece: a cache of its own, so thousands of pieces never push /state out
    id: 'pieces-one', scope: 'collection', keep: 'own', limit: 256,
    match: (p) => { const m = /^\/pieces\/([^/]+)$/.exec(p); return m && m[1] !== 'info' ? { text: m[1] } : null; },
    parse: ({ params, col }) => {
      const px = indexOf(col);
      if (!px) return noIndex;
      if (!WHOLE.test(params.text) || Number(params.text) >= px.supply) return { status: 404, body: { error: `a piece is a whole number from 0 to ${px.supply - 1}` } };
      return { key: `/pieces/${Number(params.text)}`, cost: 1 };
    },
    version: (ctx) => hashOf(pieceOf(ctx)),
    build: (ctx) => pieceOf(ctx),
    headers: (ctx) => (pieceOf(ctx).final ? IMMUTABLE : {}),
  },
];

export default routes;
