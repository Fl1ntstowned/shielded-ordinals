# Run your own indexer

The indexer reads Bitcoin blocks, applies the Shielded Ordinals rules, and holds the full public state of every shielded collection it finds: every note, every listing, every sale. It reads blocks from a Bitcoin node (`BITCOIN_RPC`). It needs no account and no key. Two indexers at the same block hold the same state, and one command checks that.

## What you need

| | |
|---|---|
| Node.js | 20 or newer |
| Bitcoin Core | 25.0 or newer, synced. `txindex` is not needed. A pruned node works as long as it still holds every block from the collection's start block |
| Disk | about 1.1 MB per block followed (1.7 GB for Shielded Nakas at block 970881), plus about 10 KB per block for the registry and about 3 MB per checkpoint (4 kept per collection) |

### A pruned node

The indexer only reads blocks from the collection's start block onward (Shielded Nakas starts at block 969342), and it keeps its own copy of what it reads. So:

- For the first sync, the node must still hold every block back to the start block. Blocks take about 1.5 to 2 MB each on the node, around 250 MB a day. Set `prune=` in `bitcoin.conf` to at least the space those blocks need, with room to spare. If the node has already pruned past the start block, the first sync stops with `Block not available (pruned data)`.
- After the first sync, the node can prune freely. The indexer only asks for new blocks.

Your node must accept RPC calls from the machine the indexer runs on. In `bitcoin.conf`:

```
server=1
rpcuser=indexer
rpcpassword=<a long random password>
```

Or leave those out and use the node's cookie file (see below).

## Install

```
git clone <this repository>
cd shielded-ordinals
npm install
```

## Start it

Give it your node's RPC address:

```
BITCOIN_RPC=http://indexer:<password>@127.0.0.1:8332 COLLECTION=shielded-nakas node indexer/indexer.mjs
```

With the cookie file instead of a password:

```
BITCOIN_RPC=http://127.0.0.1:8332 BITCOIN_RPC_COOKIE=~/.bitcoin/.cookie COLLECTION=shielded-nakas node indexer/indexer.mjs
```

On Windows PowerShell, set the variables first:

```
$env:BITCOIN_RPC = "http://indexer:<password>@127.0.0.1:8332"
$env:COLLECTION = "shielded-nakas"
node indexer/indexer.mjs
```

The first start replays every block since the collection began and checks every proof. It prints its progress. Blocks it has read are kept in `.cache-indexer`, and so is a saved copy of the state (a checkpoint, see [Restarts](#restarts)), so a restart loads that, replays only the blocks after it, and asks the node only for new blocks.

The replay itself is quick: from a local block cache, every block from 969342 to 970881 replayed in 126 to 203 s on a desktop PC (2026-10-11, depending on what else it was doing). Reading the blocks from the node comes on top of that.

When it says `synced`, it is serving on port 5021:

```
curl http://127.0.0.1:5021/status
```

```
{"network":"mainnet","collection":"Shielded Nakas","rulesInscriptionId":"896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0","cid":"a1e7879252940f5e","lastHeight":970880,"blockHash":"0000000000000000000194034f33fcdddad4b9c763822cc5f6fb99b04ad05d85","notes":7091,"digest":"dda7632860eea253a02ecc4be079c3f4f7cdd6852474ab40fed056ba0e25455b","software":"shielded-ordinals indexer","collections":1,"checkpoint":{"height":970848}}
```

## Check it against another indexer

`digest` is a SHA-256 over a summary of the state (see [API.md](API.md) for exactly what it covers): two indexers at the same `lastHeight` with the same `digest` hold the same note tree, spent tags, minted pieces, and listing states and prices.

```
COLLECTION=shielded-nakas node indexer/indexer.mjs --compare https://shielded-public-api-production.up.railway.app/status
```

Any indexer's `/status` works; Ord Dropz's site server answers at `<site API>/api/shielded/status`. It syncs, waits until both stand at the same block (up to 6 tries, 20 s apart), and prints `AGREE` (exit 0) or `DISAGREE` (exit 1). Exit 2 means it could not compare.

To sync once, print the status and exit:

```
COLLECTION=shielded-nakas node indexer/indexer.mjs --once
```

## Running it as a service

`npm start` runs the indexer. It reads `PORT` from the environment, answers `/health` as soon as the process is up (and `503 still syncing` on the other routes until the first replay finishes), and keeps its block cache and its checkpoints in `CACHE_DIR`. On a host that gives you a persistent disk, point `CACHE_DIR` at it so a restart loads the last checkpoint instead of replaying, and reads blocks from disk instead of asking the chain source again. Behind a reverse proxy, set `TRUST_PROXY` to the number of proxy hops so request limits see the real caller.

When the host stops the service it sends `SIGTERM`. The indexer then starts no new sync round, finishes the block it is applying, saves a checkpoint of every collection at its last block, and exits with code 0. A stop that does not wait for that loses nothing either: the next start uses the newest checkpoint already on disk.

Serving other people (API keys and limits) is in [API.md](API.md#for-operators-giving-out-keys).

## Restarts

A checkpoint is a sealed copy of one collection's whole state after a block: every note, spent tag, listing (with the block each was listed in), minted piece, the root of the note tree after every block since the start block, the indexer's log of every accepted and refused transaction, and the piece index. It is written to `CACHE_DIR/checkpoints/<network>/<cid>/<block>-<block hash>.json.gz`, about 3 MB for Shielded Nakas at block 970880.

- **When.** At the tip, after every block whose height is a multiple of `CHECKPOINT_EVERY` (6, about an hour); every 144 blocks during a long replay, so an interrupted first sync carries on from there; and on `SIGTERM`. The newest `CHECKPOINT_KEEP` (4) are kept per collection.
- **On start.** The newest checkpoint is checked before it is used: it must come from the same rules, verification key, start block, network and engine (a hash of the rule code in `src/v1/` and the versions of the libraries it uses); its seal must match its content; the note tree is rebuilt from the notes and must give every saved root; the state digest and the listing locks must agree; and its block must still be in the best chain. If any check fails, the indexer says why and tries the next older one, then falls back to a full replay. Then it replays only the blocks after it. At block 970880 (7,091 notes) a restart answered `/status` within 18 s, most of it rebuilding the note tree to check every saved root; that time grows with the chain.
- **After a release.** A release that changes the rule code (anything in `src/v1/`) or a library version makes the old checkpoints unusable, and the first start replays every block once (2 to 3.5 minutes for Shielded Nakas from a local block cache at block 970881). A release that changes only the API (`indexer/`) restarts in seconds.
- **After a chain reorganisation.** The indexer goes back to the newest checkpoint whose block is still in the best chain, replays the new blocks next to the state it is serving, and swaps at the tip. The API keeps answering from the old state until then; no route returns `503`.
- **Block hashes.** `CACHE_DIR/<network>-hashes.json` keeps the hash of every block read, each entry linked to the one before it. A restart checks the last few against the chain source (about 2 requests) instead of asking for every block's hash again.

Deleting `CACHE_DIR/checkpoints` is always safe: the next start replays from the start block. `CHECKPOINTS=0` turns checkpoints off.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `BITCOIN_RPC` | Your node's RPC address, with or without `user:password@` | none |
| `BITCOIN_RPC_COOKIE` | Path to the node's `.cookie` file, when the address has no password | none |
| `CHAIN_API` | An esplora-style HTTP API to read blocks from instead of a node, for testing | a public esplora API |
| `COLLECTION` | A collection this software knows by name (`src/v1/collections.mjs`) | none |
| `RULES_INSCRIPTION_ID` | Any other collection: its parent inscription id | none |
| `START_HEIGHT` | Any other collection: the block to start from, at or before the parent's block | none |
| `RULES_BLOCK` | Any other collection: hash of the block holding the parent. A node without `txindex` needs it | none |
| `RULES_FILE` | Test collections whose rules are not inscribed | none |
| `FOLLOW_ALL` | `0` follows only the collection given above. By default every shielded collection found on Bitcoin is followed too, each with its own copy of the rules engine, all sharing the block cache | `1` |
| `FOLLOW_MINTED_ONLY` | A collection found on Bitcoin is followed from its first valid mint on. Its replay still starts at its parent's block, so its state is the same, and a parent that never mints costs nothing. `0` follows every parent as soon as it is seen | `1` |
| `REGISTRY_START` | Leave unset: every indexer must count global numbers from the same block | 969342 (mainnet) |
| `CHECKPOINTS` | `0` turns checkpoints off (every start replays from the start block) | `1` |
| `CHECKPOINT_EVERY` | At the tip, a checkpoint after every block whose height is a multiple of this | `6` |
| `CHECKPOINT_KEEP` | Checkpoints kept per collection | `4` |
| `NETWORK` | `mainnet` or `signet` | `mainnet` |
| `PORT` | Port the read API listens on | `5021` |
| `CACHE_DIR` | Where read blocks, block hashes, checkpoints and the piece index's txs are kept | `.cache-indexer` |
| `PIECES` | `0` turns off the piece index (which child inscription is which piece, `/pieces`). It reads the txs that spend each file-mint collection's parent, one request each, once, and never changes the state or its digest | `1` |
| `STOP_HEIGHT` | Sync no further than this block, as if it were the tip: for a replay that must stay inside the blocks already in `CACHE_DIR`, or a test. Leave it unset on an indexer that serves others | none |
| `API_KEYS_FILE`, `API_KEY_REQUIRED`, `PUBLIC_LIMIT`, `TRUST_PROXY`, `ADMIN_SECRET` | Serving other people, see [API.md](API.md#for-operators-giving-out-keys) | off |

Give `BITCOIN_RPC` to read from your node; without it blocks come from `CHAIN_API`. Give either `COLLECTION` or the `RULES_INSCRIPTION_ID` and `START_HEIGHT` pair.

## The read API

Every route is a `GET` and answers JSON.

| Route | Answers |
|---|---|
| `/status` | Network, collection, last block applied and its hash, note count, state digest, newest checkpoint |
| `/state` | The full public state: notes, spent tags, listings, recent tree roots, minted pieces. `?since=<note count>` returns only the notes after that many |
| `/listings` | Active listings: piece, child inscription, price, sale fee, credits |
| `/collection` | The collection's rules as inscribed, minted count, global number range, piece index summary |
| `/registry` | Every shielded collection found on Bitcoin, with its global number range |
| `/collections` | Every collection this indexer follows, with each one's last block, note count and digest; a collection found on Bitcoin that has not minted yet is listed with `"followed": false` |
| `/pieces?page=<k>`, `/pieces/<assetId>`, `/pieces/info` | File-mint collections: each piece's child inscription, mint and metadata, and the art check |
| `/c/<cid>/…` | `/status`, `/state`, `/listings`, `/collection` and `/pieces` for one collection by its cid |
| `/names/info`, `/names?after=<i>`, `/names/<name>`, `/names/of/<address>` | Shielded names |
| `/health` | `{"ok":true}` as soon as the process is up |

Answers are sent br or gzip when the client asks, with `content-length` and an ETag (`If-None-Match` gets a `304`). Field-by-field descriptions are in [API.md](API.md).

## What the indexer checks for itself

- Every block is the block that was asked for (its header hashes to the requested hash), its transactions match the header, its hash meets the proof-of-work target in its header, and it builds on the block applied before it. On mainnet that target must also be no easier than 1,024 times the target of block 969342, so made-up blocks would need real mining work.
- The collection's rules come out of the parent inscription's own transaction.
- The proof verification key in `zk/spend_vkey.json` is the one the collection is pinned to. Any other key is refused at start.
- A block is applied only if it directly follows the last one. After a chain reorganisation the state is rebuilt from the newest checkpoint still in the best chain (or from the start block), next to the state being served.
- A checkpoint is used only after the checks in [Restarts](#restarts).

What it takes on trust. From the node: which chain is the best chain. That is the node's job. With `CHAIN_API` instead of a node, it trusts that API to name the best chain: the blocks it gets must carry their proof of work and link to each other, but an API could still hold back newer blocks or point at a weaker branch. It also takes from that API the scripts of the coins a mint spends (the mint-gate rule) and, for the piece index only, the values of the coins that a tx moving the parent spends.

## Trouble

| Message | Cause |
|---|---|
| `the node did not return the coins spent by …` | The node is older than 25.0 |
| `bitcoin node, getblock: Block not available (pruned data)` | The node pruned blocks the collection needs. Use an unpruned node, or one pruned after the start block |
| `can't read the parent tx … from the node` | An unknown collection on a node without `txindex`. Set `RULES_BLOCK` |
| `HTTP 401` | Wrong RPC user, password or cookie path |
| `/…: 429` or `/…: 503` from `CHAIN_API` | The API is refusing or busy. The indexer retries 5 times, then the next sync round (20 s later) carries on from the last block applied |
| `still syncing` from the API | The first replay has not reached the tip yet |
| `checkpoint … not used: …` | That saved state failed a check (the reason follows); an older one or a full replay is used instead. After a release that changed the rule code, `another engine` is expected once |
