import { isDate } from '../../utils/time';

export interface Tenure {
  years: number;
  months: number;
  /** Whole months since employment_start_date; what sorting, filtering and the 1-year rules use. */
  total_months: number;
  /** e.g. "3y 2m", "8m", "under 1m" */
  label: string;
}

/**
 * Whole years + months between `startDate` (Tanda's employment_start_date, YYYY-MM-DD) and
 * `asOf` (YYYY-MM-DD). Null when the start date is missing, malformed or after `asOf`:
 * someone with no known start date is never treated as experienced.
 */
export function tenureFrom(startDate: unknown, asOf: string): Tenure | null {
  if (!isDate(startDate) || !isDate(asOf) || startDate > asOf) return null;
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ay, am, ad] = asOf.split('-').map(Number);
  let total = (ay - sy) * 12 + (am - sm);
  if (ad < sd) total -= 1; // the month is not complete yet
  total = Math.max(0, total);
  const years = Math.floor(total / 12);
  const months = total % 12;
  const label = total === 0 ? 'under 1m' : years === 0 ? `${months}m` : months === 0 ? `${years}y` : `${years}y ${months}m`;
  return { years, months, total_months: total, label };
}

/** "Maria Lopez Garcia" -> "Maria G." (first name + last initial); single names are kept. */
export function shortName(name: unknown): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Unnamed';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
