pragma circom 2.1.6;

include "./lib.circom";

// Shielded Ordinals v1 — holder proof (off-chain; Discord roles, whitelists).
//
// Proves "I own a note in this collection's tree under `root`" without saying which.
// v2 (private nullifier): the note's nullifier is NOT an output. v1 published it so the verifier
// could check the note was unspent, but that let the verifier watch for the nullifier on-chain and,
// if the piece was later listed (a LIST shows the piece), learn which piece the claimant held.
// Instead the verifier only accepts a very recent root (a few blocks), so a note spent long ago
// can't be used, and ctxNf stops the same piece claiming twice.
//   ctxNf  = Poseidon(s, context, 13): one claim per PIECE per context. s is the piece
//            secret, conserved across private transfers, so self-sending doesn't reset it.
//   context = hash chosen by the verifier (collection, purpose, epoch, claimant id). Putting
//            the claimant in it means a copied proof can't be used by anyone else.

template Holder(depth) {
    signal input root;
    signal input context;
    signal input ctxNf;

    signal input sk;
    signal input assetId;
    signal input tickets;
    signal input rho;
    signal input s;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component pk = Poseidon(1);
    pk.inputs[0] <== sk;
    component inner = Poseidon(3);
    inner.inputs[0] <== pk.out;
    inner.inputs[1] <== rho;
    inner.inputs[2] <== s;
    component cm = Poseidon(3);
    cm.inputs[0] <== assetId;
    cm.inputs[1] <== tickets;
    cm.inputs[2] <== inner.out;

    component mr = MerkleRoot(depth);
    mr.leaf <== cm.out;
    for (var i = 0; i < depth; i++) {
        mr.pathElements[i] <== pathElements[i];
        mr.pathIndices[i] <== pathIndices[i];
    }
    mr.root === root;

    component c = Poseidon(3);
    c.inputs[0] <== s;
    c.inputs[1] <== context;
    c.inputs[2] <== 13;
    c.out === ctxNf;
}

component main {public [root, context, ctxNf]} = Holder(20);
