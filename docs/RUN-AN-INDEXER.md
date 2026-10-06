# Run your own indexer

The indexer reads Bitcoin blocks from your own node, applies the Shielded Ordinals rules, and holds the full public state of a collection: every note, every listing, every sale. It needs no account, no key and no outside server. Two indexers at the same block always hold the same state, and one command checks that.

## What you need

| | |
|---|---|
| Bitcoin Core | 25.0 or newer, synced. `txindex` is not needed. A pruned node works as long as it still holds every block from the collection's start block |
| Node.js | 20 or newer |
| Disk | about 1.5 MB per block followed |

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

The first start replays every block since the collection began and checks every proof. It prints its progress. Blocks it has read are kept in `.cache-indexer`, so a restart replays from disk and asks the node only for new blocks.

When it says `synced`, it is serving on port 5021:

```
curl http://127.0.0.1:5021/status
```

```
{"network":"mainnet","collection":"Shielded Nakas","lastHeight":970084,"blockHash":"0000…","notes":5033,"digest":"2509…2f69","software":"shielded-ordinals indexer"}
```

## Check it against another indexer

`digest` is a SHA-256 over the whole state. Two indexers at the same `lastHeight` with the same `digest` hold exactly the same notes, spent tags, minted pieces and listings.

```
BITCOIN_RPC=… COLLECTION=shielded-nakas node indexer/indexer.mjs --compare https://<another indexer>/status
```

It syncs, waits until both stand at the same block, and prints `AGREE` or `DISAGREE`.

To sync once, print the status and exit:

```
BITCOIN_RPC=… COLLECTION=shielded-nakas node indexer/indexer.mjs --once
```

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `BITCOIN_RPC` | Your node's RPC address, with or without `user:password@` | none |
| `BITCOIN_RPC_COOKIE` | Path to the node's `.cookie` file, when the address has no password | none |
| `CHAIN_API` | An esplora or mempool HTTP API to read blocks from, instead of a node | none |
| `COLLECTION` | A collection this software knows by name (`src/v1/collections.mjs`) | none |
| `RULES_INSCRIPTION_ID` | Any other collection: its parent inscription id | none |
| `START_HEIGHT` | Any other collection: the block to start from, at or before the parent's block | none |
| `RULES_BLOCK` | Any other collection: hash of the block holding the parent. A node without `txindex` needs it | none |
| `NETWORK` | `mainnet` or `signet` | `mainnet` |
| `PORT` | Port the read API listens on | `5021` |
| `CACHE_DIR` | Where read blocks are kept | `.cache-indexer` |

Give either `BITCOIN_RPC` or `CHAIN_API`. Give either `COLLECTION` or the `RULES_INSCRIPTION_ID` and `START_HEIGHT` pair.

## The read API

Every route is a `GET` and answers JSON.

| Route | Answers |
|---|---|
| `/status` | Network, collection, last block applied and its hash, note count, state digest |
| `/state` | The full public state: notes, spent tags, listings, recent tree roots, minted pieces. `?since=<note count>` returns only the notes after that many |
| `/listings` | Active listings: piece, price, sale fee, credits |
| `/collection` | The collection's rules, minted count, global number range |
| `/registry` | Every shielded collection found on Bitcoin, with its global number range |

Field-by-field descriptions are in [API.md](API.md).

## What the indexer checks for itself

- Every block is the block that was asked for (its header hashes to the requested hash) and its transactions match the header.
- The collection's rules come out of the parent inscription's own transaction.
- The proof verification key in `zk/spend_vkey.json` is the one the collection is pinned to. Any other key is refused at start.
- A block is applied only if it directly follows the last one. After a chain reorganisation the state is rebuilt from the start block.

What it takes from your node on trust: which chain is the best chain. That is your node's job, and the reason to run your own.

## Trouble

| Message | Cause |
|---|---|
| `the node did not return the coins spent by …` | The node is older than 25.0 |
| `bitcoin node, getblock: Block not available (pruned data)` | The node pruned blocks the collection needs. Use an unpruned node, or one pruned after the start block |
| `can't read the parent tx … from the node` | An unknown collection on a node without `txindex`. Set `RULES_BLOCK` |
| `HTTP 401` | Wrong RPC user, password or cookie path |
| `still syncing` from the API | The first replay has not reached the tip yet |
