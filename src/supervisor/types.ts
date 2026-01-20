// Supervisor Scheduling Optimization Types

import { TandaSchedule, TandaUser, TandaDepartment, TandaLocation } from '../tanda/types';

/**
 * Time slot representing a period during the day
 */
export interface TimeSlot {
  start: string; // ISO 8601 time or HH:MM format
  finish: string;
  label?: string; // e.g., "Morning", "Afternoon", "Evening"
}

/**
 * Predefined time slots for scheduling
 */
export const TIME_SLOTS: Record<string, TimeSlot> = {
  MORNING: { start: '06:00', finish: '12:00', label: 'Morning' },
  AFTERNOON: { start: '12:00', finish: '17:00', label: 'Afternoon' },
  EVENING: { start: '17:00', finish: '22:00', label: 'Evening' },
  NIGHT: { start: '22:00', finish: '06:00', label: 'Night' },
};

/**
 * School/Location with scheduling metadata
 */
export interface SchoolLocation {
  id: number;
  name: string;
  departmentId: number;
  departmentName: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  priority?: 'high' | 'medium' | 'low'; // Scheduling priority
  requiredSupervisors?: number; // Number of supervisors needed per shift
}

/**
 * Supervisor profile with availability and assignment data
 */
export interface SupervisorProfile {
  id: number;
  name: string;
  email: string;
  phone?: string;
  managedDepartments: number[];
  preferredHours?: number;
  currentWeeklyHours?: number;
  isAvailable: boolean;
  skills?: string[];
  homeLocation?: {
    latitude?: number;
    longitude?: number;
  };
}

/**
 * Schedule conflict/overlap detection result
 */
export interface ScheduleOverlap {
  supervisorId: number;
  supervisorName: string;
  conflictingSchedules: Array<{
    scheduleId: number;
    locationName: string;
    departmentId: number;
    start: string;
    finish: string;
  }>;
  overlapPeriod: {
    start: string;
    finish: string;
    durationMinutes: number;
  };
  severity: 'critical' | 'warning'; // Critical = full overlap, Warning = partial
}

/**
 * Coverage gap in scheduling
 */
export interface CoverageGap {
  location: SchoolLocation;
  date: string;
  timeSlot: TimeSlot;
  currentSupervisors: number;
  requiredSupervisors: number;
  gapCount: number;
  suggestedSupervisors: SupervisorProfile[];
}

/**
 * Evening coverage analysis result
 */
export interface EveningCoverageAnalysis {
  date: string;
  locations: Array<{
    location: SchoolLocation;
    hasCoverage: boolean;
    assignedSupervisors: Array<{
      id: number;
      name: string;
      scheduleId: number;
      start: string;
      finish: string;
    }>;
    coverageGap?: {
      missingSlots: TimeSlot[];
      recommendedAction: string;
    };
  }>;
  summary: {
    totalLocations: number;
    coveredLocations: number;
    uncoveredLocations: number;
    coveragePercentage: number;
  };
}

/**
 * Strategic placement recommendation
 */
export interface PlacementRecommendation {
  supervisor: SupervisorProfile;
  location: SchoolLocation;
  suggestedSchedule: {
    start: string;
    finish: string;
    date: string;
  };
  reasoning: string;
  priority: 'high' | 'medium' | 'low';
  estimatedImpact: {
    coverageImprovement: number; // Percentage
    eveningVisibilityGain: boolean;
    conflictsCreated: number;
  };
}

/**
 * Optimization request parameters
 */
export interface OptimizationRequest {
  dateRange: {
    from: string;
    to: string;
  };
  targetTimeSlots?: TimeSlot[];
  prioritizeEvening?: boolean;
  maxOverlapsAllowed?: number;
  includeAllLocations?: boolean;
  specificLocationIds?: number[];
  specificSupervisorIds?: number[];
}

/**
 * Optimization result
 */
export interface OptimizationResult {
  success: boolean;
  request: OptimizationRequest;
  analysis: {
    totalSupervisors: number;
    totalLocations: number;
    existingSchedules: number;
    overlapsFound: ScheduleOverlap[];
    coverageGaps: CoverageGap[];
    eveningCoverage: EveningCoverageAnalysis;
  };
  recommendations: PlacementRecommendation[];
  proposedSchedules: Array<{
    supervisorId: number;
    supervisorName: string;
    locationId: number;
    locationName: string;
    departmentId: number;
    start: string;
    finish: string;
    action: 'create' | 'update' | 'delete';
    originalScheduleId?: number;
  }>;
  summary: {
    schedulesCreated: number;
    schedulesUpdated: number;
    schedulesRemoved: number;
    overlapsResolved: number;
    coverageImprovement: number;
    eveningCoverageImprovement: number;
  };
  warnings: string[];
  errors: string[];
}

/**
 * Schedule validation result
 */
export interface ScheduleValidation {
  isValid: boolean;
  overlaps: ScheduleOverlap[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Bulk schedule creation request
 */
export interface BulkScheduleRequest {
  schedules: Array<{
    supervisorId: number;
    departmentId: number;
    start: string;
    finish: string;
    notes?: string;
  }>;
  validateOnly?: boolean;
  skipConflicts?: boolean;
}

/**
 * Bulk schedule creation result
 */
export interface BulkScheduleResult {
  success: boolean;
  created: Array<{
    scheduleId: number;
    supervisorId: number;
    departmentId: number;
    start: string;
    finish: string;
  }>;
  skipped: Array<{
    supervisorId: number;
    departmentId: number;
    reason: string;
  }>;
  failed: Array<{
    supervisorId: number;
    departmentId: number;
    error: string;
  }>;
  summary: {
    totalRequested: number;
    totalCreated: number;
    totalSkipped: number;
    totalFailed: number;
  };
}
