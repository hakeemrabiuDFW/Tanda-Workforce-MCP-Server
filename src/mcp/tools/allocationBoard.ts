import { Tool } from './types';
import { ArgError, bool, num, oneOf, text } from '../args';
import { byteSize, MAX_BYTES } from '../guard';
import { loadStaffing, matchSite, minTenureMonths, peopleLine, recommend, ROLES, SORTS, targetWeek, MIN_EXPERIENCED_MONTHS } from '../apps/staffing';

export const ALLOCATION_BOARD_TOOL = 'staff_allocation_board';
/** Room left under the cap for the rest of the result (week, notes, warnings). */
const BOARD_HEADROOM_BYTES = 3 * 1024;

export const allocationBoardTool: Tool = {
  name: ALLOCATION_BOARD_TOOL,
  title: 'Cleaner / supervisor / trainer allocation',
  description:
    `Shows a board for assigning cleaners, a supervisor and a trainer to a site, with each person's tenure and scheduled hours for the whole target week (sort or filter by either); suggests the lowest load first, with a lead cleaner and trainer of ${MIN_EXPERIENCED_MONTHS}+ months. Read-only draft: assignments are not written to Tanda.`,
  inputSchema: {
    type: 'object',
    properties: {
      site_name: { type: 'string', description: 'Site to staff; matched to a Tanda site by name when one exists' },
      cleaners_needed: { type: 'number', description: 'Cleaners to assign (1-20). Default 2' },
      needs_trainer: { type: 'boolean', description: 'Assign a trainer for the first clean. Default true' },
      hours_per_cleaner_per_week: { type: 'number', description: 'Hours this site adds to each cleaner\'s week; people it would push past 40 h are suggested last' },
      week_of: { type: 'string', description: 'Any date (YYYY-MM-DD) in the week to staff. Default: the week containing tomorrow' },
      sort_by: { type: 'string', enum: [...SORTS], description: 'Order of each list: load (fewest scheduled hours first, default), tenure (longest first) or name' },
      min_tenure_months: { type: 'number', description: 'Only list people with at least this many months of tenure' },
    },
  },
  app: {
    view: 'allocation',
    summary(c) {
      const r = c.recommendation as { cleaners: never[]; supervisor: never[]; trainer: never[] };
      const focus = c.focus as { name: string } | null;
      const week = c.week as { from: string; to: string };
      const pools = c.pools as Record<string, unknown[]>;
      return (
        `Allocation board${focus ? ` for ${focus.name}` : ''}, week ${week.from} to ${week.to}. ` +
        `Suggested [tenure, hours already scheduled that week]: cleaners ${peopleLine(r.cleaners)}; ` +
        `supervisor ${peopleLine(r.supervisor)}; trainer ${peopleLine(r.trainer)}. ` +
        `Listed: ${pools.supervisor.length} supervisors, ${pools.trainer.length} trainers, ${pools.cleaner.length} cleaners, ${pools.trainee.length} trainees. ` +
        `${(c.warnings as string[]).join(' ')} ${c.note} Draft only: nothing was written to Tanda.`
      ).replace(/\s+/g, ' ');
    },
  },
  async run(client, args) {
    const siteName = text(args.site_name, 'site_name', 120);
    const cleaners = num(args.cleaners_needed, 2) as number;
    if (!Number.isInteger(cleaners) || cleaners < 1 || cleaners > 20) throw new ArgError('cleaners_needed must be a whole number from 1 to 20.');
    const addHours = num(args.hours_per_cleaner_per_week, 0) as number;
    if (addHours < 0 || addHours > 80) throw new ArgError('hours_per_cleaner_per_week must be between 0 and 80.');
    const sort = oneOf(args.sort_by, SORTS, 'load', 'sort_by');
    const minMonths = minTenureMonths(args);
    const need = { cleaners, supervisor: 1, trainer: bool(args.needs_trainer, true) ? 1 : 0 };

    const { staffing, org } = await loadStaffing(client, targetWeek(args), { sort, minTenureMonths: minMonths });
    const match = siteName ? matchSite(staffing.sites, org, siteName) : null;
    const focus = siteName ? match ?? { id: null, name: siteName, cleaners: 0, supervisors: 0, week_hours: 0 } : null;
    const picks = recommend(staffing, need, addHours);

    // Keep the whole board under the 25 KB response cap: drop from the end of the longest list
    const pools = { ...staffing.pools };
    let omitted = 0;
    const size = () => byteSize({ pools, sites: staffing.sites, recommendation: picks });
    while (size() > MAX_BYTES - BOARD_HEADROOM_BYTES) {
      const longest = ROLES.reduce((a, b) => (pools[b].length > pools[a].length ? b : a));
      if (pools[longest].length === 0) break;
      const drop = Math.max(1, Math.ceil(pools[longest].length / 10));
      pools[longest] = pools[longest].slice(0, -drop);
      omitted += drop;
    }

    return {
      view: 'allocation',
      focus,
      in_tanda: Boolean(match),
      need,
      week: staffing.week,
      sort_by: sort,
      min_tenure_months: minMonths,
      pools,
      ...(omitted ? { people_omitted: omitted } : {}),
      sites: staffing.sites,
      sites_omitted: staffing.sites_omitted,
      recommendation: { cleaners: picks.cleaners, supervisor: picks.supervisor, trainer: picks.trainer },
      warnings: picks.warnings,
      trainer_source: staffing.trainer_source,
      note:
        `Load = hours rostered in Tanda for the whole week ${staffing.week.from} to ${staffing.week.to} (${staffing.shifts_counted} shifts). Trainers: ${staffing.trainer_source}.` +
        (omitted ? ` ${omitted} people are not listed to keep the board small; raise min_tenure_months to narrow it.` : ''),
    };
  },
};
