import { Tool } from './types';
import { ArgError } from '../args';
import { guardResponse } from '../guard';
import { isDate, round2, todayInZone } from '../../utils/time';
import { Rec } from '../../tanda/client';

const PAY_CODE_RE = /pay.?code|earning.?code|pay.?item|export.?name|pay.?type|wage.?type/i;
const NUMERIC_TOTAL_RE = /hours|units|qty|quantity|amount|cost|total|gross/i;
const ID_RE = /employee.?(id|number|no|code)|payroll.?id|^id$/i;
const MAX_MISSING_SAMPLES = 25;

/** Tanda has no native isolved integration, so the format must be built in Tanda before this tool works. */
export const EXPORT_FORMAT_MISSING =
  'Payroll export preview is not set up. Tanda has no built-in isolved export, so first build one in Tanda: ' +
  'Settings > Integrations > + New Payroll Integration > "Build Your Own", with columns matching isolved\'s import template. ' +
  'Then set TANDA_EXPORT_FORMAT on the server to that format\'s exact name and redeploy.';

/** Minimal CSV/TSV parser with quoted-field support. */
export function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[$,\s]/g, ''));
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Normalise the export into header + row objects, whatever shape Tanda returned. */
export function toTable(raw: unknown): { columns: string[]; rows: Rec[]; headerless: boolean } {
  let data = raw;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { data = JSON.parse(trimmed); } catch { /* treat as text */ }
    }
  }
  if (Array.isArray(data)) {
    const rows = data.filter((r) => r && typeof r === 'object') as Rec[];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns, rows, headerless: false };
  }
  if (typeof data === 'string') {
    const table = parseDelimited(data);
    if (table.length === 0) return { columns: [], rows: [], headerless: false };
    const header = table[0];
    const headerless = header.every((h) => toNumber(h) !== null || h === '');
    const columns = headerless ? header.map((_, i) => `col_${i + 1}`) : header.map((h) => h.trim());
    const body = headerless ? table : table.slice(1);
    const rows = body.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])));
    return { columns, rows, headerless };
  }
  return { columns: [], rows: [], headerless: false };
}

export const exportPreviewTool: Tool = {
  name: 'tanda_export_preview',
  description:
    'Previews the payroll export for a pay period (approved timesheets only, never marks them exported): row count, column totals and rows missing a pay code; use it to check payroll before exporting. Never returns the raw file.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Any date in the pay period, YYYY-MM-DD. Default today' },
    },
  },
  async run(client, args) {
    const format = process.env.TANDA_EXPORT_FORMAT;
    if (!format) throw new ArgError(EXPORT_FORMAT_MISSING);
    const date = (args.date as string | undefined) || todayInZone();
    if (!isDate(date)) throw new ArgError('date must be YYYY-MM-DD.');

    const raw = await client.getTimesheetExport(date, format);
    const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.byteLength(JSON.stringify(raw ?? ''));
    const { columns, rows, headerless } = toTable(raw);

    const payCodeCol = columns.find((c) => PAY_CODE_RE.test(c)) ?? null;
    const idCol = columns.find((c) => ID_RE.test(c)) ?? null;
    const totals: Record<string, number> = {};
    for (const c of columns) {
      if (!NUMERIC_TOTAL_RE.test(c)) continue;
      const values = rows.map((r) => toNumber(r[c])).filter((n): n is number => n !== null);
      if (values.length) totals[c] = round2(values.reduce((a, b) => a + b, 0));
    }
    const missing = payCodeCol
      ? rows.map((r, i) => ({ r, i })).filter(({ r }) => String(r[payCodeCol] ?? '').trim() === '')
      : [];

    return guardResponse(
      {
        date,
        export_format: format,
        approved_only: true,
        skip_status_update: true,
        raw_bytes: rawBytes,
        row_count: rows.length,
        columns,
        ...(headerless ? { note: 'Export has no header row; columns are positional.' } : {}),
        totals,
        pay_code_column: payCodeCol,
        rows_missing_pay_code: payCodeCol ? missing.length : 'unknown (no pay-code column detected)',
      },
      // Rows missing pay codes: line number + identifying columns only
      missing.slice(0, MAX_MISSING_SAMPLES).map(({ r, i }) => ({
        line: i + 1,
        ...(idCol ? { [idCol]: r[idCol] } : {}),
        ...Object.fromEntries(Object.entries(r).filter(([k]) => NUMERIC_TOTAL_RE.test(k) || /date/i.test(k)).slice(0, 6)),
      }))
    );
  },
};
