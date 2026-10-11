// Does another indexer hold the same state? Both must be at the same block, so a block that lands
// between the two reads is settled by syncing again.
//   compare({ url, sync, status }) -> exit code: 0 agree, 1 disagree, 2 could not compare
//   url      another indexer's /status
//   sync()   brings this indexer to the tip
//   status() this indexer's /status answer for the same collection (throws when nothing is synced)
export async function compare({ url, sync, status, wait = 20_000 }) {
  for (let round = 0; round < 6; round++) {
    await sync();
    const mine = status();
    const r = await fetch(url);
    const theirs = await r.json().catch(() => null);
    if (!theirs?.digest || typeof theirs.lastHeight !== 'number') { console.log('that address did not answer with an indexer status'); return 2; }
    if (theirs.lastHeight !== mine.lastHeight) {
      console.log(`different heights (${mine.lastHeight} here, ${theirs.lastHeight} there): trying again`);
      await new Promise((ok) => setTimeout(ok, wait));
      continue;
    }
    console.log(`here   ${mine.lastHeight}  notes ${mine.notes}  ${mine.digest}`);
    console.log(`there  ${theirs.lastHeight}  notes ${theirs.notes}  ${theirs.digest}`);
    if (theirs.digest === mine.digest) { console.log('AGREE: the same state at the same block'); return 0; }
    console.log('DISAGREE: the two indexers hold different state at the same block');
    return 1;
  }
  console.log('the two indexers never stood at the same block; run it again');
  return 2;
}
