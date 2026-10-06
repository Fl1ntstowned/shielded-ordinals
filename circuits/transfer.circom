pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Shielded Ordinals v0 — 1-in / 1-out NFT transfer.
//
// Note     = (assetId, ownerPk, rho)
// ownerPk  = Poseidon(sk)                  (spend key -> public owner key)
// cm       = Poseidon(assetId, ownerPk, rho) (note commitment = tree leaf)
// nf       = Poseidon(sk, rho, 7)           (nullifier; only the owner can compute it)
//
// Proves, without revealing which leaf or which piece:
//   1. the input note is a leaf under `root`
//   2. the prover knows its spend key
//   3. `nf` is that note's nullifier
//   4. `cmOut` commits the SAME assetId to the recipient (NFT conservation)
//   5. the proof is bound to the exact published envelope (`hbody`)

template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component h[depth];
    component mux[depth];
    signal cur[depth + 1];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== cur[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== cur[i];
        mux[i].s <== pathIndices[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== mux[i].out[0];
        h[i].inputs[1] <== mux[i].out[1];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

template Transfer(depth) {
    // public
    signal input root;
    signal input nf;
    signal input cmOut;
    signal input hbody;

    // private
    signal input sk;
    signal input assetId;
    signal input rhoIn;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input pkOut;
    signal input rhoOut;

    // assetId is a u32 piece index
    component aBits = Num2Bits(32);
    aBits.in <== assetId;

    component pk = Poseidon(1);
    pk.inputs[0] <== sk;

    component cmIn = Poseidon(3);
    cmIn.inputs[0] <== assetId;
    cmIn.inputs[1] <== pk.out;
    cmIn.inputs[2] <== rhoIn;

    component mr = MerkleRoot(depth);
    mr.leaf <== cmIn.out;
    for (var i = 0; i < depth; i++) {
        mr.pathElements[i] <== pathElements[i];
        mr.pathIndices[i] <== pathIndices[i];
    }
    mr.root === root;

    component nfh = Poseidon(3);
    nfh.inputs[0] <== sk;
    nfh.inputs[1] <== rhoIn;
    nfh.inputs[2] <== 7;
    nfh.out === nf;

    component cmo = Poseidon(3);
    cmo.inputs[0] <== assetId;
    cmo.inputs[1] <== pkOut;
    cmo.inputs[2] <== rhoOut;
    cmo.out === cmOut;

    // bind hbody into the constraint system
    signal hsq;
    hsq <== hbody * hbody;
}

component main {public [root, nf, cmOut, hbody]} = Transfer(16);
