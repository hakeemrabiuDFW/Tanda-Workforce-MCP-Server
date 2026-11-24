import { Tool } from './types';
import { ArgError, bool, dateRange, num, S, text } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, Org } from '../context';
import { topN, workRow } from './rows';
import { Warning, withWarnings } from '../warnings';
import { round2, toUnixSeconds } from '../../utils/time';

export const MAX_REVENUE_ENTRIES = 200;

interface RevenueEntry {
  location_id?: number;
  site?: string;
  amount: number;
}

interface Unmatched {
  site: string | null;
  location_id: number | null;
  amount: number;
  reason: string;
}

/** Lowercase letters and digits only, so "KIPP #3" and "kipp 3" match. */
const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function parseRevenue(value: unknown): RevenueEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArgError('revenue is required: a list of { site or location_id, amount } for the same from..to period (e.g. from the QuickBooks MCP).');
  }
  if (value.length > MAX_REVENUE_ENTRIES) throw new ArgError(`revenue has ${value.length} entries; the maximum is ${MAX_REVENUE_ENTRIES}.`);
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ArgError(`revenue[${i}] must be an object with site or location_id, and amount.`);
    const r = raw as Record<string, unknown>;
    const amount = num(r.amount);
    if (amount === undefined || amount < 0) throw new ArgError(`revenue[${i}].amount must be a number, 0 or more.`);
    const locationId = num(r.location_id);
    const site = text(r.site, `revenue[${i}].site`, 120);
    if (!site && !(locationId && locationId > 0)) throw new ArgError(`revenue[${i}] needs a site name or a location_id.`);
    return { ...(locationId && locationId > 0 ? { location_id: locationId } : {}), ...(site ? { site } : {}), amount: round2(amount) };
  });
}

/** Resolve a revenue entry to one Tanda location id, or say why it can't be. */
function resolveSite(entry: RevenueEntry, org: Org, byName: Map<string, number[]>): number | string {
  if (entry.location_id !== undefined) {
    return org.locationById.has(entry.location_id) ? entry.location_id : 'unknown location_id';
  }
  const ids = byName.get(normalize(entry.site as string)) || [];
  if (ids.length === 1) return ids[0];
  return ids.length ? 'name matches more than one site; pass location_id' : 'no site with this name; pass location_id';
}

export const laborVsRevenueTool: Tool = {
  name: 'tanda_labor_vs_revenue',
  description:
    'Joins actual labor cost by site from Tanda to revenue by site that you pass in (e.g. from the QuickBooks MCP) for the same from..to, returning labor % and margin per site with flags; read-only, nothing is changed anywhere.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date YYYY-MM-DD (required; the same period as the revenue)' },
      to: { type: 'string', description: 'End date YYYY-MM-DD, inclusive (required; max 62 days)' },
      revenue: {
        type: 'array',
        description: `Revenue per site for from..to, at most ${MAX_REVENUE_ENTRIES} entries. Each needs \`amount\` and either \`location_id\` (from tanda_org) or \`site\` (matched to the Tanda site name, ignoring case and punctuation). Entries for the same site are added together.`,
        items: {
          type: 'object',
          properties: {
            location_id: { type: 'number' },
            site: { type: 'string' },
            amount: { type: 'number' },
          },
          required: ['amount'],
        },
      },
      target_labor_pct: { type: 'number', description: 'Optional: flag sites whose labor cost is above this % of revenue (e.g. 45)' },
      include_bookkeeping: { type: 'boolean', description: 'Include labor at bookkeeping sites. Default false' },
      offset: S.offset,
      limit: S.limit,
    },
    required: ['from', 'to', 'revenue'],
  },
  async run(client, args) {
    if (!args.from || !args.to) throw new ArgError('from and to are required, and must match the period the revenue covers.');
    const { from, to } = dateRange(args);
    const revenue = parseRevenue(args.revenue);
    const target = num(args.target_labor_pct);
    if (target !== undefined && !(target > 0)) throw new ArgError('target_labor_pct must be a number above 0.');
    const includeBookkeeping = bool(args.include_bookkeeping);

    const org = await loadOrg(client);
    const shifts = await client.getShifts({ from, to, show_costs: true });
    const worked = shifts
      .filter((s) => toUnixSeconds(s.finish) !== null)
      .map((s) => workRow(s, org, undefined, { cost: true }))
      .filter((r) => r.date !== null && (r.date as string) >= from && (r.date as string) <= to)
      .filter((r) => includeBookkeeping || !org.isBookkeepingLocation(r.location_id as number | null));

    const labor = new Map<number | null, { hours: number; cost: number; shifts: number }>();
    for (const r of worked) {
      const key = (r.location_id as number | null) ?? null;
      const l = labor.get(key) || { hours: 0, cost: 0, shifts: 0 };
      l.hours += (r.hours as number) || 0;
      l.cost += (r.cost as number) || 0;
      l.shifts += 1;
      labor.set(key, l);
    }

    const byName = new Map<string, number[]>();
    for (const loc of org.locations) {
      const key = normalize(String(loc.name ?? ''));
      if (key) byName.set(key, [...(byName.get(key) || []), loc.id as number]);
    }
    const revenueBySite = new Map<number, number>();
    const unmatched: Unmatched[] = [];
    for (const entry of revenue) {
      const id = resolveSite(entry, org, byName);
      if (typeof id === 'string') {
        unmatched.push({ site: entry.site ?? null, location_id: entry.location_id ?? null, amount: entry.amount, reason: id });
      } else {
        revenueBySite.set(id, (revenueBySite.get(id) || 0) + entry.amount);
      }
    }

    const siteIds = new Set<number | null>([...labor.keys(), ...revenueBySite.keys()]);
    const rows = [...siteIds].map((id) => {
      const l = labor.get(id) || { hours: 0, cost: 0, shifts: 0 };
      const rev = id !== null && revenueBySite.has(id) ? round2(revenueBySite.get(id) as number) : null;
      const cost = round2(l.cost);
      const pct = rev ? round2((cost / rev) * 100) : null;
      const flags: string[] = [];
      if (rev === null) flags.push('no_revenue');
      else if (cost > rev) flags.push('labor_exceeds_revenue');
      if (rev !== null && l.shifts === 0) flags.push('no_labor');
      if (target !== undefined && pct !== null && pct > target) flags.push('over_target');
      return {
        location_id: id,
        name: id === null ? 'No site' : org.locationName(id),
        revenue: rev,
        labor_cost: cost,
        labor_hours: round2(l.hours),
        worked_shifts: l.shifts,
        labor_pct: pct,
        margin: rev === null ? null : round2(rev - cost),
        flags,
      };
    });
    // Highest labor % first; sites with no revenue after, biggest labor cost first
    rows.sort((a, b) => {
      if (a.labor_pct !== null && b.labor_pct !== null) return b.labor_pct - a.labor_pct;
      if (a.labor_pct !== null) return -1;
      if (b.labor_pct !== null) return 1;
      return b.labor_cost - a.labor_cost;
    });

    const matched = rows.filter((r) => r.revenue !== null);
    const totalRevenue = round2(matched.reduce((t, r) => t + (r.revenue as number), 0));
    const matchedCost = round2(matched.reduce((t, r) => t + r.labor_cost, 0));
    const noRevenue = rows.filter((r) => r.revenue === null);
    const count = (flag: string) => rows.filter((r) => r.flags.includes(flag)).length;

    const warnings: Warning[] = [];
    if (worked.length && worked.every((r) => !r.cost)) {
      warnings.push({ check: 'labor_cost', reason: 'Tanda returned no shift costs; the token may lack the cost scope, so labor % is not meaningful' });
    }

    return {
      ...guardResponse(
        {
          from,
          to,
          sites: rows.length,
          total_revenue: totalRevenue,
          labor_cost_at_revenue_sites: matchedCost,
          labor_pct: totalRevenue ? round2((matchedCost / totalRevenue) * 100) : null,
          margin: round2(totalRevenue - matchedCost),
          labor_cost_without_revenue: round2(noRevenue.reduce((t, r) => t + r.labor_cost, 0)),
          ...(target !== undefined ? { target_labor_pct: target } : {}),
          flagged: {
            labor_exceeds_revenue: count('labor_exceeds_revenue'),
            over_target: count('over_target'),
            no_revenue: count('no_revenue'),
            no_labor: count('no_labor'),
          },
          unmatched_revenue_total: round2(unmatched.reduce((t, u) => t + u.amount, 0)),
          ...topN(unmatched, 20, 'unmatched_revenue'),
          note: 'Read-only: nothing is changed in Tanda or QuickBooks. Revenue must cover the same from..to as the labor.',
        },
        rows,
        { offset: args.offset, pageSize: args.limit }
      ),
      ...withWarnings(warnings),
    };
  },
};
