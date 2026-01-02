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
  TandaClockIn,
  TandaQualification,
  TandaUserQualification,
  TandaAwardInterpretation,
  TandaRosterCost,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  CreateLeaveRequest,
  ClockInRequest,
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
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));
    if (filter.approved !== undefined) params.append('approved', String(filter.approved));
    if (filter.include_costs) params.append('include_costs', 'true');

    const response = await this.client.get<TandaTimesheet[]>('/timesheets', { params });
    return response.data;
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

  async getLeaveBalances(userId: number): Promise<TandaLeaveBalance[]> {
    const response = await this.client.get<TandaLeaveBalance[]>(`/users/${userId}/leave_balances`);
    return response.data;
  }

  // ==================== Clock In/Out ====================

  async clockIn(data: ClockInRequest): Promise<TandaClockIn> {
    const response = await this.client.post<TandaClockIn>('/clockins', data);
    return response.data;
  }

  async getClockIns(filter: DateRangeFilter & { user_ids?: number[] }): Promise<TandaClockIn[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));

    const response = await this.client.get<TandaClockIn[]>('/clockins', { params });
    return response.data;
  }

  // ==================== Qualifications ====================

  async getQualifications(): Promise<TandaQualification[]> {
    const response = await this.client.get<TandaQualification[]>('/qualifications');
    return response.data;
  }

  async getUserQualifications(userId: number): Promise<TandaUserQualification[]> {
    const response = await this.client.get<TandaUserQualification[]>(`/users/${userId}/qualifications`);
    return response.data;
  }

  // ==================== Award Interpretation ====================

  async getAwardInterpretation(filter: DateRangeFilter & { user_ids?: number[] }): Promise<TandaAwardInterpretation[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.user_ids?.length) params.append('user_ids', filter.user_ids.join(','));

    const response = await this.client.get<TandaAwardInterpretation[]>('/award_interpretations', { params });
    return response.data;
  }

  // ==================== Roster Costs ====================

  async getRosterCosts(filter: DateRangeFilter & { department_ids?: number[] }): Promise<TandaRosterCost[]> {
    const params = new URLSearchParams({
      from: filter.from,
      to: filter.to,
    });
    if (filter.department_ids?.length) params.append('department_ids', filter.department_ids.join(','));

    const response = await this.client.get<TandaRosterCost[]>('/rosters/costs', { params });
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
  const params = new URLSearchParams({
    client_id: config.TANDA_CLIENT_ID,
    redirect_uri: config.TANDA_REDIRECT_URI,
    response_type: 'code',
    state,
  });

  if (scope) {
    params.append('scope', scope);
  }

  return `${config.TANDA_AUTH_URL}?${params.toString()}`;
}
