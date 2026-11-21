import { Tool } from './types';
import { ArgError, Args, num, oneOf } from '../args';
import { guardResponse, GuardedResponse } from '../guard';
import { parsePayCalendar, periodContaining, previousPeriod } from '../payCalendar';
import { Warning, warningFor, withWarnings } from '../warnings';
import { exportPreviewTool } from './exportPreview';
import { dataAuditTool } from './dataAudit';
import { payPeriodsTool } from './payPeriods';
import { TandaApiError, TandaClient } from '../../tanda/client';
import { isDate, round2, todayInZone } from '../../utils/time';

export const PAYROLL_PREFLIGHT_TOOL = 'tanda_payroll_preflight';

/** Default swing in $ per day against the prior period that is flagged for review. */
export const DEFAULT_MAX_CHANGE_PCT = 25;

/** Audit checks that change what people are paid; the rest are housekeeping. */
const PAY_AFFECTING_AUDIT_CHECKS = new Set(['missing_award_template', 'zero_cost_sites']);

type Verdict = 'go' | 'review' | 'no_go' | 'incomplete';

interface Item {
  part: 'export' | 'audit' | 'totals' | 'period';
  check: string;
  level: 'blocker' | 'review';
  detail: string;
  count?: number;
}

interface PeriodTotals {
  start: string;
  finish: string;
  days: number;
  timesheets: number;
  hours: number;
  cost: number;
  cost_per_day: number;
  pending: number;
  unapproved_cost: number;
}

/**
 * Run one part. A part that can't run (export format not set, a missing scope, a Tanda error)
 * becomes a warning and null, so the other parts still report.
 */
async function part(warnings: Warning[], check: string, fn: () => Promise<unknown>): Promise<GuardedResponse | null> {
  try {
    return (await fn()) as GuardedResponse;
  } catch (error) {
    if (error instanceof ArgError) {
      warnings.push({ check, reason: error.message });
      return null;
    }
    const w = warningFor(check, error);
    if (w) warnings.push(w);
    else if (error instanceof TandaApiError) warnings.push({ check, reason: `Tanda returned HTTP ${error.statusCode}` });
    else throw error;
    return null;
  }
}

function periodTotals(row: Record<string, unknown>): PeriodTotals {
  const byStatus = (row.by_status || {}) as Record<string, { timesheets: number; hours: number; cost: number }>;
  const hours = round2(Object.values(byStatus).reduce((n, s) => n + (s.hours || 0), 0));
  const cost = (row.cost as number) || 0;
  const days = (row.days as number) || 1;
  return {
    start: row.start as string,
    finish: row.finish as string,
    days,
    timesheets: (row.timesheets as number) || 0,
    hours,
    cost,
    cost_per_day: round2(cost / days),
    pending: byStatus.pending?.timesheets || 0,
    unapproved_cost: (row.unapproved_cost as number) || 0,
  };
}

const pctChange = (now: number, before: number): number | null => (before > 0 ? round2(((now - before) / before) * 100) : null);

export const payrollPreflightTool: Tool = {
  name: PAYROLL_PREFLIGHT_TOOL,
  description:
    'One go / no-go check before payroll for a pay period: the payroll export preview, the data-quality audit, and totals against the prior period, with a verdict and the items to fix. Read-only: it never approves, exports or changes anything.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['current', 'previous'], description: 'Pay period from PAY_CALENDAR. Default current' },
      date: { type: 'string', description: 'Any date in the pay period, YYYY-MM-DD. Overrides period' },
      max_change_pct: { type: 'number', description: `Flag a $-per-day change against the prior period above this %. Default ${DEFAULT_MAX_CHANGE_PCT}` },
    },
  },
  async run(client: TandaClient, args: Args) {
    const today = todayInZone();
    const which = oneOf(args.period, ['current', 'previous'] as const, 'current', 'period');
    if (args.date !== undefined && args.date !== null && args.date !== '' && !isDate(args.date)) throw new ArgError('date must be YYYY-MM-DD.');
    const maxChange = num(args.max_change_pct, DEFAULT_MAX_CHANGE_PCT) as number;
    if (!(maxChange > 0)) throw new ArgError('max_change_pct must be a number above 0.');

    const { segments } = parsePayCalendar();
    let period = periodContaining((args.date as string | undefined) || today, segments);
    if (!args.date && which === 'previous') period = previousPeriod(period, segments);
    const date = period.start;
    const warnings: Warning[] = [];

    // Sequential, so the three parts share the rate-limit budget politely (about 16 Tanda reads)
    const exportRes = await part(warnings, 'export_preview', () => exportPreviewTool.run(client, { date }));
    const auditRes = await part(warnings, 'data_audit', () => dataAuditTool.run(client, {}));
    const periodsRes = await part(warnings, 'period_totals', () => payPeriodsTool.run(client, { date, prior_periods: 1 }));
    // Keep the parts' own warnings (a missing scope inside the audit, a calendar mismatch)
    for (const res of [auditRes, periodsRes]) for (const w of (res?.warnings as Warning[] | undefined) || []) warnings.push(w);

    const items: Item[] = [];
    if (period.finish >= today) {
      items.push({ part: 'period', check: 'period_open', level: 'review', detail: `The period runs to ${period.finish}; timesheets can still change.` });
    }

    // Export preview
    let exportSummary: Record<string, unknown> | null = null;
    if (exportRes) {
      const s = exportRes.summary;
      exportSummary = {
        export_format: s.export_format,
        row_count: s.row_count,
        totals: s.totals,
        rows_missing_pay_code: s.rows_missing_pay_code,
      };
      if (typeof s.rows_missing_pay_code === 'number' && s.rows_missing_pay_code > 0) {
        items.push({ part: 'export', check: 'rows_missing_pay_code', level: 'blocker', count: s.rows_missing_pay_code, detail: 'Export rows with no pay code; tanda_export_preview lists them.' });
      } else if (typeof s.rows_missing_pay_code !== 'number') {
        items.push({ part: 'export', check: 'pay_code_column', level: 'review', detail: 'No pay-code column found in the export, so missing pay codes could not be checked.' });
      }
      if (s.row_count === 0) {
        items.push({ part: 'export', check: 'empty_export', level: 'blocker', detail: 'The export has no rows: nothing in this period is approved yet.' });
      }
    }

    // Data audit
    let auditSummary: Record<string, number | null> | null = null;
    if (auditRes) {
      auditSummary = (auditRes.summary.by_check || {}) as Record<string, number | null>;
      for (const r of auditRes.rows as Array<{ check: string; description: string; count: number | null }>) {
        if (!r.count) continue;
        items.push({ part: 'audit', check: r.check, level: PAY_AFFECTING_AUDIT_CHECKS.has(r.check) ? 'blocker' : 'review', count: r.count, detail: r.description });
      }
    }

    // Period-over-period totals ($ per day, so a 14-day period compares fairly with a 7-day one)
    let totals: Record<string, unknown> | null = null;
    if (periodsRes) {
      const rows = periodsRes.rows as Array<Record<string, unknown>>;
      const cur = rows.find((r) => r.period === 'current');
      const prior = rows.find((r) => r.period === 'prior_1');
      if (cur) {
        const c = periodTotals(cur);
        const p = prior ? periodTotals(prior) : null;
        const change = p ? pctChange(c.cost_per_day, p.cost_per_day) : null;
        totals = {
          period: c,
          prior_period: p,
          change_pct: p ? { cost_per_day: change, hours: pctChange(c.hours / c.days, p.hours / p.days), timesheets: pctChange(c.timesheets, p.timesheets) } : null,
        };
        if (c.pending > 0) {
          items.push({ part: 'totals', check: 'pending_timesheets', level: 'blocker', count: c.pending, detail: `Timesheets still pending ($${c.unapproved_cost.toFixed(2)}); tanda_approval_queue shows which are clean.` });
        }
        if (change !== null && Math.abs(change) > maxChange) {
          items.push({ part: 'totals', check: 'cost_change', level: 'review', detail: `$ per day is ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on the prior period (limit ${maxChange}%).` });
        }
      }
    }

    const blockers = items.filter((i) => i.level === 'blocker').length;
    const skipped = [!exportRes && 'export', !auditRes && 'audit', !totals && 'totals'].filter(Boolean) as string[];
    const verdict: Verdict = blockers ? 'no_go' : skipped.length ? 'incomplete' : items.length ? 'review' : 'go';

    return guardResponse(
      {
        verdict,
        period: { start: period.start, finish: period.finish, days: period.days, cadence: period.cadence },
        blockers,
        review_items: items.length - blockers,
        ...(skipped.length ? { parts_skipped: skipped } : {}),
        export: exportSummary,
        audit: auditSummary,
        totals,
        note: 'Preflight only; nothing was approved, exported or changed in Tanda. A person decides and acts.',
      },
      items,
      { extra: withWarnings(warnings) }
    );
  },
};
