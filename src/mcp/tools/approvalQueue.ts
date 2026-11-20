import { Tool } from './types';
import { ArgError, dateRange, idList, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { APPROVE_TIMESHEETS_TOOL, MAX_BATCH, planShifts, WEEKLY_LIMIT } from './approveTimesheets';
import { parsePayCalendar, periodContaining, previousPeriod } from '../payCalendar';
import { workweek } from '../workweek';
import { soft, Warning, withWarnings } from '../warnings';
import { Rec } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { round2, todayInZone, toUnixSeconds, toZonedISO } from '../../utils/time';

export const APPROVAL_QUEUE_TOOL = 'tanda_approval_queue';

type Kind = 'regular' | 'overtime' | 'holiday' | 'leave' | 'night' | 'evening' | 'weekend' | 'other';

/** Matched in order against the pay code's export name; the first hit wins. */
const KINDS: Array<[Kind, RegExp, string]> = [
  ['overtime', /\b(ot|o\/t|overtime|double|dt)\b|time and a half|1\.5x?|2\.0x?/i, 'Overtime: Tanda paid these hours at a higher rate'],
  ['holiday', /holiday|\bph\b/i, 'Holiday: worked on, or paid for, a holiday'],
  ['leave', /leave|\bpto\b|sick|vacation|\bvac\b|annual|bereave/i, 'Leave: paid time off taken in this period'],
  ['night', /night|graveyard|\bnt\b/i, 'Night rate: hours inside the award\'s night window'],
  ['evening', /\beve(ning)?\b/i, 'Evening rate: hours inside the award\'s evening window'],
  ['weekend', /\b(sat(urday)?|sun(day)?|weekend|wknd)\b/i, 'Weekend rate: hours worked on a weekend day'],
  ['regular', /\b(ord(inary)?|reg(ular)?|base|standard|normal|straight)\b/i, 'Regular hours at the base rate'],
];
const OTHER = 'Set by the award template in Workforce; check the rule there if it looks wrong';

interface CodeTotals { hours: number; cost: number; dates: Set<string>; from: number | null; to: number | null }

const hhmm = (secs: number | null) => (secs === null ? null : (toZonedISO(secs) as string).slice(11, 16));
const timeOfDay = (secs: number) => hhmm(secs) as string;

export function payCodeKind(name: string): Kind {
  return KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other';
}

/**
 * Pay codes on one timesheet, each with a plain reason. Tanda's award lines carry only the
 * code, hours, cost and time window, so the reason comes from the code's name plus those facts.
 */
export function explainPayCodes(shifts: Rec[], weeksOver: string[]): Rec[] {
  const codes = new Map<string, CodeTotals>();
  for (const s of shifts) {
    const lines = Array.isArray(s.award_interpretation) ? (s.award_interpretation as Rec[]) : [];
    for (const l of lines) {
      const name = String(l.export_name || l.name || l.tag || 'unknown');
      const c = codes.get(name) || { hours: 0, cost: 0, dates: new Set<string>(), from: null, to: null };
      c.hours += typeof l.units === 'number' ? l.units : typeof l.ordinary_hours === 'number' ? l.ordinary_hours : 0;
      c.cost += typeof l.cost === 'number' ? l.cost : 0;
      const d = typeof l.date === 'string' ? l.date : itemDate(s);
      if (d) c.dates.add(d);
      const from = toUnixSeconds(l.from);
      const to = toUnixSeconds(l.to);
      // Earliest and latest time of day across the days this code applied
      if (from !== null && (c.from === null || timeOfDay(from) < timeOfDay(c.from))) c.from = from;
      if (to !== null && (c.to === null || timeOfDay(to) > timeOfDay(c.to))) c.to = to;
      codes.set(name, c);
    }
  }
  const perHour = (c: CodeTotals) => (c.hours > 0 && c.cost > 0 ? c.cost / c.hours : null);
  const regular = [...codes.entries()].find(([n]) => payCodeKind(n) === 'regular')?.[1];
  const base = regular ? perHour(regular) : null;

  return [...codes.entries()]
    .map(([name, c]) => {
      const kind = payCodeKind(name);
      const facts: string[] = [];
      const days = c.dates.size;
      if (c.from !== null && c.to !== null && kind !== 'regular') facts.push(`between ${hhmm(c.from)} and ${hhmm(c.to)}`);
      if (days) facts.push(`on ${days} day${days === 1 ? '' : 's'}`);
      if (kind === 'overtime') {
        facts.push(weeksOver.length
          ? `workweek of ${weeksOver.join(', ')} went over ${WEEKLY_LIMIT}h`
          : `no workweek here went over ${WEEKLY_LIMIT}h, so check the rule that applied it`);
      }
      const rate = perHour(c);
      const multiple = base && rate && kind !== 'regular' ? round2(rate / base) : null;
      if (multiple && multiple !== 1) facts.push(`paid at ${multiple}x the regular rate`);
      const lead = KINDS.find(([k]) => k === kind)?.[2] ?? OTHER;
      return {
        pay_code: name,
        kind,
        hours: round2(c.hours),
        cost: round2(c.cost),
        why: facts.length ? `${lead}; ${facts.join('; ')}.` : `${lead}.`,
      };
    })
    .sort((a, b) => b.hours - a.hours);
}

export const approvalQueueTool: Tool = {
  name: APPROVAL_QUEUE_TOOL,
  description:
    'Lists pending timesheets for a pay period split into "clean" and "needs_review", using the same checks as tanda_approve_timesheets, and explains each pay code and why it applies. ' +
    'Read-only: a draft for a person to act on; nothing is approved.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['current', 'previous'], description: 'Pay period from PAY_CALENDAR when from/to are not given. Default current' },
      from: { ...S.from, description: 'Start date YYYY-MM-DD (overrides period; give with to)' },
      to: { ...S.to, description: 'End date YYYY-MM-DD (overrides period; give with from)' },
      queue: { type: 'string', enum: ['all', 'clean', 'needs_review'], description: 'Which rows to return. Default all (needs_review first)' },
      user_ids: S.userIds,
      location_ids: S.locationIds,
      workweek_start: { type: 'string', enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], description: 'First day of the 40h workweek. Default WORKWEEK_START (MON)' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const warnings: Warning[] = [];
    const which = oneOf(args.period, ['current', 'previous'] as const, 'current', 'period');
    const queue = oneOf(args.queue, ['all', 'clean', 'needs_review'] as const, 'all', 'queue');
    const week = workweek(args.workweek_start);
    const today = todayInZone();

    let from: string;
    let to: string;
    let basis: string;
    if (args.from || args.to) {
      if (!args.from || !args.to) throw new ArgError('Give both from and to, or neither (then period picks the pay period).');
      ({ from, to } = dateRange(args));
      basis = 'from/to';
    } else {
      const { segments, errors } = parsePayCalendar();
      for (const e of errors) warnings.push({ check: 'pay_calendar', reason: e });
      let p = periodContaining(today, segments);
      if (which === 'previous') p = previousPeriod(p, segments);
      ({ start: from, finish: to } = p);
      basis = `${which} pay period (PAY_CALENDAR, ${p.cadence})`;
    }

    const [org, people, sheets] = await Promise.all([
      loadOrg(client),
      loadPeople(client),
      client.getTimesheets({ from, to, user_ids: idList(args.user_ids) }),
    ]);
    const locIds = idList(args.location_ids);
    const deptFilter = locIds ? new Set(departmentsForLocations(org, locIds)) : null;
    const pending = sheets.filter((ts) => {
      const status = String(ts.status || '').toLowerCase();
      if (status === 'approved' || status === 'exported') return false;
      return !deptFilter || (ts.shifts as Rec[]).some((s) => deptFilter.has(s.department_id as number));
    });

    // Roster finishes only matter for a missing clock-out, as in tanda_approve_timesheets
    const needsRoster = pending.some((ts) => (ts.shifts as Rec[]).some((s) => s.start && !s.finish));
    const schedules = needsRoster ? await soft(warnings, 'roster', [] as Rec[], () => client.getSchedules({ from, to })) : [];

    const rows: Rec[] = pending.map((ts) => {
      const shifts = ts.shifts as Rec[];
      const { flags } = planShifts(ts, schedules, true, today, week.start);
      const weekHours = new Map<string, number>();
      for (const s of shifts) {
        const d = itemDate(s);
        if (d) weekHours.set(week.start(d), (weekHours.get(week.start(d)) || 0) + itemHours(s));
      }
      const weeksOver = [...weekHours.entries()].filter(([, h]) => h > WEEKLY_LIMIT).map(([w]) => w).sort();
      return {
        timesheet_id: ts.id,
        user_id: ts.user_id,
        user_name: people.name(ts.user_id),
        queue: flags.length ? 'needs_review' : 'clean',
        period: `${String(ts.start ?? '').slice(0, 10)}..${String(ts.finish ?? '').slice(0, 10)}`,
        shifts: shifts.length,
        hours: round2(shifts.reduce((n, s) => n + itemHours(s), 0)),
        cost: round2(Number(ts.total_cost) || 0),
        ...(flags.length ? { review_reasons: flags } : {}),
        pay_codes: explainPayCodes(shifts, weeksOver),
      };
    });

    const clean = rows.filter((r) => r.queue === 'clean');
    const review = rows.filter((r) => r.queue === 'needs_review');
    const byReason: Record<string, number> = {};
    for (const r of review) {
      for (const f of r.review_reasons as Array<{ reason: string }>) {
        // Group "shift over 12h (14h)" and "week of 2026-08-10 over 40h" by their kind
        const key = f.reason.replace(/\s*\(.*\)$/, '').replace(/^week of \S+/, 'week');
        byReason[key] = (byReason[key] || 0) + 1;
      }
    }
    const totals = (list: Rec[]) => ({
      timesheets: list.length,
      hours: round2(list.reduce((n, r) => n + (r.hours as number), 0)),
      cost: round2(list.reduce((n, r) => n + (r.cost as number), 0)),
    });
    const byHours = (a: Rec, b: Rec) => (b.hours as number) - (a.hours as number);
    const ordered = [...review.sort(byHours), ...clean.sort(byHours)].filter((r) => queue === 'all' || r.queue === queue);
    const cleanIds = clean.map((r) => r.timesheet_id);

    return guardResponse(
      {
        from,
        to,
        basis,
        week_basis: week.basis,
        pending: rows.length,
        clean: totals(clean),
        needs_review: { ...totals(review), by_reason: byReason },
        clean_timesheet_ids: cleanIds.slice(0, MAX_BATCH),
        ...(cleanIds.length > MAX_BATCH ? { clean_timesheet_ids_omitted: cleanIds.length - MAX_BATCH } : {}),
        next_step: rows.length
          ? `Draft only; nothing was approved. To approve the clean ones, a person runs ${APPROVE_TIMESHEETS_TOOL} for ${from}..${to} with timesheet_ids = clean_timesheet_ids, checks the preview, then confirms.`
          : 'No pending timesheets in this range.',
      },
      ordered,
      { offset: args.offset, pageSize: args.limit, extra: withWarnings(warnings) }
    );
  },
};
