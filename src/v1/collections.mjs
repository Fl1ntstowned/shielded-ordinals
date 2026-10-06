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
export const COLLECTIONS = {
  mainnet: {
    'shielded-nakas': {
      rulesInscriptionId: '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0',
      rulesBlock: '000000000000000000005d228e7a98f4b853e1124e7a9db6f33681e6911f7fe8',
      startHeight: 969342,
      spendVkeyHash: 'e7dbcdb075dd5cbef3017d7146a6a6099fd477f5e989f357e14accb92313e788',
    },
  },
  signet: {},
};

export const knownCollection = (network, name) => COLLECTIONS[network]?.[name] ?? null;
