# The indexer API

Every Shielded Ordinals indexer answers the same read API. You can call:

- **your own indexer**, at `http://127.0.0.1:5021` after following [RUN-AN-INDEXER.md](RUN-AN-INDEXER.md). No key, no limit.
- **the hosted API run by Ord Dropz**, at `https://shielded-public-api-production.up.railway.app`, with an API key from Ord Dropz. Every call needs the key except `/status`, `/collections` and `/health`.

Both give the same answers at the same block. Everything served is public data read from Bitcoin. Nothing in this API can move a piece or reveal who holds one.

Every route is a `GET`, answers JSON, and allows calls from a browser on any site.

## API keys (hosted API)

Ask Ord Dropz for a key. A key looks like this:

```
shord_Zr3kP0c1x7Qe9b2mV5tY8uA4wL6nH1sD0fG3jK7oXcE
```

Send it in a header on every call:

```
curl -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/status
```

`Authorization: Bearer shord_…` works the same. Keep the key on your server. Don't put it in a web page or an app that people download, because anyone who reads it can use up your allowance.

### Limits

Calls are counted in units. Most routes cost 1 unit. `/state` costs 20, or 5 with `?since=`. An answer that has not changed since your last call (see "not modified" below) costs 1 whatever the route.

| Caller | Allowance |
|---|---|
| With a key | 60 units a minute and 5,000 units a day, unless Ord Dropz set other limits for your key |
| Without a key | `/status` only: 30 units a minute, shared by everyone at the same network address |

Every answer says where you stand:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` | Units allowed this minute |
| `x-ratelimit-remaining` | Units left this minute |
| `x-ratelimit-daily-limit` | Units allowed today |
| `x-ratelimit-daily-remaining` | Units left today |
| `retry-after` | On a refusal: seconds until the minute, or the day, rolls over |

The minute resets at the start of each clock minute; the day resets at midnight UTC. Need more? Ask Ord Dropz; limits are set per key.

### Not modified: pay 1 unit for an unchanged answer

Every answer carries an `etag`. Send it back as `If-None-Match` on your next call. If nothing changed (no new block), you get `304 Not Modified`, no body, and it costs 1 unit instead of the route's price.

```
curl -i -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/state
# ... etag: "970094-f24cd53beddf"
curl -i -H "x-api-key: shord_…" -H 'If-None-Match: "970094-f24cd53beddf"' https://shielded-public-api-production.up.railway.app/state
# HTTP/1.1 304 Not Modified
```

Answers are compressed when you send `Accept-Encoding: gzip` (curl: `--compressed`). The state is several megabytes raw; compressed it is a fraction of that.

### Errors

| Status | Body | Meaning |
|---|---|---|
| `401` | `{"error":"This API key is not valid."}` | The key is wrong, mistyped or revoked |
| `401` | `{"error":"An API key is needed. …"}` | This API accepts no calls without a key |
| `404` | `{"error":"not found"}` | No such route |
| `429` | `{"error":"Too many requests …"}` | Over the minute's limit. Wait `retry-after` seconds |
| `429` | `{"error":"This key has used its allowance for today. …"}` | Over the day's limit. Resets at midnight UTC |
| `503` | `{"error":"still syncing"}` | The indexer is replaying blocks. Try again shortly |

A wrong key is always refused. It is never treated as a call without a key.

## How to use it well

Poll `/status` (1 unit, no key needed). Read `/state` or `/listings` again only when `lastHeight` changed, because the state only changes when a block lands. Or always send `If-None-Match` and let the 304 tell you.

`/state` is large (several megabytes for a traded collection). Fetch it once, remember `noteCount`, and afterwards ask for `/state?since=<noteCount>` to receive only the notes you don't have.

## Routes

### `GET /status`

Where the indexer stands.

```
curl https://shielded-public-api-production.up.railway.app/status
```

```json
{
  "network": "mainnet",
  "collection": "Shielded Nakas",
  "rulesInscriptionId": "896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0",
  "lastHeight": 970084,
  "blockHash": "0000000000000000000…",
  "notes": 5033,
  "digest": "25099c619566d18bf618003a92d763fe4ccf2de5b912773067a9901a62992f69",
  "software": "shielded-ordinals indexer"
}
```

| Field | Meaning |
|---|---|
| `lastHeight` | The last Bitcoin block applied |
| `blockHash` | That block's hash |
| `notes` | How many notes exist (every mint, buy, send and cancel adds one) |
| `digest` | SHA-256 of the whole state. Two indexers at the same `lastHeight` with the same `digest` hold the same state |

### `GET /collection`

The collection and its rules.

| Field | Meaning |
|---|---|
| `rulesInscriptionId` | The parent inscription. Its content is the rules |
| `cid` | The collection id carried in every message: first 8 bytes of SHA-256 of the parent id, in hex |
| `rules` | The rules as inscribed: `name`, `supply`, `mintPrice`, `mintFee`, `saleFeeBps`, `saleFeeMin`, `ticketPrice`, `inscribeFee`, and the keys. Amounts are in sats |
| `minted` | Pieces minted so far |
| `lastHeight` | The block this answer is from |
| `global` | The collection's global number range, `{ "start": 0, "end": 3332, "height": …, "txid": … }`, or `null` before its first mint |
| `pieces` | File-mint collections: `{ withChild, pages, art: { have, of, verified } }` from the piece index (see `/pieces/info`) |

### `GET /listings`

Pieces for sale now.

```json
[
  { "nf": "1919…", "assetId": 2787, "inscriptionId": "6298006fb948…7159i175", "price": "1800000", "saleFee": "36000", "tickets": 3, "listedAt": 969485 }
]
```

| Field | Meaning |
|---|---|
| `nf` | The listing's id (the spent tag of the note that was listed), a decimal number in a string |
| `assetId` | The piece number inside the collection, from 0 |
| `inscriptionId` | The piece's child inscription: from the rules for a pre-inscribed collection, from the piece index (`/pieces`) for a file-mint one. `null` while the piece has no child |
| `price` | Price in sats, in a string |
| `saleFee` | The platform fee a buyer pays on top, in sats |
| `tickets` | Relay credits that travel with the piece |
| `listedAt` | The block the listing confirmed in |

A piece's global number is `global.start + assetId`.

### `GET /state`

The full public state. A wallet downloads this and searches it locally for its own notes, so the indexer never learns which notes belong to whom.

`?since=<n>` returns only the notes after the first `n`.

| Field | Meaning |
|---|---|
| `v` | Format version, `1` |
| `cid`, `rulesInscriptionId` | The collection |
| `lastHeight` | The block this state is from |
| `noteCount` | Total notes |
| `sinceNote` | The `since` this answer starts at |
| `notes` | `{ pos, cm, epk, ct, txid, height, kind }`. `pos` is the note's place in the tree, `cm` its commitment, `epk` and `ct` the encrypted note only its holder can open, `kind` one of `mint`, `buy`, `claim`, `transfer` |
| `roots` | `[height, root, leafCount]` for the most recent 100 blocks. A proof names one of these |
| `nullifiers` | Every spent tag published so far |
| `listings` | Every listing ever made: `nf`, `assetId`, `tickets`, `price`, `sellerScript`, `returnKey`, `lock` (`txid`, `vout`, `value`), `state`, `height`, `soldTxid`, `closedTxid`, `claimTxid` |
| `minted` | Piece numbers minted |

A listing's `state` is `ACTIVE` (for sale), `SOLD`, `CLOSED` (cancelled, waiting for the seller to take the piece back) or `CLAIMED` (taken back).

Numbers too large for JSON (`cm`, `nf`, `root`, `price`) are decimal strings.

### `GET /collections`

Every shielded collection this indexer follows. The indexer finds them on Bitcoin itself: every parent inscription whose content is valid rules gets its own copy of the rules engine, replayed from its parent's block.

```json
[
  { "cid": "a1e7879252940f5e", "parent": "896803ff…i0", "name": "Shielded Nakas", "kind": "collection", "supply": 3333, "startBlock": 969342,
    "range": { "start": 0, "end": 3332, "height": 969349, "txid": "258e66c5…" }, "lastHeight": 970094, "notes": 5034, "digest": "1922…", "primary": true }
]
```

A collection that pinned a different proof verification key than this software carries is listed with `"skipped"` and the reason; its routes answer `409`.

### `GET /c/<cid>/…`

`/status`, `/state`, `/listings`, `/collection` and the `/pieces` routes for one collection, by its `cid` from `/collections`:

```
curl -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/c/a1e7879252940f5e/listings
```

The routes without `/c/<cid>/` answer for the indexer's primary collection (Shielded Nakas on the hosted API). They never change meaning when a new collection appears.

### `GET /pieces/info`

The piece index of a file-mint collection: which child inscription is which piece, read from Bitcoin. A child is an inscription in a tx that spends the parent inscription and names it as its parent; its piece is its metadata's `shielded.piece` (PROTOCOL-v1.md, "Children of a file-mint collection"). Metadata only: the state and its `digest` do not depend on it.

```json
{ "parent": "896803ff…i0", "parentAt": "e8f99351…4b:0", "supply": 3333, "minted": 3327, "withChild": 3327, "pages": 4, "perPage": 1000,
  "art": { "root": "a6146695…128d", "have": 3327, "of": 3333, "verified": null }, "ignored": [], "digest": "d8fbcae2…e2d4", "height": 970121 }
```

| Field | Meaning |
|---|---|
| `parentAt` | The outpoint holding the parent inscription now, `"lost"` if its sat went to the fees (no later child counts), or `null` before its reveal |
| `minted`, `withChild` | Pieces minted, and pieces with a child inscription |
| `art` | `verified` is `true` or `false` once every piece has a child (`artRoot` recomputed from the children's content hashes), `null` until then |
| `ignored` | Inscriptions that claimed the parent but are not a piece's child, with the reason (`piece already has a child`, `no shielded.piece`, `metadata unreadable`, …). The first 1,000; `ignoredTotal` appears when there are more |
| `digest` | Running SHA-256 over every child taken. Two indexers at the same `height` with the same `digest` hold the same piece map |

### `GET /pieces?page=<k>`

Every piece in pages of 1,000 (`k` from 0 to `pages - 1`; anything else is a `404`, not charged). Compact rows with dictionaries local to the page:

```json
{ "v": 1, "page": 0, "pages": 4, "from": 0, "to": 999, "final": true, "contentType": "image/png", "name": "Shielded NAKAS #{global}", "globalStart": 0,
  "txs": ["647652c7…", "13fdb17b…", "…"], "traits": ["Body", "Outfit", "Hair And Headwear", "Eyes", "Mouth", "Hoodie"], "values": ["Pepe", "Red Raglan", "Purple Crazy", "3D Glasses", "Clean", "…"],
  "rows": [[0, 969349, 0, 0, 969350, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4], "Shielded NAKAS #1"], [1, 969358, 1, 0, 969359, [0, 5, 1, 6, 2, 7, 3, 8, 4, 4], "Shielded NAKAS #2"], …] }
```

A row is `[assetId, mintHeight, childTx, childIndex, inscribedHeight, [traitIndex, valueIndex, …], name?]`:

- `childTx` indexes `txs`: the child is `<txs[childTx]>i<childIndex>`. `null` (with `childIndex` and `inscribedHeight`) while the piece has no child; `mintHeight` is `null` for a child of a piece not minted.
- Traits come from the child's metadata `attributes`, as pairs of indexes into `traits` and `values`. The `Shielded #` trait and the `shielded` block are left out: they are the global number and the piece.
- The page's `name` is the rule most children of the page follow: replace `{global}` with the piece's global number, `globalStart + assetId`. A row ends with its own name only when its child's name differs from that rule (`null` when the child has no name). The page's `name` is `null` when no rule fits.
- A piece neither minted nor inscribed has no row. The mint transaction is in `/pieces/<assetId>`.

### `GET /pieces/<assetId>`

One piece:

```json
{ "assetId": 1, "global": 1, "tier": "Sub 1K", "mint": { "height": 969358, "txid": "b194c3de…fcba" },
  "child": { "id": "13fdb17b…i0", "height": 969359, "txid": "13fdb17b…", "contentType": "image/png", "size": 801, "sha256": "6d1c4863…", "delegate": null, "via": "metadata" },
  "metadata": { "name": "Shielded NAKAS #2", "attributes": [ … ], "shielded": { "number": 1, "piece": 1, "parent": "896803ff…i0" } }, "final": true }
```

`via` is `metadata` (its `shielded.piece`) or `pinned` (a pin in `src/v1/collections.mjs` whose Merkle path to `artRoot` checks). `metadata` is the child's tag-5 metadata as inscribed (`null` when it has none, or more than 4 KB). No art bytes are served: fetch the content from any ord server and check it against `sha256`.

The `/pieces` routes cost 1 unit each. Their ETag comes from the answer itself, so a page whose pieces did not change keeps its ETag from block to block, and `If-None-Match` gets a `304`. An answer whose pieces are all minted and inscribed, at least 6 blocks deep, with the collection's global numbers known, has `"final": true` and is sent with `cache-control: private, max-age=31536000, immutable`. A collection without a piece index (pre-inscribed, or an indexer run with `PIECES=0`) answers `404`.

### `GET /registry`

Every shielded collection found on Bitcoin, in global number order.

```json
[
  { "cid": "a1e7879252940f5e", "parent": "896803ff…i0", "name": "Shielded Nakas", "supply": 3333, "launchedAt": 969343,
    "range": { "start": 0, "end": 3332, "height": 969349, "txid": "258e66c5…" } }
]
```

A collection takes its number range at its first valid mint. `range` is `null` until then.

### `GET /names/info`

The state of the shielded names index.

```json
{ "start": 969800, "height": 970084, "count": 12, "digest": "39cc12ba…", "index": { "start": 969800, "height": 970084, "count": 12, "digest": "39cc12ba…" } }
```

Two indexers at the same `height` with the same `digest` hold the same names.

### `GET /names/<name>`

The shielded address a name points at.

```
curl https://shielded-public-api-production.up.railway.app/names/obi.naka
```

```json
{ "name": "obi.naka", "address": "shord1…", "id": "<inscription id>", "height": 969806 }
```

Answers `404` when nobody has the name. A name counts only once its inscription is in a block.

### `GET /names/of/<shielded address>`

Every name pointing at an address, earliest first: `{ "names": [ { "name", "label", "to", "id", "height" } ] }`.

### `GET /health`

`{"ok":true}`. Not counted against any limit.

## For operators: giving out keys

This part is for whoever runs an indexer for other people. An indexer you run for yourself needs none of it.

Start the indexer with a keys file:

```
API_KEYS_FILE=/data/api-keys.json node indexer/indexer.mjs
```

| Variable | Meaning | Default |
|---|---|---|
| `API_KEYS_FILE` | Where key hashes are kept. Setting it turns keys and limits on | off |
| `API_KEY_REQUIRED` | `1` refuses every call without a key, except `/status`, `/collections` and `/health` | `0` |
| `PUBLIC_LIMIT` | Requests a minute for callers without a key, per address | `30` |
| `TRUST_PROXY` | How many proxies stand in front of the indexer. The caller's address is read that many steps back in `X-Forwarded-For`. Leave `0` when callers connect directly | `0` |
| `ADMIN_SECRET` | A long secret that turns on key management over HTTP | off |

Only the SHA-256 of each key is stored, so a copy of the keys file can't be used to call the API. Units per key per day are counted in `usage.json` beside it, and the daily limit is enforced from that count. New keys get 60 units a minute and 5,000 a day unless you say otherwise.

On the machine that holds the file:

```
node indexer/keys.mjs create "who it is for" 60 5000      # per minute, per day
node indexer/keys.mjs limits <id> 300 20000               # change a key's limits
node indexer/keys.mjs list
node indexer/keys.mjs revoke <id>
```

`create` prints the key once. A running indexer picks up a new or revoked key within a few seconds.

Or over HTTP, when `ADMIN_SECRET` is set:

```
curl -X POST https://shielded-public-api-production.up.railway.app/admin/keys -H "x-admin-secret: …" -H "content-type: application/json" -d '{"label":"who it is for","limit":60,"daily":5000}'
curl -X POST https://shielded-public-api-production.up.railway.app/admin/keys/limits -H "x-admin-secret: …" -H "content-type: application/json" -d '{"id":"<id>","limit":300,"daily":20000}'
curl https://shielded-public-api-production.up.railway.app/admin/keys -H "x-admin-secret: …"
curl -X POST https://shielded-public-api-production.up.railway.app/admin/keys/revoke -H "x-admin-secret: …" -H "content-type: application/json" -d '{"id":"<id>"}'
```

The first answers with the new key. The second lists every key with its calls per day.

The same three commands work from your own machine against that indexer, so you never handle the HTTP calls yourself. Keep the admin secret in a file:

```
node indexer/keys.mjs create "who it is for" 60 5000 --at https://shielded-public-api-production.up.railway.app --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs limits <id> 300 20000 --at https://shielded-public-api-production.up.railway.app --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs list --at https://shielded-public-api-production.up.railway.app --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs revoke <id> --at https://shielded-public-api-production.up.railway.app --secret-file ~/.secrets/indexer-admin.txt
```
