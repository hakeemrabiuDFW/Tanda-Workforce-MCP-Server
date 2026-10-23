import { Tool } from './types';
import { ArgError, num } from '../args';
import { loadOrg, loadPeople, orgFrom, peopleFrom } from '../context';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { addDays, parseLocalDateTime, round2, toUnixSeconds, toZonedDate, toZonedISO, weekStart } from '../../utils/time';
import { itemHours } from '../../tanda/normalize';
import { Interval, overlaps } from './intervals';
import { soft, Warning, withWarnings } from '../warnings';

const MAX_PROPOSALS = 50;

interface Proposal {
  index: number;
  user_id: number | null;
  department_id: number | null;
  location_id: number | null;
  start: number | null;
  finish: number | null;
}

export const validateScheduleTool: Tool = {
  name: 'tanda_validate_schedule',
  description:
    'Checks proposed shifts (without saving anything) against existing rosters, leave, unavailability, 12h shift and 40h weekly limits, and supervisor double-booking; use it before publishing or suggesting a roster change.',
  inputSchema: {
    type: 'object',
    properties: {
      shifts: {
        type: 'array',
        description: 'Proposed shifts. start/finish as ISO, unix seconds, or local "YYYY-MM-DD HH:MM"',
        items: {
          type: 'object',
          properties: {
            user_id: { type: 'number' },
            department_id: { type: 'number' },
            location_id: { type: 'number', description: 'Used if department_id is not given' },
            start: { type: 'string' },
            finish: { type: 'string' },
          },
          required: ['user_id', 'start', 'finish'],
        },
      },
      max_shift_hours: { type: 'number', description: 'Default 12' },
      max_weekly_hours: { type: 'number', description: 'Default 40' },
    },
    required: ['shifts'],
  },
  async run(client, args) {
    const input = (args.shifts ?? args.schedules) as unknown;
    if (!Array.isArray(input) || input.length === 0) throw new ArgError('shifts must be a non-empty array of {user_id, start, finish, department_id|location_id}.');
    if (input.length > MAX_PROPOSALS) throw new ArgError(`At most ${MAX_PROPOSALS} shifts per call.`);
    const maxShift = num(args.max_shift_hours, 12) as number;
    const maxWeek = num(args.max_weekly_hours, 40) as number;

    // Each check fails soft: a missing scope skips that check and adds a warning.
    const warnings: Warning[] = [];
    const org = await soft(warnings, 'site_lookup', orgFrom([], []), () => loadOrg(client));
    const proposals: Proposal[] = (input as Rec[]).map((p, index) => {
      const dept = num(p.department_id ?? p.supervisor_department_id) ?? null;
      return {
        index,
        user_id: num(p.user_id ?? p.supervisor_id) ?? null,
        department_id: dept,
        location_id: num(p.location_id) ?? (dept !== null ? org.deptLocation.get(dept) ?? null : null),
        start: parseLocalDateTime(p.start),
        finish: parseLocalDateTime(p.finish),
      };
    });

    const valid = proposals.filter((p) => p.start !== null && p.finish !== null);
    const dates = valid.map((p) => toZonedDate(p.start) as string).sort();
    const results: Rec[] = [];

    let existing: Rec[] = [];
    let leave: Rec[] = [];
    let unavailable: Rec[] = [];
    let people = peopleFrom([]);
    let peopleChecked = true;
    if (dates.length) {
      // Cover whole weeks so weekly-hour totals include existing shifts
      const from = weekStart(dates[0]);
      const to = addDays(weekStart(dates[dates.length - 1]), 6);
      const userIds = [...new Set(valid.map((p) => p.user_id).filter((u): u is number => u !== null))];
      const rosterWarnings: Warning[] = [];
      [existing, leave, unavailable, people] = await Promise.all([
        soft(rosterWarnings, 'roster_conflicts', [] as Rec[], () => client.getSchedules({ from, to, user_ids: userIds })),
        soft(warnings, 'leave', [] as Rec[], () => client.getLeaveRequests({ from, to, user_ids: userIds })),
        soft(warnings, 'unavailability', [] as Rec[], () => client.getUnavailability({ from, to, user_ids: userIds })),
        soft(warnings, 'active_user', peopleFrom([]), () => loadPeople(client)),
      ]);
      // Without the roster, the weekly total only counts the proposed shifts.
      for (const w of rosterWarnings) warnings.push(w, { ...w, check: 'weekly_hours', reason: `${w.reason} (existing rostered hours not counted)` });
      peopleChecked = !warnings.some((w) => w.check === 'active_user');
    } else {
      people = await soft(warnings, 'active_user', peopleFrom([]), () => loadPeople(client));
      peopleChecked = !warnings.some((w) => w.check === 'active_user');
    }

    const weekly = new Map<string, number>();
    for (const s of existing) {
      const d = toZonedDate(s.start);
      if (!d) continue;
      const k = `${s.user_id}|${weekStart(d)}`;
      weekly.set(k, (weekly.get(k) || 0) + itemHours(s));
    }

    for (const p of proposals) {
      const errors: string[] = [];
      const issues: string[] = [];
      if (!p.user_id) errors.push('user_id missing');
      else if (peopleChecked && !people.byId.has(p.user_id)) issues.push('user is not an active user');
      if (p.start === null || p.finish === null) errors.push('start/finish not parseable');
      if (p.department_id !== null && org.departments.length && !org.departmentById.has(p.department_id)) errors.push(`department ${p.department_id} not found`);
      if (p.department_id === null && p.location_id === null) issues.push('no department_id/location_id given');
      if (p.location_id !== null && org.isBookkeepingLocation(p.location_id)) issues.push('bookkeeping site (not a real work site)');

      if (p.start !== null && p.finish !== null && p.user_id) {
        const span: Interval = [p.start, p.finish];
        const hours = (p.finish - p.start) / 3600;
        if (p.finish === p.start) errors.push('zero-length shift (start == finish)');
        else if (p.finish < p.start) errors.push('finish is before start');
        if (hours > maxShift) issues.push(`${round2(hours)}h exceeds ${maxShift}h shift limit`);

        const clash = existing.find((s) => s.user_id === p.user_id && toUnixSeconds(s.start) !== null && toUnixSeconds(s.finish) !== null &&
          overlaps(span, [toUnixSeconds(s.start) as number, toUnixSeconds(s.finish) as number]));
        if (clash) errors.push(`overlaps existing schedule ${clash.id} (${toZonedISO(clash.start)} - ${toZonedISO(clash.finish)})`);

        const other = proposals.find((q) => q !== p && q.user_id === p.user_id && q.start !== null && q.finish !== null && overlaps(span, [q.start, q.finish]));
        if (other) errors.push(`overlaps proposed shift #${other.index}${p.location_id !== other.location_id ? ' at a different site (double-booked)' : ''}`);

        const startDate = toZonedDate(p.start) as string;
        const finishDate = toZonedDate(p.finish - 1) as string;
        for (const l of leave) {
          if (l.user_id !== p.user_id || l.status === 'rejected') continue;
          const ls = String(l.start).slice(0, 10);
          const lf = String(l.finish).slice(0, 10);
          if (ls <= finishDate && lf >= startDate) errors.push(`${l.status} leave ${ls}..${lf}`);
        }
        for (const u of unavailable) {
          const us = toUnixSeconds(u.start);
          const uf = toUnixSeconds(u.finish);
          if (u.user_id === p.user_id && us !== null && uf !== null && overlaps(span, [us, uf])) {
            issues.push(`marked unavailable ${toZonedISO(us)} - ${toZonedISO(uf)}`);
          }
        }

        const k = `${p.user_id}|${weekStart(startDate)}`;
        const total = (weekly.get(k) || 0) + Math.max(0, hours);
        weekly.set(k, total);
        if (total > maxWeek) issues.push(`week of ${weekStart(startDate)} totals ${round2(total)}h (> ${maxWeek}h)`);
      }

      results.push({
        index: p.index,
        user_id: p.user_id,
        user_name: people.name(p.user_id),
        location_id: p.location_id,
        location_name: org.locationName(p.location_id),
        start_iso: toZonedISO(p.start),
        finish_iso: toZonedISO(p.finish),
        hours: p.start !== null && p.finish !== null ? round2(Math.max(0, p.finish - p.start) / 3600) : null,
        ok: errors.length === 0,
        errors,
        warnings: issues,
      });
    }

    return guardResponse(
      {
        proposed: results.length,
        ok: results.filter((r) => r.ok && (r.warnings as string[]).length === 0).length,
        with_warnings: results.filter((r) => r.ok && (r.warnings as string[]).length > 0).length,
        with_errors: results.filter((r) => !r.ok).length,
        ...(warnings.length ? { checks_skipped: [...new Set(warnings.map((w) => w.check))] } : {}),
        note: 'Validation only; nothing was written to Tanda.',
      },
      results,
      { extra: withWarnings(warnings) }
    );
  },
};
