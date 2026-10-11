// Known collections: everything an indexer needs to follow one from Bitcoin alone.
//
//   rulesInscriptionId   the collection's parent inscription (its content is the rules)
//   rulesBlock           hash of the block holding the parent's reveal tx (lets a node without
//                        txindex hand over that one transaction)
//   startHeight          the block replay starts at. Every indexer must use the same one. It is at or
//                        before the parent's block, so nothing for this collection can come earlier.
//   spendVkeyHash        sha256 of the spend verification key (rules.mjs vkeyHash). Rules that carry
//                        their own `spendVkeyHash` pin it in the parent; for a parent inscribed
//                        without one, this entry is the pin: an indexer started with this entry
//                        refuses any other key.
//   pieces.pinned        (file-mint collections) children the piece index (pieces.mjs) cannot place
//                        from their metadata: { "<child id>": { piece, sha256, proof } }. A pin
//                        counts only when `proof` (the Merkle path, art.mjs) proves that `sha256` is
//                        that piece's file under the parent's artRoot, and the child's content has
//                        that sha256. Metadata only; never a path that would reveal unminted art.
export const COLLECTIONS = {
  mainnet: {
    'shielded-nakas': {
      rulesInscriptionId: '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0',
      rulesBlock: '000000000000000000005d228e7a98f4b853e1124e7a9db6f33681e6911f7fe8',
      startHeight: 969342,
      spendVkeyHash: 'e7dbcdb075dd5cbef3017d7146a6a6099fd477f5e989f357e14accb92313e788',
      pieces: {
        pinned: {
          // piece #0 was inscribed without a "shielded" block; its path to artRoot proves it
          '647652c78ba433efed478ff657746a378af7999789aa0d2c058024671205e81di0': {
            piece: 0,
            sha256: '265d7f9bfb9e35cdda9c3b9e1d7144468faca529be56015d4a0324e436099a73',
            proof: [
              'c4b5c2d4a2ef10376bf541ac7d5334e6879b44782e0748468b32451dca039d0e',
              'beeaa447d2cb51c0d4597431280a35cb4cbe89144722fc2b3b51682e8ca41006',
              '3c51d0da80e8c56634bbb629c19f49c3833bcfed0240ed3284ac83f740a8fb8a',
              '5448ae36ad6470af07b995ef617ce97f7132c005cd02b5a1656c000354aa14df',
              'f34ff8462a6fde0fbd7e15b55bf38dc6be4ea4af2eddb2e337645af6c4e5d297',
              '8e8731c048b3c6ce12115ff9a75708f571dfade61834a1c1b8e3592c78e64a52',
              '22a5e206931176ac9055767e7de8346fd92402a7fac759f3cfe38da5850325d4',
              '8598626abfec80f0718370be7d29c0fd3130fdacc10d3644c1f99a15e9d7e980',
              'b472b3cb61b25ff23dea58a9c8bcc5560a2c1deb8b99f7c91c037d85da48a402',
              'c02fd760a11586aa5fbcdfb3980af77c398bb07ab4c89f962dac711fb2834eee',
              '47ae39adcd27c028b413f844b1b619da791611838f9392ffeaf03b838bf83d96',
              '13967de4b86248133f10d7fed0ee5c5810fe622b08d81745ea4756fba8033f90',
            ],
          },
        },
      },
    },
  },
  signet: {},
};

export const knownCollection = (network, name) => COLLECTIONS[network]?.[name] ?? null;
/** The piece pins of a collection by its parent inscription id ({} when it has none). */
export const piecePins = (network, rulesInscriptionId) => Object.values(COLLECTIONS[network] ?? {}).find((c) => c.rulesInscriptionId === rulesInscriptionId)?.pieces?.pinned ?? {};
