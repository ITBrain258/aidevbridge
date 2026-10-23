// Verdichtet ein Sampler-Log (roh oder mit redact.cjs bereinigt): Titelformen
// (Spinner zu <s>), Prozessbaum, Claude-Zeilen und sichtbare Rueckfragen.
// Usage: node ana.cjs <log>
const fs = require('fs');
const hex = (h) => Buffer.from(h || '', 'hex').toString('utf8').replace(/\n$/, '');
const shape = (t) => t.replace(/[\u2800-\u28ff]/g, '<s>');
let lastShape = null;
const tree = new Set();
const out = [];
for (const l of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  const [k, ts, ...rest] = l.split(' ');
  if (!k || !isFinite(+ts)) continue;
  const t = new Date(+ts * 1000).toISOString().slice(11, 23);
  if (k === 'T') {
    const s = shape(hex(rest[0]));
    if (s !== lastShape) out.push(`${t} T ${JSON.stringify(s)}`);
    lastShape = s;
  } else if (k === 'P') {
    const [lvl, , comm, exe] = rest;
    const key = `${lvl} ${comm} ${exe ?? ''}`;
    if (lvl !== '0' && !tree.has(key)) out.push(`${t} P ${key}`);
    tree.add(key);
  } else if (k === 'A') {
    const json = rest.join(' ').replace(/ background=\d+$/, '');
    let rows;
    try { rows = JSON.parse(json); } catch { out.push(`${t} A <kein JSON>`); continue; }
    const inter = rows
      .filter((r) => r.kind === 'interactive')
      .map((r) => `${r.pid}:${r.status}${r.waitingFor ? '/' + r.waitingFor : ''}`);
    out.push(`${t} A [${inter.join(' ')}]`);
  } else if (k === 'V') out.push(`${t} V ${rest.join(' ')}`);
}
console.log(out.join('\n'));
