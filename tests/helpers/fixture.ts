/**
 * Synthetic org sized like production: 84 sites, 70 users, a 7-day week of rosters
 * and timesheets. Every user carries PII so leaks are easy to detect.
 */
import { fakeTanda, nySeconds, RouteHandler } from './fakeTanda';

export const FIXTURE_FROM = '2026-10-12';
export const FIXTURE_TO = '2026-10-18';
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

export function buildOrg() {
  const bookkeeping = [281737, 301754, 396358];
  const locations = Array.from({ length: 84 }, (_, i) => ({
    id: i < 3 ? bookkeeping[i] : 1000 + i,
    name: i === 0 ? 'One Time Projects' : i === 1 ? 'Floater' : i === 2 ? 'MCP Test' : `School ${i} Elementary`,
    short_name: `S${i}`,
    address: '1 Main St',
  }));
  const users = Array.from({ length: 70 }, (_, i) => ({
    id: 5000 + i,
    name: `Worker ${i}`,
    employee_id: `E${i}`,
    employment_start_date: '2024-01-01',
    active: true,
    user_levels: ['employee'],
    award_template_id: i % 17 === 0 ? null : 77,
    report_department_id: null,
    date_of_birth: '1990-01-01',
    passcode: '9999',
    phone: '+15550000',
    email: `w${i}@example.com`,
    legal_first_name: 'Legal',
    department_ids: [] as number[],
  }));
  const supervisors = users.slice(0, 8);
  const departments: Array<Record<string, unknown>> = [];
  locations.forEach((loc, i) => {
    const cleaning = { id: 20000 + i, name: 'Cleaning', location_id: loc.id, staff: [] as number[] };
    const sup = { id: 30000 + i, name: i % 2 ? 'Supervisor' : 'Supervisors', location_id: loc.id, staff: supervisors.map((u) => u.id) };
    departments.push(cleaning, sup);
  });
  users.forEach((u, i) => {
    const dept = departments[(2 * (3 + (i % 81)))] as { id: number; staff: number[] };
    dept.staff.push(u.id);
    u.department_ids.push(dept.id);
  });

  let id = 1;
  const schedules: Array<Record<string, unknown>> = [];
  const shifts: Array<Record<string, unknown>> = [];
  for (const date of DAYS) {
    users.forEach((u, i) => {
      if (i < 8) return; // supervisors handled below
      const start = nySeconds(date, i % 2 ? '17:00' : '09:00');
      const dept = u.department_ids[0];
      schedules.push({ id: id++, user_id: u.id, department_id: dept, start, finish: start + 6 * 3600, breaks: [], cost: 90, user_name: u.name });
      shifts.push({
        id: id++, user_id: u.id, timesheet_id: 9000 + i, department_id: dept, date, start: start + 300, finish: start + 6 * 3600 + 300,
        breaks: [{ length: 15 }], status: 'PENDING', cost: 92.5,
        award_interpretation: [{ export_name: 'ORD', units: 5.75, cost: 86.25 }, { export_name: 'EVE', units: 0.5, cost: 6.25 }],
      });
    });
    supervisors.forEach((u, i) => {
      // two supervisors share each site (overlap); others leave gaps
      const loc = 3 + (i >> 1);
      const start = nySeconds(date, '16:00');
      schedules.push({ id: id++, user_id: u.id, department_id: 30000 + loc, start, finish: start + 6 * 3600, cost: 150, user_name: u.name });
    });
  }
  const timesheets = users.map((u, i) => ({
    id: 9000 + i, user_id: u.id, start: '2026-10-12', finish: '2026-10-18', status: i % 3 ? 'pending' : 'approved',
    shifts: shifts.filter((s) => s.user_id === u.id),
  }));
  const now = Math.floor(Date.now() / 1000);
  const active = users.slice(8, 28).map((u, i) => ({
    id: 70000 + i, user_id: u.id, department_id: u.department_ids[0], start: now - (i < 3 ? 14 : 3) * 3600, status: 'active',
  }));
  const leave = users.slice(0, 30).map((u, i) => ({
    id: 80000 + i, user_id: u.id, leave_type: 'Annual', status: i % 2 ? 'pending' : 'approved',
    start: '2026-10-13', finish: '2026-10-14', hours: 16, daily_breakdown: [{ date: '2026-10-13', hours: 8 }],
  }));
  const unavailability = users.slice(0, 30).map((u, i) => ({
    id: 81000 + i, user_id: u.id, title: 'Class', start: nySeconds('2026-10-14', '08:00'), finish: nySeconds('2026-10-14', '12:00'),
  }));
  const versions = Array.from({ length: 60 }, (_, i) => ({
    version_id: i, time: now - i * 60, event: 'update', author: { id: 5000, name: 'Worker 0', email: 'w0@example.com' },
    changes: [{ field: 'finish', previous: now - 3600, updated: now }],
  }));
  const exportHeader = 'Employee ID,Employee Name,Date,Pay Code,Hours,Amount';
  const exportCsv = [exportHeader, ...Array.from({ length: 1200 }, (_, i) =>
    `E${i % 70},"Worker ${i % 70}",2026-10-1${i % 7},${i % 25 === 0 ? '' : 'ORD'},7.5,${(7.5 * 18).toFixed(2)}`)].join('\n');

  return { locations, departments, users, schedules, shifts, timesheets, active, leave, unavailability, versions, exportCsv };
}

export function fixtureClient() {
  const org = buildOrg();
  const inRange = (rows: Array<Record<string, unknown>>, p: Record<string, string>, dateOf: (r: Record<string, unknown>) => string) =>
    rows.filter((r) => dateOf(r) >= p.from && dateOf(r) <= p.to);
  const dayOf = (r: Record<string, unknown>) =>
    (r.date as string) ?? new Date((r.start as number) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const routes: Array<[string | RegExp, RouteHandler]> = [
    ['/locations', () => org.locations],
    ['/departments', () => org.departments],
    ['/users', () => org.users],
    ['/users/me', () => org.users[0]],
    ['/users/inactive', () => []],
    [/^\/users\/\d+$/, (r) => org.users.find((u) => `/users/${u.id}` === r.path)],
    ['/schedules', (r) => inRange(org.schedules, r.params, dayOf)],
    ['/shifts', (r) => inRange(org.shifts, r.params, dayOf)],
    ['/shifts/active', () => org.active],
    [/^\/(shifts|schedules)\/\d+\/versions$/, () => org.versions],
    [/^\/timesheets\/on\//, (r) => (r.params.export_format ? org.exportCsv : org.timesheets)],
    ['/leave', () => org.leave],
    ['/leave_balances', () => [{ user_id: 5000, leave_type: 'Annual', balance: 40 }]],
    [/^\/leave\/types_for\//, () => ['Annual', 'Sick']],
    ['/unavailability', () => org.unavailability],
  ];
  return { ...fakeTanda(routes), org };
}
