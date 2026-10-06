# The indexer API

Every Shielded Ordinals indexer answers the same read API. You can call:

- **your own indexer**, at `http://127.0.0.1:5021` after following [RUN-AN-INDEXER.md](RUN-AN-INDEXER.md). No key, no limit.
- **the hosted API run by Ord Dropz**, at `https://API_HOST`, with an API key from Ord Dropz.

Both give the same answers at the same block. Everything served is public data read from Bitcoin. Nothing in this API can move a piece or reveal who holds one.

Every route is a `GET`, answers JSON, and allows calls from a browser on any site.

## API keys (hosted API)

Ask Ord Dropz for a key. A key looks like this:

```
shord_Zr3kP0c1x7Qe9b2mV5tY8uA4wL6nH1sD0fG3jK7oXcE
```

Send it in a header on every call:

```
curl -H "x-api-key: shord_…" https://API_HOST/status
```

`Authorization: Bearer shord_…` works the same. Keep the key on your server. Don't put it in a web page or an app that people download, because anyone who reads it can use up your allowance.

### Limits

| Caller | Allowance |
|---|---|
| With a key | The key's own limit, 600 requests a minute unless Ord Dropz set another |
| Without a key | 30 requests a minute, shared by everyone at the same network address |

Every answer says where you stand:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` | Requests allowed this minute |
| `x-ratelimit-remaining` | Requests left this minute |
| `retry-after` | On a refusal: seconds until the next minute starts |

The allowance resets at the start of each clock minute.

### Errors

| Status | Body | Meaning |
|---|---|---|
| `401` | `{"error":"This API key is not valid."}` | The key is wrong, mistyped or revoked |
| `401` | `{"error":"An API key is needed. …"}` | This API accepts no calls without a key |
| `404` | `{"error":"not found"}` | No such route |
| `429` | `{"error":"Too many requests …"}` | Over the limit. Wait `retry-after` seconds |
| `503` | `{"error":"still syncing"}` | The indexer is replaying blocks. Try again shortly |

A wrong key is always refused. It is never treated as a call without a key.

## How to use it well

Poll `/status`. It is small. Read `/state` or `/listings` again only when `lastHeight` changed, because the state only changes when a block lands.

`/state` is large (several megabytes for a traded collection). Fetch it once, remember `noteCount`, and afterwards ask for `/state?since=<noteCount>` to receive only the notes you don't have.

## Routes

### `GET /status`

Where the indexer stands.

```
curl https://API_HOST/status
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

### `GET /listings`

Pieces for sale now.

```json
[
  { "nf": "1830…", "assetId": 86, "inscriptionId": null, "price": "47800", "saleFee": "1000", "tickets": 2, "listedAt": 969650 }
]
```

| Field | Meaning |
|---|---|
| `nf` | The listing's id (the spent tag of the note that was listed), a decimal number in a string |
| `assetId` | The piece number inside the collection, from 0 |
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
curl https://API_HOST/names/obi.naka
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
| `API_KEY_REQUIRED` | `1` refuses every call without a key | `0` |
| `PUBLIC_LIMIT` | Requests a minute for callers without a key, per address | `30` |
| `TRUST_PROXY` | How many proxies stand in front of the indexer. The caller's address is read that many steps back in `X-Forwarded-For`. Leave `0` when callers connect directly | `0` |
| `ADMIN_SECRET` | A long secret that turns on key management over HTTP | off |

Only the SHA-256 of each key is stored, so a copy of the keys file can't be used to call the API. Calls per key per day are counted in `usage.json` beside it.

On the machine that holds the file:

```
node indexer/keys.mjs create "who it is for" 600
node indexer/keys.mjs list
node indexer/keys.mjs revoke <id>
```

`create` prints the key once. A running indexer picks up a new or revoked key within a few seconds.

Or over HTTP, when `ADMIN_SECRET` is set:

```
curl -X POST https://API_HOST/admin/keys -H "x-admin-secret: …" -H "content-type: application/json" -d '{"label":"who it is for","limit":600}'
curl https://API_HOST/admin/keys -H "x-admin-secret: …"
curl -X POST https://API_HOST/admin/keys/revoke -H "x-admin-secret: …" -H "content-type: application/json" -d '{"id":"<id>"}'
```

The first answers with the new key. The second lists every key with its calls per day.

The same three commands work from your own machine against that indexer, so you never handle the HTTP calls yourself. Keep the admin secret in a file:

```
node indexer/keys.mjs create "who it is for" 600 --at https://API_HOST --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs list --at https://API_HOST --secret-file ~/.secrets/indexer-admin.txt
node indexer/keys.mjs revoke <id> --at https://API_HOST --secret-file ~/.secrets/indexer-admin.txt
```
