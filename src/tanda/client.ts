import axios, { AxiosInstance, AxiosError, AxiosAdapter } from 'axios';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import {
  TandaTokenResponse,
  TandaUser,
  TandaDepartment,
  TandaLocation,
  TandaSchedule,
  TandaShift,
  TandaTimesheet,
  TandaLeaveRequest,
  TandaLeaveBalance,
  TandaAwardInterpretation,
  TandaRosterCost,
  TandaUnavailability,
  TandaTeam,
  TandaDailyStats,
  TandaClockIn,
  TandaQualification,
  TandaUserQualification,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  CreateLeaveRequest,
  CreateUnavailabilityRequest,
  DateRangeFilter,
  ScheduleFilter,
  TimesheetFilter,
  UserFilter,
  // v3.0 New Types
  TandaActiveShift,
  TandaRoster,
  TandaLeaveType,
  TandaLeaveHoursResult,
  TandaShiftBreak,
  TandaShiftLimits,
  OnboardUserRequest,
  TandaOnboardingResult,
  TandaBulkOnboardingResult,
  TandaUserInviteResult,
} from './types';
import { tandaRateLimiter } from './rateLimiter';
import { chunkDateRange, toUnixSeconds, addDays, DEFAULT_TIMEZONE } from '../utils/time';
import { dedupeById, itemDate, itemHours } from './normalize';

export interface TandaClientOptions {
  /** Custom axios adapter (used by tests to stub Tanda). */
  adapter?: AxiosAdapter;
  /** Skip the shared rate limiter (tests only). */
  disableRateLimit?: boolean;
}

/** Tanda rejects date ranges longer than this on list endpoints. */
export const TANDA_MAX_RANGE_DAYS = 7;

export class TandaApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'TandaApiError';
  }
}

export class TandaClient {
  private client: AxiosInstance;
  private accessToken: string;
  private refreshToken?: string;
  private tokenExpiresAt?: number;

  private readonly options: TandaClientOptions;

  constructor(accessToken: string, refreshToken?: string, expiresIn?: number, options: TandaClientOptions = {}) {
    this.options = options;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (expiresIn) {
      this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    }

    this.client = axios.create({
      baseURL: config.TANDA_API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - add auth token
    this.client.interceptors.request.use(
      async (requestConfig) => {
        // This server is read-only: never send a mutating request to Tanda.
        const method = (requestConfig.method || 'get').toLowerCase();
        if (method !== 'get' && method !== 'head') {
          return Promise.reject(
            new TandaApiError(`Read-only server: ${method.toUpperCase()} requests to Tanda are disabled`, 403)
          );
        }
        if (!this.options.disableRateLimit) await tandaRateLimiter.acquire();
        requestConfig.headers.Authorization = `Bearer ${this.accessToken}`;
        logger.debug(`Tanda API Request: ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`);
        return requestConfig;
      },
      (error) => {
        logger.error('Tanda API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor - handle errors and token refresh
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`Tanda API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      async (error: AxiosError) => {
        if (error instanceof TandaApiError) throw error;
        if (error.response?.status === 401 && this.refreshToken) {
          try {
            await this.refreshAccessToken();
            const originalRequest = error.config;
            if (originalRequest) {
              originalRequest.headers.Authorization = `Bearer ${this.accessToken}`;
              return this.client(originalRequest);
            }
          } catch (refreshError) {
            logger.error('Token refresh failed:', refreshError);
          }
        }
        return this.handleApiError(error);
      }
    );
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new TandaApiError('No refresh token available', 401);
    }

    const response = await axios.post<TandaTokenResponse>(config.TANDA_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: config.TANDA_CLIENT_ID,
      client_secret: config.TANDA_CLIENT_SECRET,
      refresh_token: this.refreshToken,
    });

    this.accessToken = response.data.access_token;
    this.refreshToken = response.data.refresh_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
    logger.info('Tanda access token refreshed successfully');
  }

  private handleApiError(error: AxiosError): never {
    const statusCode = error.response?.status || 500;
    const message = this.extractErrorMessage(error);
    logger.error(`Tanda API Error: ${statusCode} - ${message}`);
    throw new TandaApiError(message, statusCode, error);
  }

  private extractErrorMessage(error: AxiosError): string {
    if (error.response?.data) {
      const data = error.response.data as Record<string, unknown>;
      if (typeof data.error === 'string') return data.error;
      if (typeof data.message === 'string') return data.message;
      if (Array.isArray(data.errors)) return data.errors.join(', ');
    }
    return error.message || 'Unknown Tanda API error';
  }

  // Token info
  getTokenInfo(): { accessToken: string; expiresAt?: number } {
    return {
      accessToken: this.accessToken,
      expiresAt: this.tokenExpiresAt,
    };
  }

  /**
   * GET a date-ranged list endpoint, splitting from..to into <= 7-day windows so Tanda's
   * range limit is never hit. Results are merged and de-duplicated by id.
   */
  private async getChunked<T extends { id?: unknown }>(
    path: string,
    from: string,
    to: string,
    extra: Record<string, string> = {}
  ): Promise<T[]> {
    const all: T[] = [];
    for (const chunk of chunkDateRange(from, to, TANDA_MAX_RANGE_DAYS)) {
      const params = new URLSearchParams({ from: chunk.from, to: chunk.to, ...extra });
      const response = await this.client.get<T[]>(path, { params });
      if (Array.isArray(response.data)) all.push(...response.data);
    }
    return dedupeById(all);
  }

  // ==================== Users ====================

  async getCurrentUser(): Promise<TandaUser> {
    const response = await this.client.get<TandaUser>('/users/me');
    return response.data;
  }

  async getUsers(filter?: UserFilter): Promise<TandaUser[]> {
    const params = new URLSearchParams();
    if (filter?.active !== undefined) params.append('active', String(filter.active));
    if (filter?.department_ids?.length) params.append('department_ids', filter.department_ids.join(','));

    const response = await this.client.get<TandaUser[]>('/users', { params });
    const users = Array.isArray(response.data) ? response.data : [];
    // Tanda may ignore department_ids; enforce it client-side
    if (filter?.department_ids?.length) {
      const wanted = new Set(filter.department_ids);
      return users.filter((u) => (u.department_ids || []).some((id) => wanted.has(id)));
    }
    return users;
  }

  async getUser(userId: number): Promise<TandaUser> {
    const response = await this.client.get<TandaUser>(`/users/${userId}`);
    return response.data;
  }

  async updateUser(userId: number, data: Partial<TandaUser>): Promise<TandaUser> {
    const response = await this.client.put<TandaUser>(`/users/${userId}`, data);
    return response.data;
  }

  // ==================== Departments ====================

  async getDepartments(): Promise<TandaDepartment[]> {
    const response = await this.client.get<TandaDepartment[]>('/departments');
    return response.data;
  }

  async getDepartment(departmentId: number): Promise<TandaDepartment> {
    const response = await this.client.get<TandaDepartment>(`/departments/${departmentId}`);
    return response.data;
  }

  // ==================== Locations ====================

  async getLocations(): Promise<TandaLocation[]> {
    const response = await this.client.get<TandaLocation[]>('/locations');
    return response.data;
  }

  async getLocation(locationId: number): Promise<TandaLocation> {
    const response = await this.client.get<TandaLocation>(`/locations/${locationId}`);
    return response.data;
  }

  // ==================== Schedules (Rosters) ====================

  async getSchedules(filter: ScheduleFilter): Promise<TandaSchedule[]> {
    const extra: Record<string, string> = {};
    if (filter.user_ids?.length) extra.user_ids = filter.user_ids.join(',');
    if (filter.department_ids?.length) extra.department_ids = filter.department_ids.join(',');
    if (filter.show_costs) extra.show_costs = 'true';
    if (filter.include_names) extra.include_names = 'true';
    return this.getChunked<TandaSchedule>('/schedules', filter.from, filter.to, extra);
  }

  async getSchedule(scheduleId: number): Promise<TandaSchedule> {
    const response = await this.client.get<TandaSchedule>(`/schedules/${scheduleId}`);
    return response.data;
  }

  async createSchedule(data: CreateScheduleRequest): Promise<TandaSchedule> {
    const response = await this.client.post<TandaSchedule>('/schedules', data);
    return response.data;
  }

  async updateSchedule(scheduleId: number, data: UpdateScheduleRequest): Promise<TandaSchedule> {
    const response = await this.client.put<TandaSchedule>(`/schedules/${scheduleId}`, data);
    return response.data;
  }

  async deleteSchedule(scheduleId: number): Promise<void> {
    await this.client.delete(`/schedules/${scheduleId}`);
  }

  async publishSchedules(from: string, to: string, departmentIds?: number[]): Promise<void> {
    const data: Record<string, unknown> = { from, to };
    if (departmentIds?.length) data.department_ids = departmentIds;
    await this.client.post('/schedules/publish', data);
  }

  // ==================== Shifts (Timesheets) ====================

  async getShifts(filter: DateRangeFilter & { user_ids?: number[]; show_costs?: boolean; show_award_interpretation?: boolean }): Promise<TandaShift[]> {
    const extra: Record<string, string> = {};
    if (filter.user_ids?.length) extra.user_ids = filter.user_ids.join(',');
    if (filter.show_costs) extra.show_costs = 'true';
    if (filter.show_award_interpretation) extra.show_award_interpretation = 'true';
    return this.getChunked<TandaShift>('/shifts', filter.from, filter.to, extra);
  }

  async getShift(shiftId: number): Promise<TandaShift> {
    const response = await this.client.get<TandaShift>(`/shifts/${shiftId}`);
    return response.data;
  }

  async approveShift(shiftId: number): Promise<TandaShift> {
    const response = await this.client.post<TandaShift>(`/shifts/${shiftId}/approve`);
    return response.data;
  }

  // ==================== Timesheets ====================

  /**
   * Timesheets overlapping from..to. GET /timesheets/on/{date} returns the whole pay
   * period containing {date}, so we query once per pay period (jumping past each
   * period's finish), de-duplicate by timesheet id, and keep only shifts inside the range.
   * Timesheets with no shifts in range and zero cost are dropped unless include_empty.
   */
  async getTimesheets(filter: TimesheetFilter): Promise<TandaTimesheet[]> {
    const params = new URLSearchParams();
    if (filter.include_costs !== false) params.append('show_costs', 'true');
    if (filter.include_award_interpretation) params.append('show_award_interpretation', 'true');

    const byId = new Map<number, TandaTimesheet>();
    let date = filter.from;
    let guard = 0;
    while (date <= filter.to && guard++ < 62) {
      const response = await this.client.get<TandaTimesheet[]>(`/timesheets/on/${date}`, { params });
      const sheets = Array.isArray(response.data) ? response.data : [];
      let periodEnd: string | null = null;
      for (const ts of sheets) {
        if (!byId.has(ts.id)) byId.set(ts.id, ts);
        const finish = typeof ts.finish === 'string' ? ts.finish.slice(0, 10) : null;
        if (finish && /^\d{4}-\d{2}-\d{2}$/.test(finish) && (!periodEnd || finish < periodEnd)) periodEnd = finish;
      }
      // Next query: the day after the earliest period end (pay periods can differ per user)
      date = periodEnd && periodEnd >= date ? addDays(periodEnd, 1) : addDays(date, 1);
    }

    const userFilter = filter.user_ids?.length ? new Set(filter.user_ids) : null;
    const result: TandaTimesheet[] = [];
    for (const ts of byId.values()) {
      if (userFilter && !userFilter.has(ts.user_id)) continue;
      if (filter.approved !== undefined) {
        const approved = ts.status === 'approved' || ts.status === 'exported' || ts.approved === true;
        if (approved !== filter.approved) continue;
      }
      const shifts = dedupeById(Array.isArray(ts.shifts) ? ts.shifts : []).filter((sh) => {
        const d = itemDate(sh as unknown as Record<string, unknown>);
        return d !== null && d >= filter.from && d <= filter.to;
      });
      const cost = shifts.reduce((sum, sh) => sum + (typeof sh.cost === 'number' ? sh.cost : 0), 0);
      const totalCost = shifts.length > 0 ? cost : (typeof ts.cost === 'number' ? ts.cost : 0);
      if (!filter.include_empty && shifts.length === 0 && !totalCost) continue;
      result.push({ ...ts, shifts, total_cost: Math.round(totalCost * 100) / 100 });
    }
    return result;
  }

  async getTimesheet(timesheetId: number): Promise<TandaTimesheet> {
    const response = await this.client.get<TandaTimesheet>(`/timesheets/${timesheetId}`);
    return response.data;
  }

  async approveTimesheet(timesheetId: number): Promise<TandaTimesheet> {
    const response = await this.client.post<TandaTimesheet>(`/timesheets/${timesheetId}/approve`);
    return response.data;
  }

  // ==================== Leave ====================

  async getLeaveRequests(filter?: Partial<DateRangeFilter> & { user_ids?: number[]; status?: string }): Promise<TandaLeaveRequest[]> {
    const params = new URLSearchParams();
    if (filter?.from) params.append('from', filter.from);
    if (filter?.to) params.append('to', filter.to);
    if (filter?.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));
    if (filter?.status) params.append('status', filter.status);

    const response = await this.client.get<TandaLeaveRequest[]>('/leave', { params });
    return response.data;
  }

  async getLeaveRequest(leaveId: number): Promise<TandaLeaveRequest> {
    const response = await this.client.get<TandaLeaveRequest>(`/leave/${leaveId}`);
    return response.data;
  }

  async createLeaveRequest(data: CreateLeaveRequest): Promise<TandaLeaveRequest> {
    const response = await this.client.post<TandaLeaveRequest>('/leave', data);
    return response.data;
  }

  async approveLeaveRequest(leaveId: number): Promise<TandaLeaveRequest> {
    const response = await this.client.post<TandaLeaveRequest>(`/leave/${leaveId}/approve`);
    return response.data;
  }

  async declineLeaveRequest(leaveId: number, reason?: string): Promise<TandaLeaveRequest> {
    const response = await this.client.post<TandaLeaveRequest>(`/leave/${leaveId}/decline`, { reason });
    return response.data;
  }

  async deleteLeaveRequest(leaveId: number): Promise<void> {
    await this.client.delete(`/leave/${leaveId}`);
  }

  async getLeaveBalances(userId: number): Promise<TandaLeaveBalance[]> {
    // Tanda API: GET /leave_balances?user_ids= (requires 'leave' scope)
    try {
      // Primary endpoint: /leave_balances with user_ids parameter (plural)
      const response = await this.client.get<TandaLeaveBalance[]>('/leave_balances', {
        params: { user_ids: userId.toString() },
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch {
      try {
        // Alternative: Get leave requests and extract balance info
        const leaveRequests = await this.getLeaveRequests({ user_ids: [userId] });
        // Extract unique leave types from requests as pseudo-balances
        const balanceMap = new Map<string, TandaLeaveBalance>();
        for (const req of leaveRequests) {
          const leaveType = req.leave_type || 'unknown';
          if (!balanceMap.has(leaveType)) {
            balanceMap.set(leaveType, {
              id: 0,
              user_id: userId,
              leave_type: leaveType,
              balance: 0, // Cannot determine actual balance without endpoint
              unit: 'hours',
            });
          }
        }
        if (balanceMap.size > 0) {
          logger.debug(`Leave balances derived from ${leaveRequests.length} leave requests`);
          return Array.from(balanceMap.values());
        }
        logger.warn(`Leave balances endpoint not available for user ${userId}`);
        return [];
      } catch {
        logger.warn(`Leave balances endpoint not available for user ${userId}`);
        return [];
      }
    }
  }

  // ==================== Unavailability ====================

  async getUnavailability(filter: DateRangeFilter & { user_ids?: number[] }): Promise<TandaUnavailability[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));

    try {
      const response = await this.client.get<TandaUnavailability[]>('/unavailabilities', { params });
      return response.data;
    } catch {
      // Alternative endpoint name
      try {
        const response = await this.client.get<TandaUnavailability[]>('/unavailability', { params });
        return response.data;
      } catch {
        logger.warn('Unavailability endpoint not available');
        return [];
      }
    }
  }

  async createUnavailability(data: CreateUnavailabilityRequest): Promise<TandaUnavailability> {
    const response = await this.client.post<TandaUnavailability>('/unavailabilities', data);
    return response.data;
  }

  async deleteUnavailability(unavailabilityId: number): Promise<void> {
    await this.client.delete(`/unavailabilities/${unavailabilityId}`);
  }

  // ==================== Teams ====================
  // Note: In Tanda/Workforce.com API, "Teams" are the same as "Departments"
  // The /teams endpoint doesn't exist - we use /departments instead

  async getTeams(): Promise<TandaTeam[]> {
    // Teams in Tanda are implemented as Departments
    // Map departments to team format for compatibility
    try {
      const departments = await this.getDepartments();
      return departments.map(dept => ({
        id: dept.id,
        name: dept.name,
        department_id: dept.id,
        colour: dept.colour,
        // Map other department fields to team fields
      }));
    } catch (error) {
      logger.warn('Unable to fetch teams (departments):', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  async getTeam(teamId: number): Promise<TandaTeam> {
    // Teams are departments in Tanda
    const dept = await this.getDepartment(teamId);
    return {
      id: dept.id,
      name: dept.name,
      department_id: dept.id,
      colour: dept.colour,
    };
  }

  // ==================== Staff by Department ====================

  async getStaffByDepartment(departmentId: number): Promise<TandaUser[]> {
    // /users?department_ids is not reliably filtered by Tanda; the department's
    // `staff` array is the source of truth for membership.
    const [department, users] = await Promise.all([
      this.getDepartment(departmentId),
      this.client.get<TandaUser[]>('/users').then((r) => (Array.isArray(r.data) ? r.data : [])),
    ]);
    const staff = new Set(department.staff || []);
    return users.filter((u) => staff.has(u.id));
  }

  // ==================== Daily Stats ====================

  /**
   * Scheduled vs worked hours per local date. Computed from /schedules and /shifts.
   * Tanda timestamps are unix SECONDS; hours = (finish - start - breaks) / 3600.
   */
  async getDailyStats(filter: DateRangeFilter & { department_ids?: number[] }): Promise<TandaDailyStats[]> {
    const [schedules, shifts] = await Promise.all([
      this.getSchedules({ from: filter.from, to: filter.to, department_ids: filter.department_ids }),
      this.getShifts({ from: filter.from, to: filter.to }),
    ]);
    const deptFilter = filter.department_ids?.length ? new Set(filter.department_ids) : null;
    return computeDailyStats(
      schedules as unknown as Record<string, unknown>[],
      (deptFilter ? shifts.filter((s) => s.department_id && deptFilter.has(s.department_id)) : shifts) as unknown as Record<string, unknown>[],
      filter.from,
      filter.to
    );
  }

  // ==================== Award Interpretation ====================

  async getAwardInterpretation(filter: DateRangeFilter & { user_ids?: number[] }): Promise<TandaAwardInterpretation[]> {
    // Tanda API: Award interpretation is available via ?show_award_interpretation=true on shifts
    // Requires 'cost' scope in addition to 'timesheet' scope
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
      show_award_interpretation: 'true',
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));

    try {
      // Get shifts with award interpretation data
      const response = await this.client.get<TandaShift[]>('/shifts', { params });

      // Extract and format award interpretation data from shifts
      const interpretations: TandaAwardInterpretation[] = [];
      for (const shift of response.data) {
        if (shift.award_interpretation) {
          interpretations.push({
            id: shift.id,
            user_id: shift.user_id,
            date: shift.date,
            shift_id: shift.id,
            award_interpretation: shift.award_interpretation,
            cost: shift.cost,
          });
        }
      }
      return interpretations;
    } catch (error) {
      // Log specific error for debugging
      logger.warn('Award interpretation not available:', error instanceof Error ? error.message : 'Unknown error');
      logger.debug('Award interpretation requires "cost" OAuth scope');
      return [];
    }
  }

  // ==================== Roster Costs ====================

  async getRosterCosts(filter: DateRangeFilter & { department_ids?: number[] }): Promise<TandaRosterCost[]> {
    // Tanda API: Use /rosters/on/{date}?show_costs=true or /rosters/current?show_costs=true
    // Requires 'roster' and 'cost' scopes
    try {
      // Try getting rosters with costs for date range
      const fromDate = new Date(filter.from);
      const toDate = new Date(filter.to);
      const allCosts: TandaRosterCost[] = [];

      // Iterate through dates to get roster costs
      const currentDate = new Date(fromDate);
      while (currentDate <= toDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        try {
          const params = new URLSearchParams({ show_costs: 'true' });
          if (filter.department_ids?.length) {
            params.append('department_ids', filter.department_ids.join(','));
          }
          const response = await this.client.get<TandaRosterCost>(`/rosters/on/${dateStr}`, { params });
          if (response.data) {
            // Add date to the cost record
            allCosts.push({
              ...response.data,
              date: dateStr,
            });
          }
        } catch {
          // Skip dates without roster data
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      if (allCosts.length > 0) {
        return allCosts;
      }

      // Fallback: Get schedules with show_costs=true and aggregate
      const scheduleParams = new URLSearchParams({
        from: filter.from,
        to: filter.to,
        show_costs: 'true',
      });
      if (filter.department_ids?.length) {
        scheduleParams.append('department_ids', filter.department_ids.join(','));
      }

      const schedules = await this.client.get<TandaSchedule[]>('/schedules', { params: scheduleParams });

      // Aggregate costs by date from schedules
      const costsByDate = new Map<string, { date: string; cost: number; schedules_count: number }>();
      for (const schedule of schedules.data) {
        const startValue = schedule.start;
        const startDate = typeof startValue === 'number'
          ? new Date(startValue * 1000)
          : new Date(startValue);
        const dateStr = startDate.toISOString().split('T')[0];

        const existing = costsByDate.get(dateStr) || {
          date: dateStr,
          cost: 0,
          schedules_count: 0,
        };
        existing.cost += schedule.cost || 0;
        existing.schedules_count += 1;
        costsByDate.set(dateStr, existing);
      }

      return Array.from(costsByDate.values());
    } catch (error) {
      logger.warn('Roster costs not available:', error instanceof Error ? error.message : 'Unknown error');
      logger.debug('Roster costs require "roster" and "cost" OAuth scopes');
      return [];
    }
  }

  // Note: Clock In/Out and Qualifications methods removed - require OAuth scopes not supported by Workforce.com
  // See docs/FIT_GAP_ANALYSIS.md for details on OAuth scope limitations

  // ==================== v3.0 New Methods ====================

  // ==================== Active Shifts (Real-time) ====================

  async getActiveShifts(): Promise<TandaActiveShift[]> {
    // GET /shifts/active - requires timesheet scope
    try {
      const response = await this.client.get<TandaActiveShift[]>('/shifts/active');
      return response.data;
    } catch (error) {
      logger.warn('Active shifts endpoint not available:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  async getClockedInUsers(): Promise<TandaUser[]> {
    // GET /users/clocked_in - requires user scope
    try {
      const response = await this.client.get<TandaUser[]>('/users/clocked_in');
      return response.data;
    } catch (error) {
      logger.warn('Clocked-in users endpoint not available:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  async getShiftBreaks(shiftId: number): Promise<TandaShiftBreak[]> {
    // GET /shifts/{id}/breaks - requires timesheet scope
    try {
      const response = await this.client.get<TandaShiftBreak[]>(`/shifts/${shiftId}/breaks`);
      return response.data;
    } catch (error) {
      logger.warn(`Shift breaks not available for shift ${shiftId}:`, error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  async getShiftLimits(userIds?: number[]): Promise<TandaShiftLimits[]> {
    // GET /shifts/limits - requires timesheet scope
    try {
      const params = new URLSearchParams();
      if (userIds?.length) params.append('user_ids', userIds.join(','));

      const response = await this.client.get<TandaShiftLimits[]>('/shifts/limits', { params });
      return response.data;
    } catch (error) {
      logger.warn('Shift limits endpoint not available:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  // ==================== Rosters (Roster Periods) ====================

  async getRoster(rosterId: number): Promise<TandaRoster> {
    // GET /rosters/{id} - requires roster scope
    const response = await this.client.get<TandaRoster>(`/rosters/${rosterId}`);
    return response.data;
  }

  async getCurrentRoster(showCosts?: boolean): Promise<TandaRoster> {
    // GET /rosters/current - requires roster scope
    const params = new URLSearchParams();
    if (showCosts) params.append('show_costs', 'true');

    const response = await this.client.get<TandaRoster>('/rosters/current', { params });
    return response.data;
  }

  async getRosterByDate(date: string, showCosts?: boolean): Promise<TandaRoster | null> {
    // GET /rosters/on/{date} - requires roster scope
    // Returns 204 if no roster exists for that date
    try {
      const params = new URLSearchParams();
      if (showCosts) params.append('show_costs', 'true');

      const response = await this.client.get<TandaRoster>(`/rosters/on/${date}`, { params });
      return response.data;
    } catch (error) {
      if (error instanceof TandaApiError && error.statusCode === 204) {
        return null;
      }
      throw error;
    }
  }

  // ==================== Inactive Users ====================

  async getInactiveUsers(): Promise<TandaUser[]> {
    // GET /users/inactive - requires user scope
    try {
      const response = await this.client.get<TandaUser[]>('/users/inactive');
      return response.data;
    } catch (error) {
      logger.warn('Inactive users endpoint not available:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  // ==================== User Onboarding ====================

  async onboardUsers(users: OnboardUserRequest[]): Promise<TandaBulkOnboardingResult> {
    // POST /users/onboarding - requires user scope
    try {
      const response = await this.client.post<TandaBulkOnboardingResult>('/users/onboarding', { users });
      return response.data;
    } catch (error) {
      logger.error('User onboarding failed:', error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  async inviteUser(userId: number): Promise<TandaUserInviteResult> {
    // POST /users/{id}/invite - requires user scope
    const response = await this.client.post<TandaUserInviteResult>(`/users/${userId}/invite`);
    return response.data;
  }

  // ==================== Leave Types ====================

  async getLeaveTypes(userId: number): Promise<TandaLeaveType[]> {
    // GET /leave/types_for/{user_id} - requires leave scope
    try {
      const response = await this.client.get<TandaLeaveType[]>(`/leave/types_for/${userId}`);
      return response.data;
    } catch (error) {
      logger.warn(`Leave types not available for user ${userId}:`, error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  async calculateLeaveHours(
    userId: number,
    start: string,
    finish: string,
    leaveType: string
  ): Promise<TandaLeaveHoursResult> {
    // GET /leave/hours_between - requires leave scope
    const params = new URLSearchParams({
      user_id: userId.toString(),
      start,
      finish,
      leave_type: leaveType,
    });

    const response = await this.client.get<TandaLeaveHoursResult>('/leave/hours_between', { params });
    return response.data;
  }

  // ==================== Data Streams ====================

  async getDataStream(streamType: string, filter?: DateRangeFilter): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filter?.from) params.append('from', filter.from);
    if (filter?.to) params.append('to', filter.to);

    const response = await this.client.get(`/datastreams/${streamType}`, { params });
    return response.data;
  }
}

/** Aggregate schedules (scheduled) and shifts (worked) into per-date stats. Exported for tests. */
export function computeDailyStats(
  schedules: Record<string, unknown>[],
  shifts: Record<string, unknown>[],
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

// OAuth Helper Functions
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

export function buildAuthorizationUrl(state: string, scope?: string): string {
  // Least-privilege scopes from TANDA_SCOPES (financial/personal are always stripped)
  const defaultScopes = config.TANDA_OAUTH_SCOPES.join(' ');

  const params = new URLSearchParams({
    client_id: config.TANDA_CLIENT_ID,
    redirect_uri: config.TANDA_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: scope || defaultScopes,
  });

  return `${config.TANDA_AUTH_URL}?${params.toString()}`;
}
