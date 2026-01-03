// Tanda API Types

export interface TandaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

export interface TandaUser {
  id: number;
  name: string;
  email: string;
  photo?: string;
  phone?: string;
  normalised_phone?: string;
  date_of_birth?: string;
  employment_start_date?: string;
  employment_end_date?: string;
  user_levels?: number[];
  preferred_hours?: number;
  award_template_id?: number;
  award_tag_ids?: number[];
  report_department_id?: number;
  managed_department_ids?: number[];
  time_zone?: string;
  utc_offset?: number;
  created_at?: string;
  updated_at?: string;
  active: boolean;
}

export interface TandaDepartment {
  id: number;
  name: string;
  colour?: string;
  staff?: number[];
  managers?: number[];
  export_name?: string;
  location_id?: number;
}

export interface TandaLocation {
  id: number;
  name: string;
  short_name?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  time_zone?: string;
  public_holiday_regions?: string[];
}

export interface TandaSchedule {
  id: number;
  user_id?: number;
  department_id?: number;
  start: string | number; // Can be ISO string or Unix timestamp
  finish: string | number; // Can be ISO string or Unix timestamp
  breaks?: TandaBreak[];
  shift_detail_id?: number;
  automatic_break_length?: number;
  record_id?: number;
  last_published_at?: string;
  needs_acceptance?: boolean;
  creation_method?: string;
  creation_platform?: string;
  accepted?: boolean;
  creation_user_id?: number;
  notes?: string;
  cost?: number; // Cost when show_costs=true
}

export interface TandaBreak {
  id?: number;
  start?: string;
  finish?: string;
  length?: number;
  paid?: boolean;
}

export interface TandaShift {
  id: number;
  user_id: number;
  date: string;
  start: string;
  finish?: string;
  breaks?: TandaBreak[];
  department_id?: number;
  status?: string;
  allowances?: TandaAllowance[];
  tag_ids?: number[];
  notes?: string;
  record_id?: number;
  approved?: boolean;
  cost?: number;
  metadata?: Record<string, unknown>;
  // Award interpretation data (when requested with show_award_interpretation=true)
  award_interpretation?: Record<string, unknown>;
}

export interface TandaAllowance {
  id: number;
  value: number;
  cost?: number;
}

export interface TandaTimesheet {
  id: number;
  user_id: number;
  date: string;
  shifts: TandaShift[];
  status: string;
  approved: boolean;
  approver_id?: number;
  approved_at?: string;
  cost?: number;
}

export interface TandaLeaveRequest {
  id: number;
  user_id: number;
  leave_type?: string;
  status: 'pending' | 'approved' | 'declined';
  start: string;
  finish: string;
  hours?: number;
  reason?: string;
  approver_id?: number;
  approved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TandaLeaveBalance {
  id: number;
  user_id: number;
  leave_type: string;
  balance: number;
  accrued?: number;
  taken?: number;
  pending?: number;
  unit?: string; // 'hours' or 'days'
}

export interface TandaClockIn {
  id: number;
  user_id: number;
  time: string;
  type: 'start' | 'finish' | 'break_start' | 'break_finish';
  device_id?: number;
  photo?: string;
  latitude?: number;
  longitude?: number;
  ip_address?: string;
}

export interface TandaQualification {
  id: number;
  name: string;
  description?: string;
  expiry_warning_days?: number;
  required_for_department_ids?: number[];
}

export interface TandaUserQualification {
  id: number;
  user_id: number;
  qualification_id: number;
  expires_at?: string;
  file_id?: number;
  enabled: boolean;
}

export interface TandaAwardInterpretation {
  id?: number;
  date: string;
  user_id: number;
  shift_id?: number;
  ordinary_hours?: number;
  cost?: number;
  leave_hours?: number;
  overtime?: number;
  allowances?: TandaAllowance[];
  award_interpretation?: Record<string, unknown>; // Raw data from API
}

export interface TandaRosterCost {
  date: string;
  department_id?: number;
  total_cost?: number;
  wages_cost?: number;
  allowances_cost?: number;
  total_hours?: number;
  cost?: number; // Alternative field name
  schedules_count?: number; // Number of schedules aggregated
}

export interface TandaUnavailability {
  id: number;
  user_id: number;
  title?: string;
  start: string;
  finish: string;
  repeating?: boolean;
  repeating_info?: {
    frequency: string;
    interval?: number;
    end_date?: string;
  };
  created_at?: string;
  updated_at?: string;
}

export interface TandaTeam {
  id: number;
  name: string;
  department_id?: number; // Teams are mapped from departments
  department_ids?: number[];
  user_ids?: number[];
  managers?: number[];
  colour?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TandaDailyStats {
  date: string;
  department_id?: number;
  scheduled_hours: number;
  actual_hours: number;
  scheduled_cost?: number;
  actual_cost?: number;
  overtime_hours?: number;
  break_hours?: number;
  headcount: number;
}

export interface TandaPagination {
  page: number;
  per_page: number;
  total_pages: number;
  total_records: number;
}

export interface TandaListResponse<T> {
  data: T[];
  pagination?: TandaPagination;
}

// API Request Types
export interface CreateScheduleRequest {
  user_id?: number;
  department_id?: number;
  start: string;
  finish: string;
  breaks?: Array<{ start?: string; finish?: string; length?: number }>;
  notes?: string;
}

export interface UpdateScheduleRequest {
  user_id?: number;
  department_id?: number;
  start?: string;
  finish?: string;
  breaks?: Array<{ start?: string; finish?: string; length?: number }>;
  notes?: string;
}

export interface CreateLeaveRequest {
  user_id: number;
  leave_type: string;
  start: string;
  finish: string;
  hours?: number;
  reason?: string;
  status?: 'pending' | 'approved';
}

export interface CreateUnavailabilityRequest {
  user_id: number;
  title?: string;
  start: string;
  finish: string;
  repeating?: boolean;
  repeating_frequency?: string;
}

export interface DateRangeFilter {
  from: string;
  to: string;
}

// Note: ClockInRequest and ClockFilter removed - require OAuth scopes not supported by Workforce.com

export interface UserFilter {
  user_ids?: number[];
  department_ids?: number[];
  location_ids?: number[];
  active?: boolean;
}

export interface ScheduleFilter extends DateRangeFilter {
  user_ids?: number[];
  department_ids?: number[];
  include_costs?: boolean;
  show_costs?: boolean;
}

export interface TimesheetFilter extends DateRangeFilter {
  user_ids?: number[];
  approved?: boolean;
  include_costs?: boolean;
}
