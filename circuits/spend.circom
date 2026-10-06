pragma circom 2.1.6;

include "./lib.circom";

// Shielded Ordinals v1 — spend one note.
//
// Note     = (assetId, tickets, ownerPk, rho, s)
// ownerPk  = Poseidon(sk)
// inner    = Poseidon(ownerPk, rho, s)         (what a recipient hands out; lets the indexer
//                                               build proof-less outputs for mint / buy / claim)
// cm       = Poseidon(assetId, tickets, inner)  (tree leaf)
// nf       = Poseidon(sk, rho, 7)               (only the owner can compute it)
// s        = the piece secret. Conserved across private transfers, so a holder proof
//            (holder.circom) can be one-per-piece per context without revealing the piece.
//
// mode 0 = private transfer: cmOut is a new note for pkOut with the SAME assetId and s,
//          rhoOut = Poseidon(nf, 11) (unique, so a sender can't collide it with another note).
// mode 1 = list: the piece leaves the shielded set into a public listing. assetId and the
//          ticket count become public; the sale terms are bound through hbody.
// Tickets: ticketsOut = ticketsIn - spend + buy. spend is 1 for relayed actions; buy is paid
// for in the carrier tx (checked by the indexer).

template Spend(depth) {
    // public
    signal input root;
    signal input nf;
    signal input hbody;
    signal input cmOut;
    signal input spend;
    signal input buy;
    signal input mode;
    signal input assetIdPub;
    signal input ticketsPub;

    // private
    signal input sk;
    signal input assetId;
    signal input tickets;
    signal input rho;
    signal input s;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input pkOut;

    spend * (1 - spend) === 0;
    mode * (1 - mode) === 0;
    component aBits = Num2Bits(32);
    aBits.in <== assetId;
    component bBits = Num2Bits(16);
    bBits.in <== buy;

    // input note is in the tree and owned by sk
    component pk = Poseidon(1);
    pk.inputs[0] <== sk;
    component innerIn = Poseidon(3);
    innerIn.inputs[0] <== pk.out;
    innerIn.inputs[1] <== rho;
    innerIn.inputs[2] <== s;
    component cmIn = Poseidon(3);
    cmIn.inputs[0] <== assetId;
    cmIn.inputs[1] <== tickets;
    cmIn.inputs[2] <== innerIn.out;

    component mr = MerkleRoot(depth);
    mr.leaf <== cmIn.out;
    for (var i = 0; i < depth; i++) {
        mr.pathElements[i] <== pathElements[i];
        mr.pathIndices[i] <== pathIndices[i];
    }
    mr.root === root;

    component nfh = Poseidon(3);
    nfh.inputs[0] <== sk;
    nfh.inputs[1] <== rho;
    nfh.inputs[2] <== 7;
    nfh.out === nf;

    // tickets can't go negative (a wrapped field element fails the 32-bit range check)
    signal ticketsOut;
    ticketsOut <== tickets - spend + buy;
    component tBits = Num2Bits(32);
    tBits.in <== ticketsOut;

    // mode 0: private output note
    component rhoOut = Poseidon(2);
    rhoOut.inputs[0] <== nf;
    rhoOut.inputs[1] <== 11;
    component innerOut = Poseidon(3);
    innerOut.inputs[0] <== pkOut;
    innerOut.inputs[1] <== rhoOut.out;
    innerOut.inputs[2] <== s;
    component cmo = Poseidon(3);
    cmo.inputs[0] <== assetId;
    cmo.inputs[1] <== ticketsOut;
    cmo.inputs[2] <== innerOut.out;

    (1 - mode) * (cmOut - cmo.out) === 0;
    (1 - mode) * assetIdPub === 0;
    (1 - mode) * ticketsPub === 0;

    // mode 1: public listing
    mode * cmOut === 0;
    mode * (assetIdPub - assetId) === 0;
    mode * (ticketsPub - ticketsOut) === 0;

    // bind the exact envelope body (ciphertext, sale terms, ...)
    signal hsq;
    hsq <== hbody * hbody;
}

component main {public [root, nf, hbody, cmOut, spend, buy, mode, assetIdPub, ticketsPub]} = Spend(20);
