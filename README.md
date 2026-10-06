# Shielded Ordinals

Private ownership of Bitcoin ordinals. The art of every piece is public. Who holds it is not.

A collection is one parent inscription that carries its rules. Each piece is a child inscription under that parent. Ownership is a hidden note in a Merkle tree, and every action (mint, send, list, buy, cancel) is a Bitcoin transaction with an `OP_RETURN` message. A send or a listing carries a zero-knowledge proof that the sender holds the note, without saying which note. Anyone can replay Bitcoin's blocks with the indexer in this repository and arrive at the same state.

There is no token, no sidechain and no bridge. Everything is in Bitcoin blocks.

## What is here

| Path | What |
|---|---|
| `PROTOCOL-v1.md` | The protocol: notes, envelopes, the listing lock, the proof circuit, the indexer's rules |
| `src/v1/` | The reference implementation of the rules: envelopes, rules, indexer, registry, names, chain reader |
| `circuits/` | The proof circuits (circom) |
| `zk/` | The verification keys the indexer checks proofs with |
| `indexer/` | An indexer anyone can run against their own Bitcoin node, with a read API |
| `relayer/` | A relayer anyone can run: publishes private sends and listings in batches |
| `cosigner/` | Co-signer software for collections that use 2-of-3 co-signers |
| `tools/names-indexer.mjs` | A stand-alone index of shielded names (`obi.naka`) |
| `test/` | The offline test suite |

## What is not here

The code that builds transactions (minting, listing, buying, sending, withdrawing) and the wallet are not in this repository. Building on the protocol goes through the Ord Dropz API, see [docs/API.md](docs/API.md).

## Run an indexer

You need Bitcoin Core 25.0 or newer and Node.js 20 or newer.

```
npm install
BITCOIN_RPC=http://user:password@127.0.0.1:8332 COLLECTION=shielded-nakas node indexer/indexer.mjs
```

Then `curl http://127.0.0.1:5021/status`. The full guide is [docs/RUN-AN-INDEXER.md](docs/RUN-AN-INDEXER.md).

To check that your indexer and someone else's hold the same state:

```
node indexer/indexer.mjs --compare https://<another indexer>/status
```

## Documentation

- [docs/RUN-AN-INDEXER.md](docs/RUN-AN-INDEXER.md): set up, settings, the read API, trouble
- [docs/API.md](docs/API.md): every route and field, API keys
- [docs/STATUS.md](docs/STATUS.md): what is live, what is proven, what the protocol relies on, what is not built yet
- [PROTOCOL-v1.md](PROTOCOL-v1.md): the rules

## Tests

```
npm test                    # both of the below
npm run test:keys           # API keys and limits, offline
npm run test:node           # the Bitcoin-node reader against a stand-in node, replaying a signet collection (needs network)
```

## Collections

| Collection | Network | Parent inscription | Start block |
|---|---|---|---|
| Shielded Nakas | mainnet | `896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0` | 969342 |
