import axios, { AxiosInstance, AxiosError, AxiosAdapter, AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { TandaTokenResponse, TandaUser, TandaDailyStats } from './types';
import { tandaRateLimiter } from './rateLimiter';
import { ETagCache } from './etagCache';
import { chunkDateRange, toUnixSeconds, addDays, DEFAULT_TIMEZONE } from '../utils/time';
import { dedupeById, itemDate, itemHours } from './normalize';

export type Rec = Record<string, unknown>;

/**
 * Error with an actionable, user-facing message. Never carries upstream stack traces
 * or response bodies beyond Tanda's own short error text.
 */
export class TandaApiError extends Error {
  constructor(message: string, public statusCode: number, public hint?: string, public scope?: string) {
    super(message);
    this.name = 'TandaApiError';
  }

  toJSON(): Rec {
    return { error: this.message, status: this.statusCode, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

export interface TandaClientOptions {
  /** Custom axios adapter (used by tests to stub Tanda). */
  adapter?: AxiosAdapter;
  /** Skip the shared rate limiter (tests only). */
  disableRateLimit?: boolean;
  /**
   * Session-level refresher. Tanda refresh tokens are single-use, so when a session owns
   * the tokens a 401 asks it for a new access token (it serializes and saves the rotation)
   * instead of this client spending its own copy of the refresh token.
   */
  refresh?: (failedAccessToken: string) => Promise<string>;
}

export interface GetOptions {
  /** Serve from cache without a request while younger than this (still revalidated with ETag after). */
  freshMs?: number;
  /** Bypass the ETag cache entirely (e.g. export files). */
  noCache?: boolean;
  responseType?: 'json' | 'text';
}

/** Tanda rejects date ranges longer than this on list endpoints. */
export const TANDA_MAX_RANGE_DAYS = 7;

/** Shared across clients so caches survive the per-request client instances. */
const etagCache = new ETagCache(1000);

/** Which OAuth scope an endpoint needs, for actionable 403 messages. */
function scopeFor(path: string): string {
  if (path.startsWith('/users/me')) return 'me';
  if (path.startsWith('/users')) return 'user';
  if (path.startsWith('/departments') || path.startsWith('/locations')) return 'department';
  if (path.startsWith('/schedules') || path.startsWith('/rosters')) return 'roster';
  if (path.startsWith('/shifts') || path.startsWith('/timesheets')) return 'timesheet';
  if (path.startsWith('/leave')) return 'leave';
  if (path.startsWith('/unavailability')) return 'unavailability';
  return 'the required';
}

export class TandaClient {
  private client: AxiosInstance;
  private accessToken: string;
  private refreshToken?: string;
  private tokenExpiresAt?: number;
  private readonly options: TandaClientOptions;
  /** Stable, non-reversible id for this token; used to scope caches per identity. */
  readonly cacheScope: string;

  constructor(accessToken: string, refreshToken?: string, expiresIn?: number, options: TandaClientOptions = {}) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.options = options;
    this.cacheScope = crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
    if (expiresIn) this.tokenExpiresAt = Date.now() + expiresIn * 1000;

    this.client = axios.create({
      baseURL: config.TANDA_API_BASE_URL,
      timeout: 30000,
      headers: { Accept: 'application/json' },
      // 304 Not Modified is a success for ETag revalidation
      validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });

    this.client.interceptors.request.use(async (requestConfig) => {
      // This server is read-only: never send a mutating request to Tanda.
      const method = (requestConfig.method || 'get').toLowerCase();
      if (method !== 'get' && method !== 'head') {
        throw new TandaApiError(`Read-only server: ${method.toUpperCase()} requests to Tanda are disabled`, 403);
      }
      if (!this.options.disableRateLimit) await tandaRateLimiter.acquire();
      requestConfig.headers.Authorization = `Bearer ${this.accessToken}`;
      logger.debug(`Tanda API Request: GET ${requestConfig.url}`);
      return requestConfig;
    });
  }

  getTokenInfo(): { accessToken: string; expiresAt?: number } {
    return { accessToken: this.accessToken, expiresAt: this.tokenExpiresAt };
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.options.refresh) {
      this.accessToken = await this.options.refresh(this.accessToken);
      return;
    }
    if (!this.refreshToken) throw new TandaApiError('No refresh token available', 401);
    const tokens = await refreshTandaToken(this.refreshToken);
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
  }

  /** Map an upstream failure to an actionable error. Upstream stacks/bodies are only logged. */
  private toApiError(error: unknown, path: string): TandaApiError {
    if (error instanceof TandaApiError) return error;
    const ax = error as AxiosError;
    const status = ax.response?.status;
    const data = ax.response?.data as Rec | undefined;
    const upstream = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : undefined;
    logger.warn(`Tanda API error ${status ?? 'network'} on ${path}: ${upstream ?? ax.message}`);

    switch (status) {
      case 400:
      case 422:
        return new TandaApiError(`Tanda rejected the request to ${path}${upstream ? `: ${upstream}` : ''}`, status, 'Check the arguments (dates are YYYY-MM-DD, ids are numbers).');
      case 401:
        return new TandaApiError('Tanda session expired or was revoked.', 401, 'Reconnect the Tanda integration (re-run OAuth) and try again.');
      case 403:
        return new TandaApiError(`Tanda denied access to ${path}.`, 403, `The token needs the "${scopeFor(path)}" scope and a manager/admin role for this data.`, scopeFor(path));
      case 404:
        return new TandaApiError(`Not found in Tanda: ${path}.`, 404, 'Check the id exists and is visible to this account.');
      case 429:
        return new TandaApiError('Tanda rate limit reached (100 requests/min shared across tokens).', 429, 'Wait a minute, or narrow the date range to reduce calls.');
      default:
        if (status && status >= 500) {
          return new TandaApiError(`Tanda is unavailable (HTTP ${status}).`, status, 'Retry shortly.');
        }
        if (ax.code === 'ECONNABORTED') {
          return new TandaApiError('Tanda request timed out.', 504, 'Retry, or narrow the date range.');
        }
        return new TandaApiError('Could not reach Tanda.', 502, 'Retry shortly.');
    }
  }

  /**
   * GET with ETag/If-None-Match caching, one 401 refresh retry and one 429 retry.
   */
  async get<T = unknown>(path: string, params: Record<string, string | undefined> = {}, opts: GetOptions = {}): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') clean[k] = v;
    const key = ETagCache.key(this.cacheScope, path, clean);
    const cached = opts.noCache ? undefined : etagCache.get(key);
    if (cached && opts.freshMs && Date.now() - cached.storedAt < opts.freshMs) return cached.data as T;

    const reqConfig: AxiosRequestConfig = {
      params: clean,
      headers: cached?.etag ? { 'If-None-Match': cached.etag } : {},
      ...(opts.responseType === 'text' ? { responseType: 'text', transformResponse: (d: unknown) => d } : {}),
    };

    let attempt = 0;
    for (;;) {
      try {
        const response = await this.client.get(path, reqConfig);
        if (response.status === 304 && cached) {
          etagCache.touch(key);
          return cached.data as T;
        }
        const etag = response.headers?.etag as string | undefined;
        if (!opts.noCache && (etag || opts.freshMs)) etagCache.set(key, { etag, data: response.data, storedAt: Date.now() });
        return response.data as T;
      } catch (error) {
        const status = (error as AxiosError).response?.status;
        if (status === 401 && (this.refreshToken || this.options.refresh) && attempt === 0) {
          attempt++;
          try {
            await this.refreshAccessToken();
            continue;
          } catch {
            /* fall through to error mapping */
          }
        }
        if (status === 429 && attempt === 0) {
          attempt++;
          const retryAfter = Number((error as AxiosError).response?.headers?.['retry-after']) || 5;
          await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
          continue;
        }
        throw this.toApiError(error, path);
      }
    }
  }

  private async getList<T = Rec>(path: string, params: Record<string, string | undefined> = {}, opts: GetOptions = {}): Promise<T[]> {
    const data = await this.get<unknown>(path, params, opts);
    return Array.isArray(data) ? (data as T[]) : [];
  }

  /**
   * GET a date-ranged list endpoint, splitting from..to into <= 7-day windows so Tanda's
   * range limit is never hit. Results are merged and de-duplicated by id.
   */
  async getChunked<T extends { id?: unknown } = Rec>(
    path: string,
    from: string,
    to: string,
    extra: Record<string, string | undefined> = {}
  ): Promise<T[]> {
    const all: T[] = [];
    for (const chunk of chunkDateRange(from, to, TANDA_MAX_RANGE_DAYS)) {
      all.push(...(await this.getList<T>(path, { from: chunk.from, to: chunk.to, ...extra })));
    }
    return dedupeById(all);
  }

  // ==================== Users ====================

  async getCurrentUser(): Promise<TandaUser> {
    return this.get<TandaUser>('/users/me');
  }

  async getUsers(filter: { updated_after?: string; department_ids?: number[]; freshMs?: number } = {}): Promise<Rec[]> {
    const users = await this.getList('/users', { updated_after: filter.updated_after }, { freshMs: filter.freshMs });
    if (filter.department_ids?.length) {
      const wanted = new Set(filter.department_ids);
      return users.filter((u) => ((u.department_ids as number[]) || []).some((id) => wanted.has(id)));
    }
    return users;
  }

  async getInactiveUsers(): Promise<Rec[]> {
    return this.getList('/users/inactive');
  }

  async getUser(userId: number): Promise<Rec> {
    return this.get<Rec>(`/users/${userId}`);
  }

  async getStaffByDepartment(departmentId: number): Promise<Rec[]> {
    // /users?department_ids is not reliably filtered by Tanda; department.staff is the source of truth.
    const [department, users] = await Promise.all([this.getDepartment(departmentId), this.getUsers()]);
    const staff = new Set((department.staff as number[]) || []);
    return users.filter((u) => staff.has(u.id as number));
  }

  // ==================== Org ====================

  async getDepartments(opts: GetOptions & { updated_after?: string } = {}): Promise<Rec[]> {
    return this.getList('/departments', { updated_after: opts.updated_after }, opts);
  }

  async getDepartment(departmentId: number): Promise<Rec> {
    return this.get<Rec>(`/departments/${departmentId}`);
  }

  async getLocations(opts: GetOptions & { updated_after?: string } = {}): Promise<Rec[]> {
    return this.getList('/locations', { updated_after: opts.updated_after }, opts);
  }

  // ==================== Schedules / shifts ====================

  async getSchedules(filter: {
    from: string; to: string; user_ids?: number[]; department_ids?: number[];
    show_costs?: boolean; include_names?: boolean; updated_after?: string;
  }): Promise<Rec[]> {
    return this.getChunked('/schedules', filter.from, filter.to, {
      user_ids: filter.user_ids?.join(','),
      department_ids: filter.department_ids?.join(','),
      show_costs: filter.show_costs ? 'true' : undefined,
      include_names: filter.include_names ? 'true' : undefined,
      updated_after: filter.updated_after,
    });
  }

  async getShifts(filter: {
    from: string; to: string; user_ids?: number[]; show_costs?: boolean;
    show_award_interpretation?: boolean; updated_after?: string;
  }): Promise<Rec[]> {
    return this.getChunked('/shifts', filter.from, filter.to, {
      user_ids: filter.user_ids?.join(','),
      show_costs: filter.show_costs ? 'true' : undefined,
      show_award_interpretation: filter.show_award_interpretation ? 'true' : undefined,
      updated_after: filter.updated_after,
    });
  }

  async getActiveShifts(): Promise<Rec[]> {
    return this.getList('/shifts/active', {}, { noCache: true });
  }

  async getVersions(kind: 'shifts' | 'schedules', id: number): Promise<Rec[]> {
    return this.getList(`/${kind}/${id}/versions`);
  }

  // ==================== Timesheets ====================

  /**
   * Timesheets overlapping from..to via GET /timesheets/on/{date}?show_costs&show_award_interpretation
   * (shifts embedded). Each call returns the whole pay period containing {date}, so we query once per
   * pay period, de-duplicate by timesheet id and keep only shifts inside the range. Timesheets with no
   * shifts in range and zero cost are dropped unless include_empty.
   */
  async getTimesheets(filter: {
    from: string; to: string; user_ids?: number[]; include_empty?: boolean; award_interpretation?: boolean;
  }): Promise<Rec[]> {
    const params = {
      show_costs: 'true',
      show_award_interpretation: filter.award_interpretation === false ? undefined : 'true',
    };
    const byId = new Map<unknown, Rec>();
    let date = filter.from;
    let calls = 0;
    while (date <= filter.to && calls++ < 62) {
      const sheets = await this.getList(`/timesheets/on/${date}`, params);
      let periodEnd: string | null = null;
      for (const ts of sheets) {
        if (!byId.has(ts.id)) byId.set(ts.id, ts);
        const finish = typeof ts.finish === 'string' ? ts.finish.slice(0, 10) : null;
        if (finish && /^\d{4}-\d{2}-\d{2}$/.test(finish) && (!periodEnd || finish < periodEnd)) periodEnd = finish;
      }
      // Jump past the earliest period end (pay periods can differ per user); else step a day.
      date = periodEnd && periodEnd >= date ? addDays(periodEnd, 1) : addDays(date, 1);
    }

    const users = filter.user_ids?.length ? new Set(filter.user_ids) : null;
    const out: Rec[] = [];
    for (const ts of byId.values()) {
      if (users && !users.has(ts.user_id as number)) continue;
      const shifts = dedupeById(Array.isArray(ts.shifts) ? (ts.shifts as Rec[]) : []).filter((sh) => {
        const d = itemDate(sh);
        return d !== null && d >= filter.from && d <= filter.to;
      });
      const shiftCost = shifts.reduce((sum, sh) => sum + (typeof sh.cost === 'number' ? sh.cost : 0), 0);
      const totalCost = shifts.length > 0 ? shiftCost : typeof ts.cost === 'number' ? ts.cost : 0;
      if (!filter.include_empty && shifts.length === 0 && !totalCost) continue;
      out.push({ ...ts, shifts, total_cost: Math.round(totalCost * 100) / 100 });
    }
    return out;
  }

  /**
   * Payroll export preview. skip_status_update is ALWAYS true so previewing never marks
   * timesheets as exported; approved_only is always true.
   */
  async getTimesheetExport(date: string, exportFormat: string): Promise<unknown> {
    return this.get(`/timesheets/on/${date}`, buildExportParams(exportFormat), { noCache: true, responseType: 'text' });
  }

  // ==================== Leave / unavailability ====================

  async getLeaveRequests(filter: { from: string; to: string; user_ids?: number[]; status?: string }): Promise<Rec[]> {
    const rows = await this.getChunked('/leave', filter.from, filter.to, { user_ids: filter.user_ids?.join(',') });
    return filter.status ? rows.filter((r) => r.status === filter.status) : rows;
  }

  async getLeaveBalances(userIds: number[]): Promise<Rec[]> {
    return this.getList('/leave_balances', { user_ids: userIds.join(',') });
  }

  async getLeaveTypes(userId: number): Promise<unknown> {
    return this.get(`/leave/types_for/${userId}`);
  }

  async getUnavailability(filter: { from: string; to: string; user_ids?: number[] }): Promise<Rec[]> {
    return this.getChunked('/unavailability', filter.from, filter.to, { user_ids: filter.user_ids?.join(',') });
  }

  // ==================== Derived ====================

  async getDailyStats(filter: { from: string; to: string; department_ids?: number[] }): Promise<TandaDailyStats[]> {
    const [schedules, shifts] = await Promise.all([
      this.getSchedules({ from: filter.from, to: filter.to, department_ids: filter.department_ids }),
      this.getShifts({ from: filter.from, to: filter.to }),
    ]);
    const dept = filter.department_ids?.length ? new Set(filter.department_ids) : null;
    return computeDailyStats(
      schedules,
      dept ? shifts.filter((s) => dept.has(s.department_id as number)) : shifts,
      filter.from,
      filter.to
    );
  }
}

/** Export query params. skip_status_update is hard-coded true and cannot be overridden. */
export function buildExportParams(exportFormat: string): Record<string, string> {
  return {
    export_format: exportFormat,
    approved_only: 'true',
    skip_status_update: 'true',
  };
}

/**
 * Aggregate schedules (scheduled) and shifts (worked) into per-date stats.
 * Tanda timestamps are unix SECONDS; hours = (finish - start - breaks) / 3600.
 */
export function computeDailyStats(
  schedules: Rec[],
  shifts: Rec[],
  from: string,
  to: string,
  timeZone = DEFAULT_TIMEZONE
): TandaDailyStats[] {
  const byDate = new Map<string, TandaDailyStats & { _users: Set<unknown> }>();
  const get = (date: string) => {
    let row = byDate.get(date);
    if (!row) {
      row = { date, scheduled_hours: 0, actual_hours: 0, headcount: 0, scheduled_shifts: 0, worked_shifts: 0, _users: new Set() };
      byDate.set(date, row);
    }
    return row;
  };
  for (const sc of schedules) {
    const date = itemDate(sc, timeZone);
    if (!date || date < from || date > to) continue;
    const row = get(date);
    row.scheduled_hours += itemHours(sc);
    row.scheduled_shifts = (row.scheduled_shifts || 0) + 1;
  }
  for (const sh of shifts) {
    const date = itemDate(sh, timeZone);
    if (!date || date < from || date > to) continue;
    const row = get(date);
    if (toUnixSeconds(sh.finish) !== null) row.actual_hours += itemHours(sh);
    row.worked_shifts = (row.worked_shifts || 0) + 1;
    row._users.add(sh.user_id);
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ _users, ...row }) => ({
      ...row,
      scheduled_hours: Math.round(row.scheduled_hours * 100) / 100,
      actual_hours: Math.round(row.actual_hours * 100) / 100,
      headcount: _users.size,
    }));
}

// ==================== OAuth helpers ====================

export async function exchangeCodeForToken(code: string): Promise<TandaTokenResponse> {
  const response = await axios.post<TandaTokenResponse>(config.TANDA_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: config.TANDA_CLIENT_ID,
    client_secret: config.TANDA_CLIENT_SECRET,
    redirect_uri: config.TANDA_REDIRECT_URI,
    code,
  });
  logger.info('Successfully exchanged authorization code for tokens');
  return response.data;
}

/** Spend a (single-use) Tanda refresh token for a new access + refresh token pair. */
export async function refreshTandaToken(refreshToken: string): Promise<TandaTokenResponse> {
  const response = await axios.post<TandaTokenResponse>(config.TANDA_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: config.TANDA_CLIENT_ID,
    client_secret: config.TANDA_CLIENT_SECRET,
    refresh_token: refreshToken,
    redirect_uri: config.TANDA_REDIRECT_URI,
  });
  logger.info('Tanda access token refreshed');
  return response.data;
}

export function buildAuthorizationUrl(state: string, scope?: string): string {
  // Least-privilege scopes from TANDA_SCOPES (financial/personal are always stripped)
  const params = new URLSearchParams({
    client_id: config.TANDA_CLIENT_ID,
    redirect_uri: config.TANDA_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: scope || config.TANDA_OAUTH_SCOPES.join(' '),
  });
  return `${config.TANDA_AUTH_URL}?${params.toString()}`;
}
