# State of the protocol

Last checked 2026-10-11 (UTC), at block 970880. Everything here was tested or read from Bitcoin then; nothing is assumed.

## Live on mainnet

| | |
|---|---|
| Protocol | SHORD v1, as written in [PROTOCOL-v1.md](../PROTOCOL-v1.md) |
| First collection | Shielded Nakas, 3,333 pieces, global numbers #0 to #3332. Parent inscription `896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0`, block 969343 |
| Minted | 3,327 of 3,333 pieces (block 970880) |
| Activity at block 970880 | 7,091 notes. 203 active listings, 2,018 sales, 1,401 pieces taken back |
| Child inscriptions | 3,327 pieces have their child inscription on chain, found by the piece index (`/pieces/info`, block 970880) |
| Names | Live since block 969800 (for example `obi.naka`), 177 names at block 970880 |
| Indexer start block | 969342 for the collection and for global numbering |

## Proven

- **Independent indexers agree.** On 2026-10-11 the indexer in this repository, at release-2, replayed Shielded Nakas from block 969342 on its own and reached the same state digest as the Ord Dropz server at block 970879 (7,090 notes, `39187930…7f46`). Earlier releases agreed at blocks 970089 and 970094 (2026-10-05). That includes mint day, every proof, every sale and every cancel.
- **Replays are repeatable.** A replay from a local block cache reproduces the published digest at block 970084 (`25099c61…2f69`, 5,033 notes) and at 970121 (`0a827955…c971`).
- **The rules are deterministic.** No clocks, no randomness and no server data take part in accepting or rejecting a transaction. The node-source test (`npm run test:node`) replays a signet collection through two different block sources to the identical state.
- **Reading from a plain Bitcoin node** reaches the same state as reading from an HTTP API (`npm run test:node`, signet, 8 checks). This used a stand-in node that answers the same four RPC calls with real block data. A run against a real `bitcoind` has not been recorded yet.
- **The verification keys in `zk/`** are byte for byte the ones the live site checks against.
- **Private names.** A name bought through the wallet was inscribed by the relayer from an unrelated coin, with no on-chain link to the buyer's payment (mainnet, `dub.naka`).

What `digest` covers: the tree root, the note count, the spent tags, the minted pieces, and each listing's state, piece, credits and price. It does not cover note txids, heights or kinds, or listing locks, seller scripts, return keys and sale or claim txids (see [API.md](API.md), "Checking `digest` yourself"). Two indexers that agree on `digest` agree on who can spend what; they could still differ on those other fields.

## What changed in this release (release-2)

- **Compression works.** The hosted API never compressed: the gzip check in the code held two literal backspace bytes where `\b` was meant, so no request ever matched. Answers are now sent brotli or gzip, whichever the client accepts, with `content-length` (at block 970879: `/state` 5.54 MB plain, 1.96 MB br; `/listings` 51 KB plain, 10 KB br). A test now refuses any control byte in the source and the docs.
- **ETags name the block's hash**, so a block replaced at the same height never gets a stale `304`. `If-None-Match` takes weak tags, lists and `*`.
- **Fair billing.** `/state?since=` must be a whole number (`400`, not counted, otherwise) and costs 5 plus 1 for every 500 notes it returns, at most 20, so `since=1` no longer buys almost the whole state at a poll's price. A call that costs more than a caller's whole allowance gets `403` with its cost and the limit, not a `429` that can never pass. Every counted answer says its cost in `x-cost`.
- **One indexer follows every shielded collection** it finds on Bitcoin: `/collections` and `/c/<cid>/…`.
- **Restarts take seconds.** Each collection's state is saved in a sealed checkpoint and checked before it is used; a restart at block 970880 answered `/status` within 18 s. A full replay from a local block cache takes 2 to 3.5 minutes (the note tree now recomputes only what each block adds). Block hashes are kept in a linked index, so a restart asks the chain source about 2 questions.
- **Blocks are checked** for their proof of work and their link to the block before (on mainnet, also a minimum difficulty), so a chain API can no longer hand over made-up blocks.
- **A reorganisation never takes the API down.** The state is rebuilt from a checkpoint next to the one being served, and swapped at the tip.
- **`/collection` shows the rules exactly as inscribed**, the payout scripts included.
- **Names:** the whole list (`/names?after=`), checkable against the running digest; `/names/info` needs no key; bad names and addresses get `400`; `/names/<name>` adds `to`.
- **Child inscriptions from the chain.** The piece index maps each Shielded Nakas piece to its child inscription by reading the transactions that spend the parent, with no ordinals.com and no operator files. `/listings` now gives `inscriptionId` for every Shielded Nakas listing whose piece has a child, and `/pieces` serves the map, traits and the art check.
- **Docs** now say what `digest` covers and what an indexer takes on trust from where it reads blocks.

## What the protocol relies on

Stated plainly, because anyone running an indexer should know them.

1. **The proof setup was a single contribution.** The Groth16 keys for the spend circuit were produced in one local run. The secret from that run is discarded by the software, but nobody outside can verify that it was. Someone who held it could forge a proof and create a duplicate of a piece (never take one out of a vault). A forgery would show in `/state` as the same piece listed or sold twice over. Before the next collection launches, a public multi-party setup (`ceremony/ceremony.mjs`) is planned, with its key hash written into that collection's parent.
2. **The Shielded Nakas parent does not carry `spendVkeyHash`.** Its verification key is pinned in `src/v1/collections.mjs` instead. Every indexer built from this repository checks the same key; a parent inscribed with the hash would make that check independent of the software.
3. **Mint and buy need the platform's signature** for a single-key collection like Nakas (the mint gate coin and the listing lock). Holding, sending, listing and taking an unsold piece back do not. A seller can always recover a listed piece alone after 1,008 blocks. Collections may instead name 2-of-3 co-signers in their rules.
4. **A site vault is only as private as the wallet signature that made it.** On the Ord Dropz site a vault key is derived from one wallet signature of a fixed message; any site that obtains the same signature can open that vault. The standalone wallet creates its key on the device instead.
5. **Some mining pools skip these transactions** (OP_RETURN above the old 83-byte limit). They confirm in the next block from a pool that accepts them. Raising the fee does nothing.
6. **The relayer is a convenience, not a trust point.** It can only publish an action as signed, delay it or drop it. Anyone can run one (`relayer/relayer.mjs`) or self-publish.
7. **An indexer that reads from an HTTP chain API instead of a node** trusts it to name the best chain (the blocks must still carry their proof of work and link up) and for the coins a mint spends. One reading from its own node trusts only the node.

## Not yet built

- A digest over everything `/state` serves (the current `digest` covers a summary, see above).
- A running per-block digest, so two indexers that disagree can see the block where they parted.
- A smaller poll than `/state?since=`: only what changed since a block.
- A published checkpoint that a new indexer on a small pruned node can start from. Checkpoints today are local: each indexer writes, checks and loads only its own.
- Shielded runes: rune collections are not followed by this release.
- A rule for upgrading the rules: a version with an activation block, so every indexer switches at the same block.
- The relayer and co-signer on a plain node. They still need an esplora-style API for their own wallet coins.
- Bids and offers; shielding and unshielding of ordinary ordinals (protocol v2).

## Checking this page yourself

```
COLLECTION=shielded-nakas node indexer/indexer.mjs --compare https://shielded-public-api-production.up.railway.app/status
node tools/names-indexer.mjs --compare https://shielded-public-api-production.up.railway.app/names/info
npm test
```
