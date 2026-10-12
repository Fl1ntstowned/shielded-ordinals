# The indexer API

Every Shielded Ordinals indexer answers the same read API. You can call:

- **your own indexer**, at `http://127.0.0.1:5021` after following [RUN-AN-INDEXER.md](RUN-AN-INDEXER.md). No key, no limit.
- **the hosted API run by Ord Dropz**, at `https://shielded-public-api-production.up.railway.app`, with an API key. Every call needs the key except `/status`, `/collections`, `/names/info` and `/health`.

Both run the indexer in this repository. At the same block they should hold the same state: compare `digest` in `/status` to check (see "Checking `digest` yourself").

Every route is a `GET` and answers JSON. Any site may call it (CORS is open to every origin). But a key must stay on your server: call keyed routes from your server, and call only the open routes straight from a web page.

## What this API shows, and what it does not

Everything served is public data read from Bitcoin. Nothing in this API can move a piece.

Two words used below: a **note** is the private record that a vault holds a piece. A **spent tag** (nullifier) marks a note as used without saying which note.

- There is no owner field. A listing does show where its seller is paid (`sellerScript`, in `/state`). The seller chose it: their own wallet, another address, or a private payout address made for that one listing. Some sellers reuse one address, so it can link that seller's listings.
- Mints, listings, sales and claims (a cancelled listing coming back to its seller) name their piece, and their transactions are public on Bitcoin. Anyone can see which wallet paid for a piece's mint and for each of its sales.
- A private send names no piece and no recipient. In `/state` it is a `transfer` note and a spent tag that show neither.
- A private send, listing or cancel paid with a relay credit is published by the Ord Dropz relayer, which pays the network fee. One the holder publishes from their own wallet shows that wallet.
- Each piece's relay-credit count is public when it is minted, listed, bought or taken back, and a relayed private send uses one credit. So a drop in credits between two of those can show that the piece was sent privately in between. It never shows to whom.

## API keys (hosted API)

Get a key on the Ord Dropz Discord (https://discord.gg/GbX78hYm8h): verify your wallet with `/verify`, then run `/apikey`. The key is shown once, only to you. `/apikey new:true` replaces a lost key, and the old one stops working.

A key is `shord_` followed by 43 letters, digits, `-` or `_`. This one is made up:

```
shord_EXAMPLE-not-a-real-key-00000000000000000000
```

Send it in a header on every call:

```
curl -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/listings
```

`Authorization: Bearer shord_…` works the same. A key put in the address (the query string) is not read. Keep the key on your server. Don't put it in a web page or an app that people download, because anyone who reads it can use up your allowance.

### Limits

Calls are counted in units:

- Most routes cost 1 unit. A name lookup that finds nobody costs 1 too.
- The full `/state` costs 20.
- `/state?since=<n>` (n of 1 or more) costs 5, plus 1 for every 500 notes it returns, and never more than 20. A poll for the notes of the last few blocks costs 5, while `?since=1` costs about what the whole state does (19 at 7,090 notes, block 970879). `since=0` is the full `/state` (20).
- An unchanged answer (see "Not modified" below) costs 1, whatever the route.
- Bad input refused with a `400` (see "Errors") costs nothing.

| Caller | Allowance |
|---|---|
| With a key | 60 units a minute and 5,000 units a day, unless your key has other limits |
| Without a key | `/status`, `/collections` and `/names/info` only: 30 units a minute, shared by everyone at the same network address. A call to one of these that carries a key is counted against the key |

A call that costs more than your whole allowance (for example the full `/state`, 20 units, with a key allowed 10 a minute) is refused with `403` and says what it costs and what you are allowed. Waiting would not help, so it is not a `429`. Nothing is counted for it.

Answers to calls that were counted say where you stand. A `429` carries them too; a `403` carries only the limits; a `401`, a `400`, an unknown route, `/health` and `OPTIONS` carry none of the rate headers.

| Header | Meaning |
|---|---|
| `x-cost` | Units this call was charged (`0` when it was refused) |
| `x-ratelimit-limit` | Units allowed this minute |
| `x-ratelimit-remaining` | Units left this minute |
| `x-ratelimit-daily-limit` | Units allowed today (keys only) |
| `x-ratelimit-daily-remaining` | Units left today (keys only) |
| `retry-after` | On a `429`: seconds until the minute, or the day, rolls over |

The minute resets at the start of each clock minute. The day resets at midnight UTC. Need more? Ask on the Discord; limits are set per key.

### Not modified: pay 1 unit for an unchanged answer

Every `200` answer except `/health` carries an `etag`. For most routes it is `"<block height>-<last 8 hex of that block's hash>-<12 hex naming the answer>"`, so it changes when a block lands, even when the answer itself did not change. The `/pieces` routes are the exception: their tag comes from the answer itself and stays the same from block to block while the pieces do not change.

Send it back as `If-None-Match`. If nothing changed, you get `304 Not Modified`, no body, and it costs 1 unit instead of the route's price.

```
curl -i -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/listings
# ... etag: "970880-4ad05d85-f5564391a395"
curl -i -H "x-api-key: shord_…" -H 'If-None-Match: "970880-4ad05d85-f5564391a395"' https://shielded-public-api-production.up.railway.app/listings
# HTTP/1.1 304 Not Modified
```

`If-None-Match` may also carry the tag as weak (`W/"…"`, as some proxies rewrite it), several tags separated by commas, or `*`; any match is a `304`. Because the tag names the block's hash, a block replaced at the same height (a reorg) changes every tag, so you never get a `304` for an answer that is no longer on the chain. Tags from indexers before this release had no block hash (`"970094-f24cd53beddf"`); they miss once and you get the full answer.

### Compression

Answers over 1 KB are compressed when your client asks: brotli (`br`) when it accepts br, otherwise `gzip`. Browsers and `curl --compressed` get br; Node's `fetch` asks for gzip (and deflate, which is not offered) and gets gzip. No `Accept-Encoding`, or only `identity`, gets plain JSON, and `;q=0` refuses an encoding. Every `200` carries `content-length` (the bytes actually sent) and `vary: accept-encoding`. The body is the same JSON whichever encoding you get.

Measured on a release build at block 970879:

| Answer | Plain | gzip | br |
|---|---|---|---|
| `/state` | 5,539,827 B | 2,293,467 B | 1,960,974 B |
| `/state?since=<noteCount − 2>` (a poll) | 2,290,395 B | 807,790 B | 634,790 B |
| `/listings` | 51,427 B | 12,415 B | 9,954 B |

`since` trims only the notes: `listings`, `nullifiers`, `minted` and `roots` always come whole, so a poll is still large. Send `If-None-Match` and a poll between blocks costs 1 unit and no body.

### Errors

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"since must be a whole number"}` | `/state?since=` was not digits (`abc`, `-1`, `1e3`, `1.5`, empty). Not counted |
| `400` | `{"error":"not a valid name"}` and the other names errors | See "Shielded names". Not counted |
| `401` | `{"error":"This API key is not valid."}` | The key is wrong, mistyped or revoked |
| `401` | `{"error":"An API key is needed. Send it in the x-api-key header."}` | This route needs a key |
| `403` | `{"error":"This answer costs 20 units; this key allows 10 a minute. Ask for a higher limit.","cost":20,"limit":10}` | This one call costs more than your whole allowance a minute (or a day; without a key, the address's minute). It can never pass: ask for a higher limit, or make a cheaper call such as `/state?since=`. Not counted |
| `404` | `{"error":"not found"}` | No such route, or not a `GET`. Not counted |
| `404` | `{"error":"nobody has that name"}` | `/names/<name>`: a valid name nobody holds. Counted (1 unit) |
| `404` | `{"error":"page must be a whole number from 0 to 3", …}` | `/pieces`: a page or piece number out of range, or a collection without a piece index. Not counted |
| `404` | `{"error":"no such collection here; see /collections"}` | `/c/<cid>/…` with a cid this indexer does not follow |
| `409` | `{"error":"this collection pinned another proof verification key"}` | `/c/<cid>/…` of a collection this software does not follow (see `/collections`) |
| `429` | `{"error":"Too many requests …"}` | Over the minute's limit. Wait `retry-after` seconds |
| `429` | `{"error":"This key has used its allowance for today. …"}` | Over the day's limit. Resets at midnight UTC |
| `500` | `{"error":"…"}` | The indexer failed to build the answer |
| `503` | `{"error":"still syncing"}` | The indexer is replaying blocks after a start. Try again shortly |

A wrong key is always refused. It is never treated as a call without a key.

## How to use it well

Poll `/status`. Read `/state` or `/listings` again only when `lastHeight` changed, because the state only changes when a block lands. Or always send `If-None-Match` and let the `304` tell you.

`/state` is large (5.54 MB plain, 1.96 MB br at block 970879). Fetch it once, remember `noteCount`, then ask for `/state?since=<noteCount>` (5 units for a poll). Send `Accept-Encoding: br, gzip` (or `curl --compressed`): answers shrink to about a third of their size or less.

A chain reorganisation (Bitcoin replacing its newest blocks) can change the newest notes. If you keep notes, also keep the root `roots` gives for the last block you read. If a later answer gives a different root for that block, fetch the full `/state` again.

## Routes

### `GET /status`

Where the indexer stands. Open: no key needed.

```
curl https://shielded-public-api-production.up.railway.app/status
```

```json
{
  "network": "mainnet",
  "collection": "Shielded Nakas",
  "rulesInscriptionId": "896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0",
  "cid": "a1e7879252940f5e",
  "lastHeight": 970880,
  "blockHash": "0000000000000000000194034f33fcdddad4b9c763822cc5f6fb99b04ad05d85",
  "notes": 7091,
  "digest": "dda7632860eea253a02ecc4be079c3f4f7cdd6852474ab40fed056ba0e25455b",
  "software": "shielded-ordinals indexer",
  "collections": 1,
  "checkpoint": {
    "height": 970848
  }
}
```

| Field | Meaning |
|---|---|
| `cid` | The collection id (see `/collection`) |
| `lastHeight` | The last Bitcoin block applied |
| `blockHash` | That block's hash |
| `notes` | How many notes exist. One is added for every piece minted, every buy, every private send and every claim (a cancelled listing coming back to its seller). A listing adds none |
| `digest` | SHA-256 of a summary of the state: the latest tree root, the note count, the spent tags, the minted pieces, and each listing's id, state, piece, relay credits and price. Two indexers at the same `lastHeight` with the same `digest` agree on all of that. It does not cover a note's encrypted part (`epk`, `ct`), txid, height or kind, or a listing's block, lock, seller script, return key, or sale and claim txids |
| `collections` | How many collections this indexer knows (`/collections`) |
| `checkpoint` | `{ "height": … }`: the newest block this indexer has saved its state at (a restart starts from there), or `null`. Not part of the state: two indexers in agreement can show different values |

#### Checking `digest` yourself

You can recompute `digest` from any `/state` answer. A `since` answer works too, because the digest does not use the notes:

- `root`: the root in `roots` whose height is `lastHeight`, as a decimal string
- `leaves`: `noteCount`
- `nfs`: `nullifiers`, sorted as text
- `minted`: `minted`, sorted as numbers, smallest first
- `listings`: `[nf, state, assetId, tickets, price]` for each listing, with `nf` and `price` as strings and `assetId` and `tickets` as numbers, sorted as text (each row compared as its values joined by commas, which is JavaScript's default `sort()`)
- `digest` = SHA-256 of `JSON.stringify({ root, leaves, nfs, minted, listings })`, with no spaces, in hex

The digest describes the state. It never decides which transactions count.

### `GET /collection`

The collection and its rules.

| Field | Meaning |
|---|---|
| `network` | `mainnet` or `signet` |
| `rulesInscriptionId` | The parent inscription. Its content is the rules |
| `cid` | The collection id carried in every message: the first 8 bytes of the SHA-256 of the parent id (as text), in hex |
| `rules` | The rules exactly as inscribed: the parent inscription's JSON, every key in it and nothing else. For Shielded Nakas: `p`, `v`, `name`, `supply`, `artRoot`, `contentType`, `mintPrice`, `mintFee`, `saleFeeBps`, `saleFeeMin`, `ticketPrice`, `inscribeFee`, `gateKey`, `lockKey`, and the payout scripts `artistPayoutScript`, `platformPayoutScript` and `relayerPayoutScript` (hex). A rules v2 collection also carries `royaltyBps` and `royaltyMin`. Amounts are in sats |
| `minted` | Pieces minted so far |
| `lastHeight` | The block this answer is from |
| `fileMint` | `true` when each piece is inscribed after it is minted (the rules carry `artRoot`), `false` when the rules list the children |
| `inscribeFee` | Sats per piece for its inscription, `0` when not a file mint |
| `global` | The collection's global number range, `{ "start": 0, "end": 3332, "height": …, "txid": … }`, or `null` before its first mint |
| `pieces` | File-mint collections: `{ withChild, pages, art: { have, of, verified } }` from the piece index (see `/pieces/info`) |

The fields in `rules`:

| Field | Meaning |
|---|---|
| `p`, `v` | `shord` and `1` or `2`: a Shielded Ordinals collection. Rules v2 adds an artist royalty (`royaltyBps` and `royaltyMin`, below); v1 rules have none |
| `name`, `supply` | The collection's name and how many pieces it can have |
| `artRoot`, `contentType` | File mint: one hash over every piece's art file, and the art's file type |
| `children` | Pre-inscribed collections: the child inscription of every piece |
| `mintPrice`, `artistPayoutScript` | What a mint pays the artist, and where |
| `mintFee`, `saleFeeBps`, `saleFeeMin`, `platformPayoutScript` | What a mint and a sale pay Ord Dropz (the sale fee is hundredths of a percent of the price, `200` is 2%, and at least `saleFeeMin`), and where |
| `royaltyBps` | Rules v2 only: what a sale pays the artist, in hundredths of a percent of the price (`100` is 1%), from `0` to `1000`. Paid to `artistPayoutScript` in the buyer's transaction |
| `royaltyMin` | Rules v2 only: the smallest royalty, in sats. Required (and at least the dust limit of `artistPayoutScript`) when `royaltyBps` is above `0`; absent or `0` when it is `0` |
| `ticketPrice`, `inscribeFee`, `relayerPayoutScript` | The price of one relay credit and of each piece's inscription, and where they are paid |
| `gateKey`, `lockKey` | Ord Dropz's signing keys (or `cosigners` in a 2-of-3 collection). You never need them |

### `GET /listings`

Pieces for sale now.

```json
[
  {"nf":"891416512656663841423243893433194964089171108666179376197873240303877438855","assetId":2421,"inscriptionId":"e4f6045f7f1daf6fd5b53874bfdf85ce6b543e4288641a47dc3f888967c28138i9","price":"600000","saleFee":"12000","tickets":2,"listedAt":969485}
]
```

| Field | Meaning |
|---|---|
| `nf` | The listing's id (the spent tag of the note that was listed), a decimal number in a string |
| `assetId` | The piece number inside the collection, from 0 |
| `inscriptionId` | The piece's child inscription: from the rules for a pre-inscribed collection, from the piece index (`/pieces`) for a file-mint one such as Shielded Nakas. `null` while the piece has no child |
| `price` | Price in sats, in a string |
| `saleFee` | The platform fee a buyer pays on top, in sats, in a string: the larger of `saleFeeMin` and `price × saleFeeBps / 10000` rounded down. For Shielded Nakas that is 2%, at least 1,000 sats |
| `royalty` | v2 collections only: the artist's royalty a buyer pays on top, in sats, in a string: the larger of `royaltyMin` and `price × royaltyBps / 10000` rounded down, paid to `artistPayoutScript`. Absent for v1 collections such as Shielded Nakas. A buyer pays `price + saleFee + royalty` |
| `tickets` | Relay credits that travel with the piece. Each credit pays the relayer to publish one action, such as a private send |
| `listedAt` | The block the listing confirmed in |

A piece's global number is `global.start + assetId`.

### `GET /state`

The full public state. The Ord Dropz vault downloads this and searches it on the holder's device, so the indexer never learns which notes belong to whom. A marketplace does not need the notes: use `/listings`, and the listings here for sales.

`?since=<n>` returns only the notes after the first `n`. `n` is a whole number (digits only); anything else gets `400`. An `n` above `noteCount` is treated as `noteCount`. It costs 5 units, plus 1 for every 500 notes returned, at most 20 (see "Limits"). `roots`, `nullifiers`, `listings` and `minted` are always complete.

| Field | Meaning |
|---|---|
| `v` | Format version, `1` |
| `cid`, `rulesInscriptionId` | The collection |
| `lastHeight` | The block this state is from |
| `noteCount` | Total notes |
| `sinceNote` | The `since` this answer starts at |
| `notes` | `{ pos, cm, epk, ct, txid, height, kind }`. `pos` is the note's place in the tree. `cm` is its public fingerprint, a hash that hides what is in the note. `epk` and `ct` are the note, encrypted to the vault that receives it; whoever made the note, such as the sender of a private send, also knows what is in it. `kind` is one of `mint`, `buy`, `claim` or `transfer` (a private send) |
| `roots` | `[height, root, leafCount]` for the last 101 blocks, `lastHeight − 100` to `lastHeight`. A root is one hash that sums up every note so far; `leafCount` is the number of notes then. A proof mined in block H must anchor on a root from H−100 to H−1 |
| `nullifiers` | Every spent tag published so far, in the order they were applied |
| `listings` | Every listing ever made, in the order made: `nf`, `assetId`, `tickets`, `price`, `sellerScript`, `returnKey`, `lock` (`txid`, `vout`, `value`), `state`, `height` (the block it was listed in), `soldTxid`, `closedTxid`, `claimTxid`. Unset txids are `null` |
| `minted` | Piece numbers, in the order they were minted: `minted[k]` is the piece of the k-th note whose `kind` is `mint` |

`lock`, `returnKey` and `sellerScript` describe how a listing is held on Bitcoin. You don't need them to show or link a listing: buying happens only on Ord Dropz. `digest` does not cover them, so take them only from an indexer you trust, ours or your own.

A listing's `state` is one of:

- `ACTIVE`: for sale.
- `SOLD`: bought. `soldTxid` is the buy.
- `CLAIMED`: taken back by the seller. `claimTxid` is the claim.
- `CLOSED`: its lock was spent with no buy and no claim in the same transaction (`closedTxid`). The seller can still claim it.

A cancel takes the piece back in the same transaction, so it goes straight from `ACTIVE` to `CLAIMED`. At block 970880 there were 2,018 `SOLD`, 1,401 `CLAIMED`, 203 `ACTIVE` and 0 `CLOSED` listings.

A `SOLD` listing's `price` is what the piece sold for. The block of a sale is the `height` of the `buy` note with the same txid as `soldTxid`. The block of a claim is the `height` of the `claim` note with the same txid as `claimTxid`.

The API shows confirmed blocks only. An `ACTIVE` listing may already have a buy or a cancel waiting to confirm.

Numbers too large for JSON are decimal strings: `cm`, `nf`, every nullifier, `root` and `price` here, and `nf`, `price`, `saleFee` and `royalty` in `/listings`.

### `GET /collections`

Every shielded collection this indexer knows. Open: no key needed. The indexer finds them on Bitcoin itself: every parent inscription whose content is valid rules gets its own copy of the rules engine, replayed from its parent's block.

```json
[{"cid":"a1e7879252940f5e","parent":"896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0","name":"Shielded Nakas","kind":"collection","supply":3333,"startBlock":969342,"range":{"start":0,"end":3332,"height":969349,"txid":"258e66c52845f47c9be9eebc4540bbdaebf8c95e071052a26da8c38067b1e04a"},"lastHeight":970880,"notes":7091,"digest":"dda7632860eea253a02ecc4be079c3f4f7cdd6852474ab40fed056ba0e25455b","primary":true}]
```

A collection that pinned a different proof verification key than this software carries is listed with `"skipped"` and the reason; its routes answer `409`.

A collection found on Bitcoin that has not had a valid mint yet is listed with `"followed": false` and `"lastHeight": null`. The indexer starts following it at its first valid mint, replaying from its parent's block, so its state is the same as if it had been followed from the start. Until then `/c/<cid>/…` answers `404`.

### `GET /c/<cid>/…`

`/status`, `/state`, `/listings`, `/collection` and the `/pieces` routes for one collection, by its `cid` from `/collections`. `/c/<cid>` alone is its `/status`.

```
curl -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/c/a1e7879252940f5e/listings
```

The routes without `/c/<cid>/` answer for the indexer's primary collection (Shielded Nakas on the hosted API). They never change meaning when a new collection appears. `/registry`, `/collections` and the names routes are the same answer under any prefix.

### `GET /pieces/info`

The piece index of a file-mint collection: which child inscription is which piece, read from Bitcoin. A child is an inscription in a tx that spends the parent inscription and names it as its parent; its piece is its metadata's `shielded.piece` (PROTOCOL-v1.md, "Children of a file-mint collection"). Metadata only: the state and its `digest` do not depend on it.

```json
{"parent":"896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0","parentAt":"e8f99351a4bb6245cfb78d104793e64c6e410c12fabe597662e7d7db28463b4b:0","supply":3333,"minted":3327,"withChild":3327,"pages":4,"perPage":1000,"art":{"root":"a6146695afd979a5b8f355c7963e3e4c38e471013ab30f5a085a1c42bc20128d","have":3327,"of":3333,"verified":null},"ignored":[],"digest":"d8fbcae2249bd95af8b9049a36bdb071ca9919bbb97651d8a130a11476b0e2d4","height":970880}
```

| Field | Meaning |
|---|---|
| `parentAt` | The outpoint holding the parent inscription now, `"lost"` if its sat went to the fees (no later child counts), or `null` before its reveal |
| `minted`, `withChild` | Pieces minted, and pieces with a child inscription |
| `art` | `verified` is `true` or `false` once every piece has a child (`artRoot` recomputed from the children's content hashes), `null` until then |
| `ignored` | Inscriptions that claimed the parent but are not a piece's child, with the reason (`piece already has a child`, `no shielded.piece`, `metadata unreadable`, …). The first 1,000; `ignoredTotal` appears when there are more |
| `digest` | Running SHA-256 over every child taken. Two indexers at the same `height` with the same `digest` hold the same piece map |

### `GET /pieces?page=<k>`

Every piece in pages of 1,000 (`k` from 0 to `pages - 1`; anything else is a `404`, not counted). Compact rows with dictionaries local to the page:

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

`via` is `metadata` (its `shielded.piece`) or `pinned` (a pin in `src/v1/collections.mjs` whose Merkle path to `artRoot` checks; Shielded Nakas piece 0 is placed this way). `metadata` is the child's tag-5 metadata as inscribed (`null` when it has none, or more than 4 KB). No art bytes are served: fetch the content from any ord server and check it against `sha256`.

The `/pieces` routes cost 1 unit each. Their ETag comes from the answer itself, so a page whose pieces did not change keeps its ETag from block to block, and `If-None-Match` gets a `304`. An answer whose pieces are all minted and inscribed, at least 6 blocks deep, with the collection's global numbers known, has `"final": true` and is sent with `cache-control: private, max-age=31536000, immutable`. A collection without a piece index (pre-inscribed, or an indexer run with `PIECES=0`) answers `404`.

### `GET /registry`

Every shielded collection found on Bitcoin, in global number order. A collection with no mint yet comes last.

```json
[
  { "cid": "a1e7879252940f5e", "parent": "896803ff…i0", "name": "Shielded Nakas", "supply": 3333, "launchedAt": 969343,
    "range": { "start": 0, "end": 3332, "height": 969349, "txid": "258e66c5…" } }
]
```

| Field | Meaning |
|---|---|
| `cid` | The collection id |
| `parent` | The parent inscription |
| `name`, `supply` | From the rules |
| `launchedAt` | The block of the parent inscription |
| `range` | `{ start, end, height, txid }`: the global numbers, and the block and transaction of the first valid mint. `null` until then |

A collection takes its number range at its first valid mint.

### Shielded names

A shielded name (`obi.naka`) points at a shielded address. The first inscription of a label wins, for ever, whatever its ending (`obi.naka` holds the label `obi`, so `obi.shield` can never resolve). The names routes are the same answer under any `/c/<cid>/` prefix. They change only when the registry applies a block, so their ETag is `"<height>-<last 8 hex of that block's hash>-<12 hex>"`.

A name is a public inscription that anyone can make, pointing at any shielded address. It does not prove who holds that vault, and selling the name's inscription does not change where it points.

Bad input gets a `400` before anything is counted. A valid name nobody holds gets a `404`, counted like any lookup:

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"not a valid name"}` | Not a name: `a.naka` (a label is 3 to 20 letters, digits or dashes), `x--y.naka`, `obi.btc` (the endings are `.naka` and `.shield`) |
| `400` | `{"error":"that name is reserved"}` | A label nobody can take, such as `admin.naka` |
| `400` | `{"error":"malformed %-escape in the name"}` | The path is not valid URL encoding (also `… in the address`) |
| `400` | `{"error":"not a shielded address"}` | `/names/of/` with something that is not `shord1` and 128 hex digits |
| `400` | `{"error":"after must be a whole number"}` | `/names?after=` with anything but digits |
| `400` | `{"error":"after is past the last name (there are …)"}` | `/names?after=` beyond the end of the list |
| `404` | `{"error":"nobody has that name"}` | A valid name nobody holds. Counted (1 unit) like any lookup |

### `GET /names/info`

The state of the shielded names index. Open: no key needed.

```json
{"start":969800,"height":970880,"count":177,"digest":"392f37d9ae770809e5f93bd0ae23c46056a6c87eab757af990158db986cdd94c","index":{"start":969800,"height":970880,"count":177,"digest":"392f37d9ae770809e5f93bd0ae23c46056a6c87eab757af990158db986cdd94c"}}
```

`start` is the first block names count from. `height` is the last block read, `count` the number of names, and `digest` a running hash over every name in order. `index` repeats the same four fields; it is the shape `tools/names-indexer.mjs --compare` reads.

Two indexers at the same `height` with the same `digest` hold the same names. Your own names index can check the hosted one without a key: `node tools/names-indexer.mjs --compare https://shielded-public-api-production.up.railway.app/names/info`.

### `GET /names?after=<i>`

Every name, in the order they were accepted, 500 to a page. 1 unit a page. `after` is how many names to skip (default `0`); `next` is the `after` of the next page, or `null` after the last name.

```
curl -H "x-api-key: shord_…" "https://shielded-public-api-production.up.railway.app/names?after=0"
```

```json
{ "start": 969800, "height": 970151, "count": 14, "digest": "b797be8e…", "after": 0, "digestBefore": "6593be23…",
  "names": [ { "i": 0, "name": "obi.naka", "to": "shord1…", "id": "<inscription id>", "height": 969806 } ], "next": null }
```

`digestBefore` is the running digest before the page's first name, so you can check that the list is the one `/names/info` publishes: start from `sha256("shord-names-v1")` (`6593be23af5bb0fe4cdafeeaacf106417148cb74625b4141eced06ffc623a895`), and for each name in order take `sha256("<previous digest>|<height>|<id>|<name>|<to>")` (hex, as text). After the last page the result equals `digest`.

```js
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
let d = await sha('shord-names-v1'), after = 0, page;
do {
  page = await (await fetch(`${API}/names?after=${after}`, { headers: { 'x-api-key': KEY } })).json();
  if (page.digestBefore !== d) throw new Error('this page does not continue the list');
  for (const n of page.names) d = await sha(`${d}|${n.height}|${n.id}|${n.name}|${n.to}`);
  after = page.next;
} while (after !== null);
// d === page.digest: every name, and the same names /names/info publishes
```

An `after` past the last name gets `400` (a block replaced at the tip can take a name away: read the list again from `0`).

### `GET /names/<name>`

The shielded address a name points at. The name is trimmed and lowercased first, so `OBI.NAKA` finds `obi.naka`.

```
curl -H "x-api-key: shord_…" https://shielded-public-api-production.up.railway.app/names/obi.naka
```

```json
{ "name": "obi.naka", "address": "shord1…", "to": "shord1…", "id": "<inscription id>", "height": 969806 }
```

`to` and `address` are the same value (`to` is the field `/names/of` and `/names` use; `address` is kept for clients written before). Answers `404` when nobody holds the name, and `400` when it is not a valid name or the label is reserved. A name counts only once its inscription is in a block.

### `GET /names/of/<shielded address>`

Every name pointing at an address, earliest first: `{ "names": [ { "name", "label", "to", "id", "height" } ] }`. Upper and lower case are the same address; anything that is not a shielded address gets `400`.

### `GET /health`

`{"ok":true}` as soon as the process is up. Not counted against any limit.

## For operators: giving out keys

This part is for whoever runs an indexer for other people. An indexer you run for yourself needs none of it.

Start the indexer with a keys file:

```
API_KEYS_FILE=/data/api-keys.json COLLECTION=shielded-nakas node indexer/indexer.mjs
```

| Variable | Meaning | Default |
|---|---|---|
| `API_KEYS_FILE` | Where key hashes are kept. Setting it turns keys and limits on | off |
| `API_KEY_REQUIRED` | `1` refuses every call without a key, except `/status`, `/collections`, `/names/info` and `/health` | `0` |
| `PUBLIC_LIMIT` | Units a minute for callers without a key, per address. A call that costs more (the full `/state` is 20) gets `403` | `30` |
| `TRUST_PROXY` | How many proxies stand in front of the indexer. The caller's address is read that many steps back in `X-Forwarded-For`. Leave `0` when callers connect directly | `0` |
| `ADMIN_SECRET` | A long secret that turns on key management over HTTP | off |

Set `TRUST_PROXY` to exactly the number of proxies in front of the indexer. Set too high, a caller can choose their own address by sending `X-Forwarded-For`, and so get around the limits. Left at `0` behind a proxy, every caller counts as the proxy's address and they all share one allowance.

Only the SHA-256 of each key is stored, so a copy of the keys file can't be used to call the API. Units per key per day are counted in `usage.json` beside it, and the daily limit is enforced from that count. New keys get 60 units a minute and 5,000 a day unless you say otherwise.

On the machine that holds the file, with the same `API_KEYS_FILE` set (without it, these commands use `api-keys.json` in the current folder):

```
node indexer/keys.mjs create "who it is for" 60 5000      # per minute, per day
node indexer/keys.mjs limits <id> 300 20000               # change a key's limits
node indexer/keys.mjs list
node indexer/keys.mjs revoke <id>
```

`create` prints the key once. A running indexer picks up a new or revoked key within a few seconds.

Or over HTTP, when `ADMIN_SECRET` is set. Serve the indexer over HTTPS only, because the secret travels in a header, and use a long random secret.

```
curl -X POST https://<your indexer>/admin/keys -H "x-admin-secret: …" -H "content-type: application/json" -d '{"label":"who it is for","limit":60,"daily":5000}'
curl -X POST https://<your indexer>/admin/keys/limits -H "x-admin-secret: …" -H "content-type: application/json" -d '{"id":"<id>","limit":300,"daily":20000}'
curl https://<your indexer>/admin/keys -H "x-admin-secret: …"
curl -X POST https://<your indexer>/admin/keys/revoke -H "x-admin-secret: …" -H "content-type: application/json" -d '{"id":"<id>"}'
```

The first answers with the new key. The third lists every key with its units used on each day.

The same four commands work from your own machine against that indexer, so you never handle the HTTP calls yourself. Keep the admin secret in a file:

```
node indexer/keys.mjs create "who it is for" 60 5000 --at https://<your indexer> --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs limits <id> 300 20000 --at https://<your indexer> --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs list --at https://<your indexer> --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs revoke <id> --at https://<your indexer> --secret-file ~/.secrets/indexer-admin.txt
```
