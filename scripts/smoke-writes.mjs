#!/usr/bin/env node
/**
 * Write smoke test (#97): exercises every write tool against a running server, as the shared
 * identity, and prints step names and statuses only (no names, emails or ids).
 *
 *   MCP_URL=https://<host>/mcp MCP_TOKEN=<MCP_SHARED_SECRET> node scripts/smoke-writes.mjs
 *
 * Optional: SMOKE_EMAIL (default zz.mcp.smoke@example.com), SMOKE_FROM / SMOKE_TO (old pay
 * period for the approval preview, default 2026-08-10..2026-08-23), SMOKE_REF (source_ref).
 *
 * The test hire is always left inactive, so it never counts towards the billed headcount. On
 * later runs it already exists (inactive), so the script reuses it instead of creating another:
 * it checks the duplicate is found, that updates to an inactive user are refused, and that it
 * stays inactive.
 * Exits non-zero on the first failed step. It is the staging gate before production.
 */
const url = process.env.MCP_URL || 'http://localhost:3000/mcp';
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error('Set MCP_TOKEN (the server\'s MCP_SHARED_SECRET).');
  process.exit(2);
}
const email = process.env.SMOKE_EMAIL || 'zz.mcp.smoke@example.com';
const name = 'ZZ MCP Smoke';
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
function check(label, ok, detail = '') {
  step++;
  console.log(`${String(step).padStart(2)}. ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    console.log('\nwrite smoke FAILED: do not promote to production.');
    process.exit(1);
  }
}
const statusOf = (r) => r.body.status ?? r.body.summary?.status;
const errorOf = (r) => String(r.body.error ?? r.body.summary?.error ?? '').slice(0, 160);
// On an error show Tanda's reason, not the numeric HTTP status that shares the "status" key
const detailOf = (r) => (r.isError ? errorOf(r) || 'error' : String(statusOf(r) ?? ''));
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
check('write tools are listed (TANDA_WRITES_ENABLED=true)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${writeTools.length} tools`);

// ADR 0001: the shared identity must name the decision it carries out
const noRef = await call('tanda_create_user', { name, email });
check('create without source_ref is refused under the shared token', noRef.isError && /source_ref/.test(noRef.text));

const hire = { name, email, source_ref: sourceRef };
const preview = await call('tanda_create_user', hire);
check('create preview', !preview.isError && ['preview', 'exists'].includes(statusOf(preview)) && noPii(preview), detailOf(preview));

let userId;
let active;
if (statusOf(preview) === 'preview') {
  const created = await call('tanda_create_user', { ...hire, confirm_token: preview.body.confirm_token });
  check('create confirm', !created.isError && created.body.status === 'created' && typeof created.body.user_id === 'number' && noPii(created), detailOf(created));
  userId = created.body.user_id;
  active = true;
  const again = await call('tanda_create_user', hire);
  check('duplicate create returns the same user', again.body.status === 'exists' && again.body.existing_user_id === userId, detailOf(again));
} else {
  // An earlier run's test hire: reuse it, never create a second one
  userId = preview.body.existing_user_id;
  active = preview.body.active !== false;
  check('existing test hire found (earlier run), nothing created', typeof userId === 'number', `matched_on=${preview.body.matched_on}, active=${active}`);
}

const upd = { user_id: userId, employment_start_date: period.from, source_ref: sourceRef };
const updPreview = await call('tanda_update_user', upd);
if (active && statusOf(updPreview) === 'unchanged') {
  // An active hire left by an interrupted run that already has this start date
  check('update preview (already up to date)', !updPreview.isError, detailOf(updPreview));
} else if (active) {
  const updToken = updPreview.body.summary?.confirm_token;
  check('update preview', !updPreview.isError && statusOf(updPreview) === 'preview' && Boolean(updToken), detailOf(updPreview));
  const updApply = await call('tanda_update_user', { ...upd, confirm_token: updToken });
  check('update confirm', !updApply.isError && statusOf(updApply) === 'applied' && updApply.body.summary?.succeeded === 1, detailOf(updApply));
} else {
  const sum = updPreview.body.summary || {};
  check('update of an inactive user is refused (rehire first), nothing changed', !updPreview.isError && sum.status === 'nothing_to_change' && sum.refused === 1 && !sum.confirm_token && /inactive/.test(updPreview.text),
    detailOf(updPreview));
}

const deact = { user_id: userId, source_ref: sourceRef };
const dPreview = await call('tanda_deactivate_user', deact);
if (dPreview.body.status === 'preview') {
  const dApply = await call('tanda_deactivate_user', { ...deact, confirm_token: dPreview.body.confirm_token });
  check('deactivate confirm', !dApply.isError && dApply.body.status === 'deactivated', detailOf(dApply));
} else {
  check('deactivate preview', dPreview.body.status === 'already_inactive', detailOf(dPreview));
}
const dAgain = await call('tanda_deactivate_user', deact);
check('test hire is inactive (not billed)', dAgain.body.status === 'already_inactive', detailOf(dAgain));

const approve = { ...period, allow_past_period: true, source_ref: sourceRef };
const aPreview = await call('tanda_approve_timesheets', approve);
const s = aPreview.body.summary || {};
check('approval preview on an old period', !aPreview.isError && ['preview', 'nothing_to_do'].includes(s.status) && noPii(aPreview),
  `${s.status ?? errorOf(aPreview)}: ${s.timesheets ?? '?'} timesheets, ${s.will_change ?? '?'} would change, ${s.flagged ?? '?'} flagged`);
check('approval preview gives the shared token no confirm_token', aPreview.body.confirm_token === undefined);
const aApply = await call('tanda_approve_timesheets', { ...approve, confirm_token: '1.smoke' });
check('approval apply is refused under the shared token (ADR 0001)', aApply.isError && /own Tanda login/.test(aApply.text));

console.log('\nall write steps OK');
