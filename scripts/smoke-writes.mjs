#!/usr/bin/env node
/**
 * Write smoke test (#97): exercises every write tool against a running server, as the shared
 * identity, and prints step names and statuses only (no names, emails or ids).
 *
 *   MCP_URL=https://<host>/mcp MCP_TOKEN=<MCP_SHARED_SECRET> node scripts/smoke-writes.mjs
 *
 * Optional: SMOKE_RUN_ID (default: a timestamp), SMOKE_FROM / SMOKE_TO (old pay period for the
 * approval preview, default 2026-08-10..2026-08-23), SMOKE_REF (source_ref).
 *
 * Each run creates its own test hire ("ZZ MCP Smoke <run id>", zz.mcp.smoke.<run id>@example.com)
 * so every release exercises create, duplicate, update and deactivate in full. Tanda refuses a
 * reused email even on an inactive user (#105). The hire is always left inactive, even when a
 * step fails, so it never counts towards the billed headcount.
 * Exits non-zero on the first failed step. It is the staging gate before production.
 */
const url = process.env.MCP_URL || 'http://localhost:3000/mcp';
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error('Set MCP_TOKEN (the server\'s MCP_SHARED_SECRET).');
  process.exit(2);
}
const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14); // e.g. 20261115154200
const runId = (process.env.SMOKE_RUN_ID || timestamp).toLowerCase().replace(/[^a-z0-9]/g, '');
const email = `zz.mcp.smoke.${runId}@example.com`;
const name = `ZZ MCP Smoke ${runId}`;
const sourceRef = process.env.SMOKE_REF || `smoke-writes ${new Date().toISOString().slice(0, 10)}`;
const period = { from: process.env.SMOKE_FROM || '2026-08-10', to: process.env.SMOKE_TO || '2026-08-23' };

let id = 0;
async function call(tool, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  if (res.status === 401) throw new Error('401 Unauthorized: check MCP_TOKEN');
  const out = await res.json();
  const text = out.result?.content?.[0]?.text ?? '{}';
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { isError: Boolean(out.error || out.result?.isError), body, text };
}

let step = 0;
let activeHireId = null; // set while the test hire is active, so a failure still deactivates it (#105)

/** Never leave the test hire active (billed), even when a later step fails. */
async function cleanup() {
  if (activeHireId === null) return;
  const args = { user_id: activeHireId, source_ref: `${sourceRef} cleanup` };
  const p = await call('tanda_deactivate_user', args);
  const done = p.body.status === 'already_inactive'
    || (p.body.status === 'preview' && (await call('tanda_deactivate_user', { ...args, confirm_token: p.body.confirm_token })).body.status === 'deactivated');
  console.log(done ? 'cleanup: test hire deactivated' : 'cleanup FAILED: deactivate the "ZZ MCP Smoke" user in Tanda by hand');
}

async function check(label, ok, detail = '') {
  step++;
  console.log(`${String(step).padStart(2)}. ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    await cleanup();
    console.log('\nwrite smoke FAILED: do not promote to production.');
    process.exit(1);
  }
}
const statusOf = (r) => r.body.status ?? r.body.summary?.status;
const errorOf = (r) => String(r.body.error ?? '').slice(0, 120);
const noPii = (r) => !/"(date_of_birth|passcode)"/.test(r.text);

const listed = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }),
}).then((r) => r.json());
const names = listed.result?.tools?.map((t) => t.name) || [];
const writeTools = ['tanda_create_user', 'tanda_update_user', 'tanda_deactivate_user', 'tanda_approve_timesheets'];
const missing = writeTools.filter((t) => !names.includes(t));
console.log(`server ${url}`);
await check('write tools are listed (TANDA_WRITES_ENABLED=true)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${writeTools.length} tools`);

// ADR 0001: the shared identity must name the decision it carries out
const noRef = await call('tanda_create_user', { name, email });
await check('create without source_ref is refused under the shared token', noRef.isError && /source_ref/.test(noRef.text));

// The start date lets the name + start-date duplicate check match even when Tanda doesn't return the email
const hire = { name, email, employment_start_date: '2026-01-05', source_ref: sourceRef };
const preview = await call('tanda_create_user', hire);
await check('create preview', !preview.isError && ['preview', 'exists'].includes(statusOf(preview)) && noPii(preview), statusOf(preview) || errorOf(preview));

let userId;
if (statusOf(preview) === 'preview') {
  const created = await call('tanda_create_user', { ...hire, confirm_token: preview.body.confirm_token });
  await check('create confirm', !created.isError && created.body.status === 'created' && typeof created.body.user_id === 'number' && noPii(created), created.body.status || errorOf(created));
  userId = created.body.user_id;
  if (typeof userId === 'number') activeHireId = userId;
  for (const w of created.body.warnings || []) console.log(`    WARN ${w.check}: ${w.reason}`);
  const again = await call('tanda_create_user', hire);
  await check('duplicate create returns the same user', again.body.status === 'exists' && again.body.existing_user_id === userId, again.body.status || errorOf(again));

  const upd = { user_id: userId, employment_start_date: period.from, source_ref: sourceRef };
  const updPreview = await call('tanda_update_user', upd);
  const updToken = updPreview.body.summary?.confirm_token;
  await check('update preview', !updPreview.isError && statusOf(updPreview) === 'preview' && Boolean(updToken), statusOf(updPreview) || errorOf(updPreview));
  const updApply = await call('tanda_update_user', { ...upd, confirm_token: updToken });
  await check('update confirm', !updApply.isError && statusOf(updApply) === 'applied' && updApply.body.summary?.succeeded === 1, statusOf(updApply) || errorOf(updApply));
} else {
  userId = preview.body.existing_user_id;
  if (preview.body.active) activeHireId = userId;
  await check('existing test hire found (earlier run)', typeof userId === 'number', `matched_on=${preview.body.matched_on}`);
}

const deact = { user_id: userId, source_ref: sourceRef };
const dPreview = await call('tanda_deactivate_user', deact);
if (dPreview.body.status === 'preview') {
  const dApply = await call('tanda_deactivate_user', { ...deact, confirm_token: dPreview.body.confirm_token });
  await check('deactivate confirm', !dApply.isError && dApply.body.status === 'deactivated', dApply.body.status || errorOf(dApply));
  if (dApply.body.status === 'deactivated') activeHireId = null;
} else {
  await check('deactivate preview', dPreview.body.status === 'already_inactive', dPreview.body.status || errorOf(dPreview));
}
const dAgain = await call('tanda_deactivate_user', deact);
await check('test hire is inactive (not billed)', dAgain.body.status === 'already_inactive', dAgain.body.status || errorOf(dAgain));

const approve = { ...period, allow_past_period: true, source_ref: sourceRef };
const aPreview = await call('tanda_approve_timesheets', approve);
const s = aPreview.body.summary || {};
await check('approval preview on an old period', !aPreview.isError && ['preview', 'nothing_to_do'].includes(s.status) && noPii(aPreview),
  `${s.status ?? errorOf(aPreview)}: ${s.timesheets ?? '?'} timesheets, ${s.will_change ?? '?'} would change, ${s.flagged ?? '?'} flagged`);
await check('approval preview gives the shared token no confirm_token', aPreview.body.confirm_token === undefined);
const aApply = await call('tanda_approve_timesheets', { ...approve, confirm_token: '1.smoke' });
await check('approval apply is refused under the shared token (ADR 0001)', aApply.isError && /own Tanda login/.test(aApply.text));

console.log('\nall write steps OK');
