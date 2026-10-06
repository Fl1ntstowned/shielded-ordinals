# Shielded Ordinals: protocol v1

This is the reference for the code in `src/v1/`, `circuits/spend.circom` and `circuits/holder.circom`.
What is live, proven and still open is in `docs/STATUS.md`.

## Collection = rules
The collection's **parent inscription** holds the rules JSON, parsed by `rules.mjs` `parseRules`. The fields are:
- `supply`, and the art, in one of two modes:
  - **pre-inscribed:** `children`, the list of child inscription ids. A piece's `assetId` is its index.
  - **file mint:** `artRoot` + `contentType`. `artRoot` is a Merkle root over every piece's file (`art.mjs`: leaf = sha256(0x00 ‖ u32le assetId ‖ sha256(file)), node = sha256(0x01 ‖ L ‖ R), an odd last node is carried up). Nothing is inscribed up front: after a piece is minted the platform inscribes it as a true child of the parent (tag 3) in batches, and anyone can check a child is piece N by its content hash + Merkle path. `inscribeFee` (sats per piece) pays for that inscription.
- `mintPrice` and `artistPayoutScript`.
- `mintFee`, `saleFeeBps` + `saleFeeMin` (paid to the platform), and `platformPayoutScript`.
- `ticketPrice`.
- `relayerPayoutScript` (optional, default = platform). Ticket and inscribe fees are paid here, to the wallet that spends them, so the relayer/inscriber funds itself.
- `gateKey` and `lockKey`. These are platform x-only keys.

The indexer is pinned to one parent inscription id and reads the rules straight out of the parent's reveal tx (`inscribe.mjs` `rulesFromChain`); it needs no ord server. Every envelope carries `cid` = sha256(parent id)[0..8]; envelopes for other collections are ignored.

The art sats sit at NUMS. The parent is parked at NUMS after the last child is inscribed, so the rules and supply can never change.

## Notes
| | |
|---|---|
| note | `(assetId, tickets, ownerPk, rho, s)` |
| ownerPk | `Poseidon(sk)` |
| inner | `Poseidon(ownerPk, rho, s)` |
| commitment (leaf) | `cm = Poseidon(assetId, tickets, inner)` |
| nullifier | `nf = Poseidon(sk, rho, 7)` |
| private-send rho | `rhoOut = Poseidon(nf, 11)` (unique, so a sender can't collide notes) |
| piece secret `s` | conserved across private sends; replaced on every sale, mint or claim |
| holder claim id | `ctxNf = Poseidon(s, context, 13)` |

- Keys come from one 32-byte seed. The spend key is `sk`. The view key is an x25519 key; notes are encrypted to it with ChaCha20-Poly1305 (88 B ciphertext). The address is `shord1‖pk‖viewPk`.
- A listing's return key (BIP340) is derived from `seed + listing nf`, so a wallet restored from its seed can always reclaim.
- Notes the owner builds for themselves (mint, buy, claim) are **proof-less**. The owner publishes `inner` plus a ciphertext to their own view key, and the indexer computes `cm` from the public assetId and ticket count.

## Envelopes (one OP_RETURN each; several per tx are allowed)
| type | bytes | proof or auth | who pays the miner |
|---|---|---|---|
| MINT | 173 | none; the tx must spend a `P2TR(gateKey)` coin | buyer |
| MINTN | 16 + 158 per piece (1–20) | none; one `P2TR(gateKey)` coin for the whole batch | buyer |
| TRANSFER | 462 | Groth16 (`spend`, mode 0) | relayer (1 ticket) or the sender |
| LIST | 393 + seller script | Groth16 (`spend`, mode 1) | relayer (1 ticket) or the seller |
| BUY | 201 | none; the tx must spend the listing lock | buyer |
| CLAIM | 264 | BIP340 signature by the listing's return key | relayer (1 ticket) or the seller |

A **paid** envelope is a MINT, a MINTN, a BUY, or a TRANSFER/LIST with `buy > 0`. A tx may carry at most one. Its payments are checked against the tx outputs, summed per scriptPubKey:
- MINT: `mintPrice` → artist, `mintFee` → platform, and `inscribeFee + k·ticketPrice` → relayer payout.
- MINTN (batch of n): `n·mintPrice` → artist, `n·mintFee` → platform, and `n·inscribeFee + (all tickets)·ticketPrice` → relayer payout. A batch that names a piece twice or beyond supply is rejected whole. A piece that is already minted is skipped and the rest are minted (the buyer still gets every other piece they paid for); a batch of only minted pieces is rejected.
- BUY: `price` → seller script, `saleFee(price)` → platform, and `k·ticketPrice` → relayer payout. There are no royalties.
- Ticket top-up: `buy·ticketPrice` → relayer payout.
- Payments are summed per scriptPubKey, so artist, platform and relayer may all be the same address.

## Listing lock
A LIST tx must create the output `P2TR(internal = lockKey, leaf = "<1008> CSV DROP <returnKey> CHECKSIG")`.

- **BUY is valid only if its tx spends that exact outpoint.** Bitcoin consensus therefore makes each listing sell at most once.
- The platform co-signs the lock only for a tx that pays correctly.
- Spending the lock without a valid BUY **closes** the listing, which is how a cancel works. The seller then publishes CLAIM to get the piece back as a note.
- The leaf is the seller's escape hatch: after 1008 blocks the seller can spend the lock alone, and CLAIM in the same tx.
- **BUY has no anchor and no proof, so it can't expire in the mempool.** The platform's "kill switch" for a listing is simply spending the lock.

## The spend circuit (`Spend(20)`, 14.4k constraints, ~0.8–1.0 s to prove)
- **Public inputs:** `root, nf, hbody, cmOut, spend, buy, mode, assetIdPub, ticketsPub`.
- **What it proves:**
  - The input note is in the tree under `root`, owned by `sk`, and `nf` is its nullifier.
  - `ticketsOut = tickets − spend + buy` is ≥ 0 (32-bit range check).
  - mode 0: `cmOut` holds the same assetId and `s` for `pkOut`, with `rhoOut = Poseidon(nf, 11)`.
  - mode 1: the piece and its ticket count go public (`assetIdPub`, `ticketsPub`), and `cmOut = 0`.
- **hbody** binds the rest of the body: the ciphertext, the price, the seller script and the return key.

## Holder proof (`Holder(20)`, off-chain, v2)
- **Public inputs:** `root, context, ctxNf`. The note's nullifier stays private.
- The verifier checks three things:
  - the root is from the last `HOLDER_ROOT_WINDOW` = 6 blocks (freshness replaces the old "nf unspent" check)
  - `ctxNf` hasn't been used in this context before
  - the Groth16 proof is valid
- `context` = hash(cid, purpose, claimant id), so a copied proof is useless to anyone else.
- Why v2: v1 published `nf`, so the verifier could watch for it on-chain and, if the piece was later listed (a LIST shows the piece), learn which piece the claimant held.
- Remaining edge: a seller who sold within the last 6 blocks could still prove with the old note (the buyer has a new `s`, so both could claim once). Acceptable for roles/whitelists.

## Indexer order within a tx
1. Collect the ACTIVE listings whose lock this tx spends.
2. Apply the envelopes in output order.
3. Any spent lock whose listing is still ACTIVE is set to CLOSED.

Roots are recorded per block. TRANSFER and LIST anchors must fall within `[H−100, H−1]`.

## Self-publish, relay batches, private payouts
- **Self-publish:** any TRANSFER / LIST / CLAIM with `spend = 0` can be put in a tx the user pays for (any wallet that can add an OP_RETURN). `buy = k` in the same envelope buys k relay credits: the tx must pay `k·ticketPrice` to the relayer payout. Trade-off: the paying wallet is visible on that tx.
- **Relay batches:** the relayer queues relayed envelopes and publishes all of them in ONE tx, in random order, at a random moment in each window (default 10 min mainnet). The protocol always allowed several envelopes per tx; signet relays multi-OP_RETURN txs (tested).
- **Private payout:** a listing's seller script can be a fresh P2TR key derived from the vault seed and the listing nullifier. The vault finds its sales by rescanning, and withdraws by building + signing the tx in the browser; nothing on a server.

## Co-signers (optional, `rules.cosigners`)
- `{ keys: [A, B, C], threshold: 2 }` replaces `gateKey` / `lockKey`. Gate coin = P2TR(NUMS, leaf `<A> CHECKSIG <B> CHECKSIGADD <C> CHECKSIGADD <2> NUMEQUAL`). Lock = P2TR(NUMS, [seller escape leaf, the same 2-of-3 leaf]).
- Each co-signer runs its own indexer and signs only (`cosign.mjs`): a gate coin in a tx carrying one valid, fully unminted MINT/MINTN whose pieces it hasn't co-signed in another pending tx; a lock in a tx carrying a valid BUY or the seller's signed CLAIM. Any two quorums share a member, so a piece can't be co-signed into two pending mints.
- Co-signers never hold anything. A colluding quorum can only refuse (liveness) or co-sign a cancel the seller already signed. The seller's escape leaf still works alone after 1008 blocks.
- Software anyone runs: `cosigner/cosigner.mjs` (one key, own indexer, `POST /cosign`).

## Trusted setup pin (`rules.spendVkeyHash`)
- sha256 of the ceremony's spend verification key (canonical JSON). The indexer refuses to start with any other key, so the parent inscription pins the ceremony forever.
- Ceremony tool: `ceremony/ceremony.mjs` (init, contribute, verify, Bitcoin-block beacon, public transcript page).

## Running without Ord Dropz
| Job | Who can do it | How |
|---|---|---|
| Know who owns what (state) | anyone | run the indexer (`indexer/indexer.mjs`, see `docs/RUN-AN-INDEXER.md`) against your own Bitcoin node; two indexers reach the same digest |
| See and use your vault | the holder | the vault key never leaves the holder's device; the wallet scans every note locally |
| Private send / list / claim | the holder | relay through ANY relayer (`relayer/relayer.mjs`), or self-publish from your wallet (spend 0) |
| Withdraw sale proceeds | the seller | the payout key is the seller's own; sign + broadcast anywhere |
| Get an unsold piece back | the seller | seller escape leaf: after 1008 blocks spend the lock alone + CLAIM in the same tx |
| Mint, buy | buyers + co-signers | single-key collections need the platform gate/lock key. Co-signer collections need any 2 of 3 co-signers (e.g. Ord Dropz, UniSat, a third party) |
| Check the proof key | anyone | compare `vkeyHash(zk/spend_vkey.json)` with the parent's `spendVkeyHash`, or, for a collection whose parent carries none (Shielded Nakas), with the hash pinned in `src/v1/collections.mjs` |
| Check the whitelist | anyone | the phase list is published with its sha256; every mint tx is public |

## Still open
- The phase-2 trusted setup for the current circuit was one local contribution, and the Shielded Nakas parent carries no `spendVkeyHash` (its key is pinned in software, `src/v1/collections.mjs`). **Before the next collection: run the public multi-party ceremony (`ceremony/ceremony.mjs`) and pin `spendVkeyHash` in that parent.**
- There is no in-circuit check of the TRANSFER ciphertext. A sender who posts garbage only burns a piece they were giving away anyway; every paid flow uses notes the recipient builds.
- The nullifier is not bound to the note's position (audit item). Sender-recovery ciphertext is not implemented.
- Auction settlement (many winners in one tx) could reuse MINTN, but it pays one artist output per batch; decide in the auction step.
- There is one tree per collection (depth 20 = 1M notes).
