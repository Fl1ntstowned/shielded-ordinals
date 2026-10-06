# State of the protocol

Last checked 2026-10-05. Everything here was tested or read from Bitcoin on that day; nothing is assumed.

## Live on mainnet

| | |
|---|---|
| Protocol | SHORD v1, as written in [PROTOCOL-v1.md](../PROTOCOL-v1.md) |
| First collection | Shielded Nakas, 3,333 pieces, global numbers #0 to #3332. Parent inscription `896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0`, block 969343 |
| Minted | 3,327 pieces. 6 are in mint transactions that have not confirmed |
| Activity at block 970094 | 5,034 notes, about 595 active listings |
| Names | Live since block 969800 (`bob.naka`, `bob.shield`), 12 names |
| Indexer start block | 969342 for the collection and for global numbering |

## Proven

- **Independent indexers agree.** On 2026-10-05 the indexer in this repository replayed Shielded Nakas from block 969342 on its own and reached the same state digest as the Ord Dropz server, twice, at blocks 970089 and 970094 (5,034 notes each time). That includes mint day, every proof, every sale and every cancel.
- **The rules are deterministic.** No clocks, no randomness and no server data take part in accepting or rejecting a transaction. The node-source test (`npm run test:node`) replays a signet collection through two different block sources to the identical state.
- **Reading from a plain Bitcoin node** reaches the same state as reading from an HTTP API (`npm run test:node`, signet, 8 checks). This used a stand-in node that answers the same four RPC calls with real block data. A run against a real `bitcoind` has not been recorded yet.
- **The verification keys in `zk/`** are byte for byte the ones the live site checks against.
- **Private names.** A name bought through the wallet was inscribed by the relayer from an unrelated coin, with no on-chain link to the buyer's payment (mainnet, `dub.naka`).

## What the protocol relies on

Stated plainly, because anyone running an indexer should know them.

1. **The proof setup was a single contribution.** The Groth16 keys for the spend circuit were produced in one local run. The secret from that run is discarded by the software, but nobody outside can verify that it was. Someone who held it could forge a proof and create a duplicate of a piece (never take one out of a vault). A forgery would show in `/state` as the same piece listed or sold twice over. Before the next collection launches, a public multi-party setup (`ceremony/ceremony.mjs`) is planned, with its key hash written into that collection's parent.
2. **The Shielded Nakas parent does not carry `spendVkeyHash`.** Its verification key is pinned in `src/v1/collections.mjs` instead. Every indexer built from this repository checks the same key; a parent inscribed with the hash would make that check independent of the software.
3. **Mint and buy need the platform's signature** for a single-key collection like Nakas (the mint gate coin and the listing lock). Holding, sending, listing and taking an unsold piece back do not. A seller can always recover a listed piece alone after 1,008 blocks. Collections may instead name 2-of-3 co-signers in their rules.
4. **A site vault is only as private as the wallet signature that made it.** On the Ord Dropz site a vault key is derived from one wallet signature of a fixed message; any site that obtains the same signature can open that vault. The standalone wallet creates its key on the device instead.
5. **Some mining pools skip these transactions** (OP_RETURN above the old 83-byte limit). They confirm in the next block from a pool that accepts them. Raising the fee does nothing.
6. **The relayer is a convenience, not a trust point.** It can only publish an action as signed, delay it or drop it. Anyone can run one (`relayer/relayer.mjs`) or self-publish.

## Not yet built

- One indexer following several collections. Today one process follows one collection; the global registry already sees every collection.
- A published state checkpoint, so a new indexer on a small pruned node can start from a recent block instead of 969342.
- A running per-block digest, so two indexers that disagree can see the block where they parted.
- A rule for upgrading the rules: a version with an activation block, so every indexer switches at the same block.
- The relayer and co-signer on a plain node. They still need an esplora-style API for their own wallet coins.
- Bids and offers; shielding and unshielding of ordinary ordinals (protocol v2).

## Checking this page yourself

```
BITCOIN_RPC=… COLLECTION=shielded-nakas node indexer/indexer.mjs --compare https://<any other indexer>/status
node tools/names-indexer.mjs --compare https://<any other indexer>/names/info
npm test
```
