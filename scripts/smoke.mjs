#!/usr/bin/env node
/**
 * Smoke test: calls all 12 v4 tools on a running server and prints shape + size only.
 * No row values are printed, so no PII reaches the terminal.
 *
 *   MCP_URL=https://<host>/mcp MCP_TOKEN=<MCP_SHARED_SECRET or OAuth JWT> node scripts/smoke.mjs [from] [to]
 *
 * Exits non-zero if any tool errors, exceeds 25 KB, or returns date_of_birth/passcode.
 */
const url = process.env.MCP_URL || 'http://localhost:3000/mcp';
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error('Set MCP_TOKEN (MCP_SHARED_SECRET or an OAuth JWT).');
  process.exit(2);
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const from = process.argv[2] || addDays(today, -6);
const to = process.argv[3] || today;
const range = { from, to };
const LIMIT = 25 * 1024;

let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (res.status === 401) throw new Error('401 Unauthorized: check MCP_TOKEN');
  return res.json();
}

const calls = [
  ['tanda_org', {}],
  ['tanda_people', {}],
  ['tanda_schedules', { ...range, show_costs: true }],
  ['tanda_timesheets', range],
  ['tanda_live', {}],
  ['tanda_time_off', range],
  ['tanda_labor_summary', range],
  ['tanda_coverage', range],
  ['tanda_validate_schedule', null], // filled from tanda_people
  ['tanda_exceptions', range],
  ['tanda_export_preview', { date: to }],
  ['tanda_change_history', null], // filled from tanda_timesheets
];

const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) || [];
console.log(`server ${url}  range ${from}..${to}  tools listed: ${listed.length}`);

let firstUserId = null;
let firstShiftId = null;
let failures = 0;
for (const [name, preset] of calls) {
  let args = preset;
  if (name === 'tanda_validate_schedule') {
    args = { shifts: [{ user_id: firstUserId ?? 1, start: `${to} 09:00`, finish: `${to} 17:00` }] };
  }
  if (name === 'tanda_change_history') {
    if (!firstShiftId) { console.log(`${name.padEnd(24)} SKIP  (no shift id found)`); continue; }
    args = { type: 'shift', id: firstShiftId };
  }
  const t0 = Date.now();
  const out = await rpc('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const text = out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? {});
  const bytes = Buffer.byteLength(text);
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }

  const isError = Boolean(out.error || out.result?.isError);
  const pii = /"(date_of_birth|passcode)"/.test(text);
  const ok = !isError && bytes <= LIMIT && !pii;
  if (!ok) failures++;

  if (name === 'tanda_people') firstUserId = body.rows?.[0]?.id ?? null;
  if (name === 'tanda_timesheets') {
    const sheets = await rpc('tools/call', { name, arguments: { ...range, view: 'shifts', limit: 1 } });
    try { firstShiftId = JSON.parse(sheets.result.content[0].text).rows?.[0]?.id ?? null; } catch { /* ignore */ }
  }

  const shape = isError
    ? `error: ${String(body.error ?? out.error?.message ?? '').slice(0, 80)}`
    : [
        body.summary ? `summary{${Object.keys(body.summary).slice(0, 8).join(',')}${Object.keys(body.summary).length > 8 ? ',…' : ''}}` : `keys{${Object.keys(body).join(',')}}`,
        Array.isArray(body.rows) ? `rows=${body.rows.length}/${body.page?.total_rows ?? '?'}` : '',
        body.rows?.[0] ? `row{${Object.keys(body.rows[0]).length} fields}` : '',
        body.truncated ? 'truncated' : '',
      ].filter(Boolean).join(' ');
  console.log(`${name.padEnd(24)} ${ok ? 'OK  ' : 'FAIL'} ${String(bytes).padStart(6)}B ${String(ms).padStart(5)}ms  ${shape}${pii ? '  PII!' : ''}`);
}
console.log(failures ? `\n${failures} tool(s) failed` : '\nall tools OK (< 25 KB, no DOB/passcode)');
process.exit(failures ? 1 : 0);
