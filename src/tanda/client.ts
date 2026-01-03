import axios, { AxiosInstance, AxiosError } from 'axios';
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
  CreateScheduleRequest,
  UpdateScheduleRequest,
  CreateLeaveRequest,
  CreateUnavailabilityRequest,
  DateRangeFilter,
  ScheduleFilter,
  TimesheetFilter,
  UserFilter,
} from './types';

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

  constructor(accessToken: string, refreshToken?: string, expiresIn?: number) {
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
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - add auth token
    this.client.interceptors.request.use(
      (requestConfig) => {
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
    return response.data;
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
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));
    if (filter.department_ids?.length) params.append('department_ids', filter.department_ids.join(','));
    if (filter.show_costs) params.append('show_costs', 'true');

    const response = await this.client.get<TandaSchedule[]>('/schedules', { params });
    return response.data;
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

  async getShifts(filter: DateRangeFilter & { user_ids?: number[] }): Promise<TandaShift[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));

    const response = await this.client.get<TandaShift[]>('/shifts', { params });
    return response.data;
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

  async getTimesheets(filter: TimesheetFilter): Promise<TandaTimesheet[]> {
    // Tanda API: /timesheets/on/{date} for specific date, /timesheets/current for current period
    // We iterate through date range and aggregate results
    const params = new URLSearchParams();
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));
    if (filter.approved !== undefined) params.append('approved', String(filter.approved));
    if (filter.include_costs) params.append('show_costs', 'true');

    try {
      // Try /timesheets/on/{date} endpoint for each date in range
      const fromDate = new Date(filter.from);
      const toDate = new Date(filter.to);
      const allTimesheets: TandaTimesheet[] = [];

      // Iterate through dates
      const currentDate = new Date(fromDate);
      while (currentDate <= toDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        try {
          const response = await this.client.get<TandaTimesheet[]>(`/timesheets/on/${dateStr}`, { params });
          if (Array.isArray(response.data)) {
            allTimesheets.push(...response.data);
          }
        } catch {
          // Skip dates with no data
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      if (allTimesheets.length > 0) {
        return allTimesheets;
      }

      // Fallback: try /timesheets/current
      const currentResponse = await this.client.get<TandaTimesheet[]>('/timesheets/current', { params });
      return Array.isArray(currentResponse.data) ? currentResponse.data : [];
    } catch {
      // Final fallback to shifts endpoint
      logger.debug('Timesheets endpoint not available, using shifts');
      const shiftParams = new URLSearchParams({
        from: filter.from,
        to: filter.to,
      });
      if (filter.user_ids?.length) shiftParams.append('user_ids', filter.user_ids.join(','));
      const response = await this.client.get<TandaTimesheet[]>('/shifts', { params: shiftParams });
      return response.data;
    }
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
    // Get users filtered by department
    const response = await this.client.get<TandaUser[]>('/users', {
      params: { department_ids: departmentId.toString() },
    });
    return response.data;
  }

  // ==================== Daily Stats ====================

  async getDailyStats(filter: DateRangeFilter & { department_ids?: number[] }): Promise<TandaDailyStats[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.department_ids?.length) params.append('department_ids', filter.department_ids.join(','));

    try {
      // Try stats endpoint first
      const response = await this.client.get<TandaDailyStats[]>('/stats/daily', { params });
      return response.data;
    } catch {
      try {
        // Alternative: reports endpoint
        const response = await this.client.get<TandaDailyStats[]>('/reports/daily', { params });
        return response.data;
      } catch {
        // Fall back to computing from schedules and shifts
        logger.debug('Daily stats endpoint not available, computing from schedules');
        const [schedules, shifts] = await Promise.all([
          this.getSchedules({ ...filter }),
          this.getShifts(filter),
        ]);

        // Aggregate by date
        const statsByDate = new Map<string, TandaDailyStats>();

        for (const schedule of schedules) {
          // Handle both Unix timestamps (number) and ISO strings
          const startValue = schedule.start;
          const startDate = typeof startValue === 'number'
            ? new Date(startValue * 1000)
            : new Date(startValue);
          const date = startDate.toISOString().split('T')[0];

          const existing = statsByDate.get(date) || {
            date,
            scheduled_hours: 0,
            actual_hours: 0,
            headcount: 0,
          };
          // Calculate scheduled hours
          const finishValue = schedule.finish;
          const finish = typeof finishValue === 'number'
            ? new Date(finishValue * 1000)
            : new Date(finishValue);
          const hours = (finish.getTime() - startDate.getTime()) / (1000 * 60 * 60);
          existing.scheduled_hours += hours;
          existing.headcount += 1;
          statsByDate.set(date, existing);
        }

        for (const shift of shifts) {
          const date = shift.date;
          const existing = statsByDate.get(date) || {
            date,
            scheduled_hours: 0,
            actual_hours: 0,
            headcount: 0,
          };
          if (shift.finish) {
            const start = new Date(shift.start);
            const finish = new Date(shift.finish);
            const hours = (finish.getTime() - start.getTime()) / (1000 * 60 * 60);
            existing.actual_hours += hours;
          }
          statsByDate.set(date, existing);
        }

        return Array.from(statsByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
      }
    }
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

  // ==================== Data Streams ====================

  async getDataStream(streamType: string, filter?: DateRangeFilter): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filter?.from) params.append('from', filter.from);
    if (filter?.to) params.append('to', filter.to);

    const response = await this.client.get(`/datastreams/${streamType}`, { params });
    return response.data;
  }
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
  // Tanda requires the scope parameter - use provided scope or default to common scopes
  // Note: qualification and device scopes are not supported by Workforce.com OAuth
  const defaultScopes = 'me user department leave roster timesheet cost';

  const params = new URLSearchParams({
    client_id: config.TANDA_CLIENT_ID,
    redirect_uri: config.TANDA_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: scope || defaultScopes,
  });

  return `${config.TANDA_AUTH_URL}?${params.toString()}`;
}
