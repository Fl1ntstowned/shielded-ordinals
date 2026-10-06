// Shielded Ordinals: multi-party trusted setup (Groth16 phase 2) for the spend and holder circuits.
//
// Why: a Groth16 key made by ONE party could let that party forge proofs. With a ceremony, the key is
// safe as long as ANY ONE contributor destroyed their randomness. Phase 1 is the public Perpetual
// Powers of Tau (build/pot14.ptau, many thousands of contributors). This tool runs phase 2.
//
//   node ceremony/ceremony.mjs init <spend|holder> [--dir ceremony/run]
//   node ceremony/ceremony.mjs contribute <circuit> --name "Alice" [--dir ...]   (anyone, on their own machine)
//   node ceremony/ceremony.mjs verify <circuit> [--dir ...]                      (anyone: checks the whole chain)
//   node ceremony/ceremony.mjs beacon <circuit> --height <block> [--dir ...]     (final: a Bitcoin block hash)
//   node ceremony/ceremony.mjs page <circuit> [--dir ...]                        (static public transcript page)
//
// A contributor's randomness comes from the OS (crypto.randomBytes) plus anything they type, is used
// once in memory and never written anywhere. The final step mixes in the hash of a Bitcoin block
// chosen BEFORE it was mined, so nobody (not even the last contributor) could steer the result.
// The final verification key's sha256 goes into the collection's parent inscription (rules
// `spendVkeyHash`), so the indexer only accepts proofs under the ceremony's key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILD = path.join(ROOT, 'build');
const CIRCUITS = ['spend', 'holder'];
const MEMPOOL = process.env.MEMPOOL_API ?? 'https://mempool.space/api';

const [cmd, circuit] = process.argv.slice(2);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
if (!CIRCUITS.includes(circuit)) usage();
const DIR = path.resolve(arg('--dir') ?? path.join(ROOT, 'ceremony', 'run'), circuit);
const R1CS = path.join(BUILD, `${circuit}.r1cs`);
const PTAU = path.join(BUILD, 'pot14.ptau');
const TRANSCRIPT = path.join(DIR, 'transcript.json');

function usage() {
  console.log('usage: ceremony.mjs <init|contribute|verify|beacon|page> <spend|holder> [--name N] [--height H] [--dir D]');
  process.exit(1);
}
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const loadT = () => JSON.parse(fs.readFileSync(TRANSCRIPT, 'utf8'));
const saveT = (t) => fs.writeFileSync(TRANSCRIPT, JSON.stringify(t, null, 2) + '\n');
const zkeyName = (n) => `${String(n).padStart(4, '0')}.zkey`;
const hex = (u8) => Buffer.from(u8).toString('hex');
// snarkjs logs each contribution hash as 4-byte groups over several lines; keep the log to parse it
const captureLogger = () => {
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  return { lines, logger: { info: log, debug: () => {}, warn: log, error: log, log } };
};

if (cmd === 'init') {
  if (fs.existsSync(TRANSCRIPT)) throw new Error(`${TRANSCRIPT} exists: this ceremony already started`);
  fs.mkdirSync(DIR, { recursive: true });
  await snarkjs.zKey.newZKey(R1CS, PTAU, path.join(DIR, zkeyName(0)));
  saveT({
    circuit, started: new Date().toISOString(),
    r1csSha256: sha256File(R1CS), ptau: 'ppot_0080_14.ptau (PSE Perpetual Powers of Tau)', ptauSha256: sha256File(PTAU),
    contributions: [], beacon: null, final: null,
  });
  console.log(`ceremony for ${circuit} started in ${DIR}\nnext: send ${zkeyName(0)} + transcript.json to the first contributor`);
} else if (cmd === 'contribute') {
  const t = loadT();
  if (t.beacon) throw new Error('this ceremony is finalised');
  const name = arg('--name');
  if (!name) throw new Error('--name is required (it is published in the transcript)');
  const n = t.contributions.length;
  const prev = path.join(DIR, zkeyName(n));
  if (!fs.existsSync(prev)) throw new Error(`missing ${prev}`);
  let typed = '';
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    typed = await rl.question('Type some random text (optional, adds to the OS randomness; never stored): ');
    rl.close();
  }
  // entropy lives only in memory for this call
  const entropy = crypto.createHash('sha512').update(crypto.randomBytes(64)).update(typed).update(String(process.hrtime.bigint())).digest('hex');
  const next = path.join(DIR, zkeyName(n + 1));
  const h = await snarkjs.zKey.contribute(prev, next, name, entropy);
  t.contributions.push({ n: n + 1, name, contributionHash: hex(h), zkey: zkeyName(n + 1), sha256: sha256File(next), at: new Date().toISOString() });
  saveT(t);
  console.log(`contribution #${n + 1} by ${name}\n  your contribution hash: ${hex(h)}\n  (save it: you can later check it appears in the final transcript)`);
  console.log(`next: send ${zkeyName(n + 1)} + transcript.json on, and delete nothing but your own terminal history`);
} else if (cmd === 'verify') {
  const t = loadT();
  const last = t.final ? path.join(DIR, 'final.zkey') : path.join(DIR, zkeyName(t.contributions.length));
  const { lines, logger } = captureLogger();
  const ok = await snarkjs.zKey.verifyFromR1cs(R1CS, PTAU, last, logger);
  if (sha256File(R1CS) !== t.r1csSha256) throw new Error('the circuit file does not match the transcript');
  const text = lines.join('\n').replace(/\s+/g, ' ');
  const missing = t.contributions.filter((c) => !text.includes(c.contributionHash.match(/.{8}/g).join(' ')));
  console.log(`${path.basename(last)}: ${ok ? 'VALID' : 'INVALID'} (${t.contributions.length} contributions${t.beacon ? ' + Bitcoin beacon' : ''})`);
  for (const c of t.contributions) console.log(`  #${c.n} ${c.name}: ${c.contributionHash.slice(0, 32)}… ${missing.includes(c) ? 'NOT IN KEY' : 'in key'}`);
  if (!ok || missing.length) process.exit(1);
} else if (cmd === 'beacon') {
  const t = loadT();
  if (t.beacon) throw new Error('already finalised');
  const height = Number(arg('--height'));
  if (!Number.isInteger(height) || height <= 0) throw new Error('--height <announced block> is required');
  const r = await fetch(`${MEMPOOL}/block-height/${height}`);
  if (!r.ok) throw new Error(`block ${height} is not mined yet (${r.status})`);
  const blockHash = (await r.text()).trim();
  const prev = path.join(DIR, zkeyName(t.contributions.length));
  const fin = path.join(DIR, 'final.zkey');
  await snarkjs.zKey.beacon(prev, fin, `Bitcoin block ${height}`, blockHash, 10);
  const vkey = await snarkjs.zKey.exportVerificationKey(fin);
  fs.writeFileSync(path.join(DIR, 'vkey.json'), JSON.stringify(vkey, null, 1));
  t.beacon = { height, blockHash, api: MEMPOOL, iterationsExp: 10 };
  t.final = { zkeySha256: sha256File(fin), vkeyHash: vkeyHash(vkey), finished: new Date().toISOString() };
  saveT(t);
  console.log(`finalised with Bitcoin block ${height} (${blockHash})\n  vkey hash (goes in the parent rules as ${circuit}VkeyHash): ${t.final.vkeyHash}`);
} else if (cmd === 'page') {
  const t = loadT();
  fs.writeFileSync(path.join(DIR, 'transcript.html'), page(t));
  console.log(`wrote ${path.join(DIR, 'transcript.html')}`);
} else usage();
process.exit(0);

// sha256 of the verification key's canonical JSON (same as rules.mjs vkeyHash)
function vkeyHash(vkey) {
  return crypto.createHash('sha256').update(JSON.stringify(vkey)).digest('hex');
}

function page(t) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = t.contributions.map((c) => `<tr><td>${c.n}</td><td>${esc(c.name)}</td><td><code>${c.contributionHash}</code></td><td>${c.at.slice(0, 16).replace('T', ' ')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shielded Ordinals ceremony</title><style>
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--fg:#eee;--mut:#999;--line:#222}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px 16px}
code{font-size:12px;word-break:break-all}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
.m{color:var(--mut)}pre{background:rgba(127,127,127,.12);padding:12px;overflow-x:auto;font-size:12px}
</style></head><body>
<h1>Trusted setup: ${esc(t.circuit)} circuit</h1>
<p class="m">Shielded Ordinals phase-2 ceremony. The key is safe if <b>any one</b> contributor below destroyed their randomness.</p>
<p>Phase 1: ${esc(t.ptau)} <br><code>sha256 ${t.ptauSha256}</code><br>Circuit: <code>sha256 ${t.r1csSha256}</code></p>
<h2>Contributions (${t.contributions.length})</h2>
<table><tr><th>#</th><th>Name</th><th>Contribution hash</th><th>Time (UTC)</th></tr>${rows}</table>
${t.beacon ? `<h2>Final beacon: Bitcoin block ${t.beacon.height}</h2><p>Announced before it was mined. Block hash <code>${t.beacon.blockHash}</code>, 2^${t.beacon.iterationsExp} iterations.</p>
<h2>Result</h2><p>Final key <code>sha256 ${t.final.zkeySha256}</code><br>Verification key hash (pinned in the collection's parent inscription) <code>${t.final.vkeyHash}</code></p>` : '<p><b>Not finalised yet.</b></p>'}
<h2>Check it yourself</h2>
<pre>git clone &lt;shielded-ordinals&gt; &amp;&amp; cd shielded-ordinals &amp;&amp; npm install
circom circuits/${esc(t.circuit)}.circom --r1cs -o build     # same circuit hash as above
node ceremony/ceremony.mjs verify ${esc(t.circuit)} --dir &lt;downloaded ceremony folder&gt;</pre>
<p class="m">Contributors: find your contribution hash in the table. If it's there and the check says VALID, your randomness is in the final key.</p>
</body></html>`;
}
