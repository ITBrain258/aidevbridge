// Bereinigt ein Sampler-Log fuers Repository: Hostnamen und Home ersetzt,
// Claude-Zeilen nur mit pid/kind/status/waitingFor, Bildschirme nur als
// Marke "V <ts> prompt", wenn eine Rueckfrage sichtbar wurde.
// Usage: node redact.cjs <log> <hostname> > <ausgabe>
const fs = require('fs');
const [, , file, host] = process.argv;
const hex = (h) => Buffer.from(h || '', 'hex').toString('utf8');
const toHex = (s) => Buffer.from(s, 'utf8').toString('hex');
const clean = (s) => s.split(host).join('<host>').replace(/\/home\/[^/\s]+/g, '~');
let prompt = false;
const out = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const [k, ts, ...rest] = line.split(' ');
  if (!k || !isFinite(+ts)) continue;
  if (k === 'T') out.push(`T ${ts} ${toHex(clean(hex(rest[0])))}`);
  else if (k === 'P') out.push(clean(line));
  else if (k === 'E') out.push(line);
  else if (k === 'A') {
    let rows;
    try { rows = JSON.parse(rest.join(' ')); } catch { out.push(`A ${ts} <kein JSON>`); continue; }
    const keep = rows
      .filter((r) => r.kind === 'interactive')
      .map((r) => ({ pid: r.pid, kind: r.kind, status: r.status, waitingFor: r.waitingFor }));
    out.push(`A ${ts} ${JSON.stringify(keep)} background=${rows.length - keep.length}`);
  } else if (k === 'S') {
    const on = /Do you want to proceed|Would you like to run|Rot oder blau|Red or blue/.test(hex(rest[0]));
    if (on && !prompt) out.push(`V ${ts} prompt`);
    prompt = on;
  }
}
process.stdout.write(out.join('\n') + '\n');
