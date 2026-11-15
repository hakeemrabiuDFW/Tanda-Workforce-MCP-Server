import { Tool } from './types';
import { ArgError, Args, num, text } from '../args';
import { round2 } from '../../utils/time';
import { loadStaffing, matchSite, peopleLine, recommend, targetWeek } from '../apps/staffing';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKS_PER_MONTH = 4.33;
/** A supervisor check is planned as one hour. */
const SUPERVISOR_CHECK_HOURS = 1;

/** Minutes after midnight for "6 pm", "6:30 PM" or "18:30". */
function minutesOf(value: string, name: string): number {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
  const bad = () => new ArgError(`${name} must be a time such as "6:00 pm" or "18:00" (got "${value}").`);
  if (!m) throw bad();
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap && (h < 1 || h > 12)) throw bad();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) throw bad();
  return h * 60 + min;
}

function days(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return DAYS.slice(0, 5);
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = new Set<string>();
  for (const d of raw) {
    const key = String(d).trim().slice(0, 3).toLowerCase();
    const hit = DAYS.find((x) => x.toLowerCase() === key);
    if (!hit) throw new ArgError(`days must be weekday names such as Mon, Tue (got "${String(d)}").`);
    out.add(hit);
  }
  if (out.size === 0) throw new ArgError('days needs at least one weekday.');
  return DAYS.filter((d) => out.has(d));
}

function count(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const n = num(value, fallback) as number;
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The Route location Claude looked up with the Route connector; this server cannot reach Route. */
function routeLocation(value: unknown): { client: string; name: string; site_address: string } | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ArgError('route_location must be an object with client, name and address.');
  const v = value as Args;
  const client = text(v.client, 'route_location.client', 120) ?? '';
  const name = text(v.name, 'route_location.name', 120) ?? '';
  const address = text(v.address, 'route_location.address', 200) ?? '';
  return client || name || address ? { client, name, site_address: address } : null;
}

export const SITE_SCHEDULE_TOOL = 'conversation_to_site_schedule';

export const siteScheduleTool: Tool = {
  name: SITE_SCHEDULE_TOOL,
  title: 'Conversation → site schedule',
  description:
    'Shows a draft weekly cleaning schedule for a site from a client conversation (days, times, crew, labor hours, matching Tanda site, suggested staff with tenure and their scheduled hours that week); pass the Route location as route_location if you looked it up. Read-only: nothing is written to Tanda.',
  inputSchema: {
    type: 'object',
    properties: {
      site_name: { type: 'string', description: 'Client or site name' },
      site_address: { type: 'string', description: 'Street address of the site' },
      days: { type: 'array', items: { type: 'string' }, description: 'Cleaning days, e.g. ["Mon","Wed","Fri"]. Default Mon-Fri' },
      start_time: { type: 'string', description: 'Shift start, e.g. "6:00 pm" or "18:00". Default 6:00 pm' },
      end_time: { type: 'string', description: 'Shift end, e.g. "9:00 pm". Default 9:00 pm' },
      cleaners_needed: { type: 'number', description: 'Cleaners per shift (1-20). Default 1' },
      supervisor_visits_per_week: { type: 'number', description: 'Supervisor checks a week (0-7). Default 2' },
      notes: { type: 'string', description: 'Anything else from the conversation: access, alarm, special requests' },
      week_of: { type: 'string', description: 'Any date (YYYY-MM-DD) in the week to staff. Default: the week containing tomorrow' },
      route_location: {
        type: 'object',
        description: 'The matching Route location, if you found one with the Route connector (locations_find)',
        properties: { client: { type: 'string' }, name: { type: 'string' }, address: { type: 'string' } },
      },
    },
    required: ['site_name'],
  },
  app: {
    view: 'schedule',
    summary(c) {
      const s = c.suggested as { cleaners: never[]; supervisor: never[]; trainer: never[] };
      const tanda = c.tandaMatch as { name: string } | null;
      const week = c.week as { from: string; to: string };
      return (
        `Draft schedule for ${c.site_name}: ${(c.days as string[]).join(', ')} ${c.start}-${c.end}, ${c.cleaners} cleaner(s), ` +
        `${c.supVisits} supervisor check(s) a week = ${c.weeklyHours} h/week (${c.monthlyHours} h/month). ` +
        `Tanda site: ${tanda ? tanda.name : 'not created yet'}. Route location: ${c.routeMatch ? 'matched' : 'not provided'}. ` +
        `Suggested for the week ${week.from} to ${week.to} [tenure, hours already scheduled that week]: ` +
        `cleaners ${peopleLine(s.cleaners)}; supervisor ${peopleLine(s.supervisor)}; trainer ${peopleLine(s.trainer)}. ` +
        `${(c.warnings as string[]).join(' ')} Draft only: nothing was written to Tanda.`
      ).replace(/\s+/g, ' ');
    },
  },
  async run(client, args) {
    const siteName = text(args.site_name, 'site_name', 120);
    if (!siteName) throw new ArgError('site_name is required.');
    const start = text(args.start_time, 'start_time', 20) ?? '6:00 pm';
    const end = text(args.end_time, 'end_time', 20) ?? '9:00 pm';
    let shiftHours = (minutesOf(end, 'end_time') - minutesOf(start, 'start_time')) / 60;
    if (shiftHours <= 0) shiftHours += 24; // overnight shift
    const onDays = days(args.days);
    const cleaners = count(args.cleaners_needed, 'cleaners_needed', 1, 1, 20);
    const supVisits = Math.min(count(args.supervisor_visits_per_week, 'supervisor_visits_per_week', 2, 0, 7), onDays.length);
    const route = routeLocation(args.route_location);

    const week = targetWeek(args);
    const { staffing, org } = await loadStaffing(client, week);
    const perCleanerWeek = shiftHours * onDays.length;
    const tanda = matchSite(staffing.sites, org, siteName);
    // A new site gets a trainer for the first clean; a site already in Tanda does not need one.
    const picks = recommend(staffing, { cleaners, supervisor: 1, trainer: tanda ? 0 : 1 }, perCleanerWeek);

    const shifts: Array<Record<string, unknown>> = [];
    for (const d of onDays) for (let i = 0; i < cleaners; i++) shifts.push({ day: d, role: 'Cleaner', start, end, hours: round2(shiftHours) });
    for (const d of onDays.slice(0, supVisits)) shifts.push({ day: d, role: 'Supervisor check', start, end: '+1h', hours: SUPERVISOR_CHECK_HOURS });
    const weeklyHours = round2(perCleanerWeek * cleaners + supVisits * SUPERVISOR_CHECK_HOURS);

    return {
      view: 'schedule',
      site_name: siteName,
      site_address: text(args.site_address, 'site_address', 200) ?? route?.site_address ?? '',
      routeMatch: route,
      tandaMatch: tanda,
      week: staffing.week,
      days: onDays,
      start,
      end,
      shiftHours: round2(shiftHours),
      cleaners,
      supVisits,
      weeklyHours,
      monthlyHours: round2(weeklyHours * WEEKS_PER_MONTH),
      shifts,
      notes: text(args.notes, 'notes', 2000) ?? '',
      suggested: { cleaners: picks.cleaners, supervisor: picks.supervisor, trainer: picks.trainer },
      warnings: picks.warnings,
      trainer_source: staffing.trainer_source,
      load_basis: `Load = hours rostered in Tanda for ${staffing.week.from} to ${staffing.week.to} (${staffing.shifts_counted} shifts).`,
    };
  },
};
