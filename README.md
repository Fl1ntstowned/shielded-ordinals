# Shielded Ordinals

Private ownership of Bitcoin ordinals. The art of every piece is public. Who holds it is not.

A collection is one parent inscription that carries its rules. Each piece is a child inscription under that parent. Ownership is a hidden note in a Merkle tree, and every action (mint, send, list, buy, cancel) is a Bitcoin transaction with an `OP_RETURN` message. A send or a listing carries a zero-knowledge proof that the sender holds the note, without saying which note. Anyone can replay Bitcoin's blocks with the indexer in this repository and arrive at the same state.

There is no token, no sidechain and no bridge. Everything is in Bitcoin blocks.

## What is here

| Path | What |
|---|---|
| `PROTOCOL-v1.md` | The protocol: notes, envelopes, the listing lock, the proof circuit, the indexer's rules (rules v1 and v2) |
| `src/v1/` | The reference implementation of the rules: envelopes, rules, indexer, registry, names, chain reader, checkpoints, piece index |
| `circuits/` | The proof circuits (circom) |
| `zk/` | The verification keys the indexer checks proofs with |
| `indexer/` | An indexer anyone can run, with a read API. It reads blocks from a Bitcoin node and follows every shielded collection it finds on chain |
| `relayer/` | A relayer anyone can run: publishes private sends and listings in batches |
| `cosigner/` | Co-signer software for collections that use 2-of-3 co-signers |
| `tools/names-indexer.mjs` | A stand-alone index of shielded names (`obi.naka`) |
| `test/` | Tests: the offline suite (`npm test`) and the Bitcoin-node reader (needs network) |

## What is not here

The code that builds transactions (minting, listing, buying, sending, withdrawing) and the wallet are not in this repository. Transactions are built by the Ord Dropz site and wallet. Reading the state is open to anyone: run the indexer, or call the hosted read API described in [docs/API.md](docs/API.md). Nothing in that API can build or move anything.

## Run an indexer

You need Node.js 20 or newer and Bitcoin Core 25.0 or newer, reached with `BITCOIN_RPC`. The first sync replays every block since 969342 and keeps them in `.cache-indexer` (about 1.1 MB per block).

```
npm install
BITCOIN_RPC=http://user:password@127.0.0.1:8332 COLLECTION=shielded-nakas node indexer/indexer.mjs
```

Then `curl http://127.0.0.1:5021/status`. The full guide is [docs/RUN-AN-INDEXER.md](docs/RUN-AN-INDEXER.md).

To check that your indexer and someone else's hold the same state:

```
COLLECTION=shielded-nakas node indexer/indexer.mjs --compare https://shielded-public-api-production.up.railway.app/status
```

## Documentation

- [docs/RUN-AN-INDEXER.md](docs/RUN-AN-INDEXER.md): set up, settings, restarts, the read API, trouble
- [docs/API.md](docs/API.md): every route and field, API keys, limits, compression
- [docs/STATUS.md](docs/STATUS.md): what is live, what is proven, what changed in this release, what the protocol relies on, what is not built yet
- [PROTOCOL-v1.md](PROTOCOL-v1.md): the rules

## Tests

```
npm test                    # every offline test: API keys, serving, names, pieces, checkpoints, the chain view, the note tree, the indexer on a synthetic chain, no control bytes in the source
npm run test:keys           # API keys and limits, offline
npm run test:node           # the Bitcoin-node reader against a stand-in node, replaying a signet collection (needs network)
```

## Collections

| Collection | Network | Parent inscription | Start block |
|---|---|---|---|
| Shielded Nakas | mainnet | `896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0` | 969342 |
