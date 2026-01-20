// Supervisor Scheduling Optimization Engine

import { TandaClient } from '../tanda/client';
import { TandaSchedule, TandaUser, TandaDepartment, TandaLocation } from '../tanda/types';
import { logger } from '../utils/logger';
import {
  TimeSlot,
  TIME_SLOTS,
  SchoolLocation,
  SupervisorProfile,
  ScheduleOverlap,
  CoverageGap,
  EveningCoverageAnalysis,
  PlacementRecommendation,
  OptimizationRequest,
  OptimizationResult,
  ScheduleValidation,
  BulkScheduleRequest,
  BulkScheduleResult,
} from './types';

/**
 * Supervisor Scheduling Optimizer
 * Provides algorithms for strategic supervisor placement across schools
 * with overlap prevention and evening coverage optimization
 */
export class SupervisorOptimizer {
  constructor(private client: TandaClient) {}

  /**
   * Parse time string to minutes from midnight
   */
  private parseTimeToMinutes(timeStr: string): number {
    // Handle ISO 8601 datetime
    if (timeStr.includes('T')) {
      const date = new Date(timeStr);
      return date.getHours() * 60 + date.getMinutes();
    }
    // Handle HH:MM format
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + (minutes || 0);
  }

  /**
   * Parse schedule time to Date object
   */
  private parseScheduleTime(time: string | number): Date {
    if (typeof time === 'number') {
      return new Date(time * 1000); // Unix timestamp
    }
    return new Date(time);
  }

  /**
   * Check if two time periods overlap
   */
  private doPeriodsOverlap(
    start1: Date,
    end1: Date,
    start2: Date,
    end2: Date
  ): { overlaps: boolean; overlapStart?: Date; overlapEnd?: Date } {
    const overlapStart = new Date(Math.max(start1.getTime(), start2.getTime()));
    const overlapEnd = new Date(Math.min(end1.getTime(), end2.getTime()));

    if (overlapStart < overlapEnd) {
      return { overlaps: true, overlapStart, overlapEnd };
    }
    return { overlaps: false };
  }

  /**
   * Check if a time is within the evening slot (17:00 - 22:00)
   */
  private isEveningTime(date: Date): boolean {
    const hours = date.getHours();
    return hours >= 17 && hours < 22;
  }

  /**
   * Check if schedule covers evening hours
   */
  private coversEvening(schedule: TandaSchedule): boolean {
    const start = this.parseScheduleTime(schedule.start);
    const finish = this.parseScheduleTime(schedule.finish);

    // Check if any part of the shift covers evening (17:00-22:00)
    const eveningStart = new Date(start);
    eveningStart.setHours(17, 0, 0, 0);
    const eveningEnd = new Date(start);
    eveningEnd.setHours(22, 0, 0, 0);

    return this.doPeriodsOverlap(start, finish, eveningStart, eveningEnd).overlaps;
  }

  /**
   * Get date string from schedule
   */
  private getScheduleDate(schedule: TandaSchedule): string {
    const start = this.parseScheduleTime(schedule.start);
    return start.toISOString().split('T')[0];
  }

  /**
   * Build SchoolLocation from department and location data
   */
  private buildSchoolLocation(
    department: TandaDepartment,
    location?: TandaLocation
  ): SchoolLocation {
    return {
      id: location?.id || department.id,
      name: location?.name || department.name,
      departmentId: department.id,
      departmentName: department.name,
      address: location?.address,
      latitude: location?.latitude,
      longitude: location?.longitude,
      timeZone: location?.time_zone,
      priority: 'medium',
      requiredSupervisors: 1,
    };
  }

  /**
   * Build SupervisorProfile from user data
   */
  private buildSupervisorProfile(
    user: TandaUser,
    weeklyHours?: number
  ): SupervisorProfile {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      managedDepartments: user.managed_department_ids || [],
      preferredHours: user.preferred_hours,
      currentWeeklyHours: weeklyHours,
      isAvailable: user.active,
    };
  }

  /**
   * Detect schedule overlaps for supervisors
   */
  async detectOverlaps(
    dateFrom: string,
    dateTo: string,
    supervisorIds?: number[]
  ): Promise<ScheduleOverlap[]> {
    logger.info('Detecting schedule overlaps', { dateFrom, dateTo, supervisorIds });

    const [schedules, users, departments] = await Promise.all([
      this.client.getSchedules({ from: dateFrom, to: dateTo }),
      this.client.getUsers({ active: true }),
      this.client.getDepartments(),
    ]);

    // Build department lookup
    const deptLookup = new Map<number, TandaDepartment>();
    departments.forEach(d => deptLookup.set(d.id, d));

    // Filter to supervisors (users with managed_department_ids)
    const supervisors = users.filter(u =>
      (u.managed_department_ids?.length || 0) > 0 &&
      (!supervisorIds || supervisorIds.includes(u.id))
    );
    const supervisorIds_set = new Set(supervisors.map(s => s.id));

    // Group schedules by supervisor
    const schedulesBySupervisor = new Map<number, TandaSchedule[]>();
    schedules.forEach(schedule => {
      if (schedule.user_id && supervisorIds_set.has(schedule.user_id)) {
        const existing = schedulesBySupervisor.get(schedule.user_id) || [];
        existing.push(schedule);
        schedulesBySupervisor.set(schedule.user_id, existing);
      }
    });

    const overlaps: ScheduleOverlap[] = [];

    // Check each supervisor's schedules for overlaps
    for (const [userId, userSchedules] of schedulesBySupervisor) {
      const supervisor = supervisors.find(s => s.id === userId);
      if (!supervisor) continue;

      // Sort schedules by start time
      const sorted = userSchedules.sort((a, b) => {
        const startA = this.parseScheduleTime(a.start).getTime();
        const startB = this.parseScheduleTime(b.start).getTime();
        return startA - startB;
      });

      // Check for overlaps between consecutive schedules
      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];

        const currentStart = this.parseScheduleTime(current.start);
        const currentEnd = this.parseScheduleTime(current.finish);
        const nextStart = this.parseScheduleTime(next.start);
        const nextEnd = this.parseScheduleTime(next.finish);

        const overlapResult = this.doPeriodsOverlap(
          currentStart,
          currentEnd,
          nextStart,
          nextEnd
        );

        if (overlapResult.overlaps && overlapResult.overlapStart && overlapResult.overlapEnd) {
          const durationMinutes = Math.round(
            (overlapResult.overlapEnd.getTime() - overlapResult.overlapStart.getTime()) / 60000
          );

          overlaps.push({
            supervisorId: userId,
            supervisorName: supervisor.name,
            conflictingSchedules: [
              {
                scheduleId: current.id,
                locationName: deptLookup.get(current.department_id || 0)?.name || 'Unknown',
                departmentId: current.department_id || 0,
                start: currentStart.toISOString(),
                finish: currentEnd.toISOString(),
              },
              {
                scheduleId: next.id,
                locationName: deptLookup.get(next.department_id || 0)?.name || 'Unknown',
                departmentId: next.department_id || 0,
                start: nextStart.toISOString(),
                finish: nextEnd.toISOString(),
              },
            ],
            overlapPeriod: {
              start: overlapResult.overlapStart.toISOString(),
              finish: overlapResult.overlapEnd.toISOString(),
              durationMinutes,
            },
            severity: durationMinutes > 30 ? 'critical' : 'warning',
          });
        }
      }
    }

    logger.info(`Found ${overlaps.length} schedule overlaps`);
    return overlaps;
  }

  /**
   * Analyze evening coverage across all schools/locations
   */
  async analyzeEveningCoverage(date: string): Promise<EveningCoverageAnalysis> {
    logger.info('Analyzing evening coverage', { date });

    const [schedules, users, departments, locations] = await Promise.all([
      this.client.getSchedules({ from: date, to: date }),
      this.client.getUsers({ active: true }),
      this.client.getDepartments(),
      this.client.getLocations(),
    ]);

    // Build lookups
    const userLookup = new Map<number, TandaUser>();
    users.forEach(u => userLookup.set(u.id, u));

    const locationLookup = new Map<number, TandaLocation>();
    locations.forEach(l => locationLookup.set(l.id, l));

    // Build school locations from departments
    const schoolLocations: SchoolLocation[] = departments.map(dept => {
      const location = dept.location_id ? locationLookup.get(dept.location_id) : undefined;
      return this.buildSchoolLocation(dept, location);
    });

    // Filter evening schedules and group by department
    const eveningSchedulesByDept = new Map<number, TandaSchedule[]>();

    schedules.forEach(schedule => {
      if (this.coversEvening(schedule) && schedule.department_id) {
        const existing = eveningSchedulesByDept.get(schedule.department_id) || [];
        existing.push(schedule);
        eveningSchedulesByDept.set(schedule.department_id, existing);
      }
    });

    // Analyze coverage for each location
    const locationCoverage = schoolLocations.map(location => {
      const deptSchedules = eveningSchedulesByDept.get(location.departmentId) || [];
      const hasCoverage = deptSchedules.length > 0;

      const assignedSupervisors = deptSchedules
        .filter(s => s.user_id)
        .map(s => {
          const user = userLookup.get(s.user_id!);
          return {
            id: s.user_id!,
            name: user?.name || 'Unknown',
            scheduleId: s.id,
            start: this.parseScheduleTime(s.start).toISOString(),
            finish: this.parseScheduleTime(s.finish).toISOString(),
          };
        });

      const coverageGap = !hasCoverage
        ? {
            missingSlots: [TIME_SLOTS.EVENING],
            recommendedAction: `Schedule a supervisor for ${location.name} during evening hours (17:00-22:00)`,
          }
        : undefined;

      return {
        location,
        hasCoverage,
        assignedSupervisors,
        coverageGap,
      };
    });

    const coveredLocations = locationCoverage.filter(l => l.hasCoverage).length;
    const totalLocations = locationCoverage.length;

    return {
      date,
      locations: locationCoverage,
      summary: {
        totalLocations,
        coveredLocations,
        uncoveredLocations: totalLocations - coveredLocations,
        coveragePercentage: totalLocations > 0
          ? Math.round((coveredLocations / totalLocations) * 100)
          : 0,
      },
    };
  }

  /**
   * Generate strategic placement recommendations for supervisors
   */
  async generatePlacementRecommendations(
    request: OptimizationRequest
  ): Promise<PlacementRecommendation[]> {
    logger.info('Generating placement recommendations', { request });

    const { dateRange, targetTimeSlots, prioritizeEvening = true } = request;

    const [users, departments, locations, schedules, unavailability] = await Promise.all([
      this.client.getUsers({ active: true }),
      this.client.getDepartments(),
      this.client.getLocations(),
      this.client.getSchedules({ from: dateRange.from, to: dateRange.to }),
      this.client.getUnavailability({ from: dateRange.from, to: dateRange.to }),
    ]);

    // Build lookups
    const locationLookup = new Map<number, TandaLocation>();
    locations.forEach(l => locationLookup.set(l.id, l));

    // Filter supervisors
    let supervisors = users.filter(u =>
      (u.managed_department_ids?.length || 0) > 0 &&
      (!request.specificSupervisorIds || request.specificSupervisorIds.includes(u.id))
    );

    // Build school locations
    let schoolLocations = departments
      .filter(d => !request.specificLocationIds || request.specificLocationIds.includes(d.id))
      .map(dept => {
        const location = dept.location_id ? locationLookup.get(dept.location_id) : undefined;
        return this.buildSchoolLocation(dept, location);
      });

    // Get existing schedules by supervisor
    const existingSchedulesBySupervisor = new Map<number, TandaSchedule[]>();
    schedules.forEach(schedule => {
      if (schedule.user_id) {
        const existing = existingSchedulesBySupervisor.get(schedule.user_id) || [];
        existing.push(schedule);
        existingSchedulesBySupervisor.set(schedule.user_id, existing);
      }
    });

    // Get unavailability by supervisor
    const unavailabilityBySupervisor = new Map<number, typeof unavailability>();
    unavailability.forEach(u => {
      const existing = unavailabilityBySupervisor.get(u.user_id) || [];
      existing.push(u);
      unavailabilityBySupervisor.set(u.user_id, existing);
    });

    // Determine target time slot (default to evening if prioritizing)
    const targetSlot = prioritizeEvening
      ? TIME_SLOTS.EVENING
      : (targetTimeSlots?.[0] || TIME_SLOTS.AFTERNOON);

    // Find uncovered locations for the target time slot
    const recommendations: PlacementRecommendation[] = [];

    // Analyze each date in the range
    const startDate = new Date(dateRange.from);
    const endDate = new Date(dateRange.to);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];

      // Check coverage for each school on this date
      for (const school of schoolLocations) {
        const deptSchedules = schedules.filter(s =>
          s.department_id === school.departmentId &&
          this.getScheduleDate(s) === dateStr
        );

        // Check if evening is covered
        const eveningCovered = deptSchedules.some(s => this.coversEvening(s));

        if (prioritizeEvening && !eveningCovered) {
          // Find available supervisors for this slot
          for (const supervisor of supervisors) {
            const supSchedules = existingSchedulesBySupervisor.get(supervisor.id) || [];
            const supUnavail = unavailabilityBySupervisor.get(supervisor.id) || [];

            // Check if supervisor is available during evening on this date
            const hasConflict = supSchedules.some(s => {
              const schedDate = this.getScheduleDate(s);
              if (schedDate !== dateStr) return false;

              const start = this.parseScheduleTime(s.start);
              const finish = this.parseScheduleTime(s.finish);
              const eveningStart = new Date(`${dateStr}T${targetSlot.start}:00`);
              const eveningEnd = new Date(`${dateStr}T${targetSlot.finish}:00`);

              return this.doPeriodsOverlap(start, finish, eveningStart, eveningEnd).overlaps;
            });

            const isUnavailable = supUnavail.some(u => {
              const uStart = new Date(u.start);
              const uFinish = new Date(u.finish);
              const eveningStart = new Date(`${dateStr}T${targetSlot.start}:00`);
              const eveningEnd = new Date(`${dateStr}T${targetSlot.finish}:00`);

              return this.doPeriodsOverlap(uStart, uFinish, eveningStart, eveningEnd).overlaps;
            });

            if (!hasConflict && !isUnavailable) {
              // Check if supervisor manages this department or any department
              const managesSchool = supervisor.managed_department_ids?.includes(school.departmentId);
              const priority = managesSchool ? 'high' : 'medium';

              recommendations.push({
                supervisor: this.buildSupervisorProfile(supervisor),
                location: school,
                suggestedSchedule: {
                  date: dateStr,
                  start: `${dateStr}T${targetSlot.start}:00`,
                  finish: `${dateStr}T${targetSlot.finish}:00`,
                },
                reasoning: managesSchool
                  ? `${supervisor.name} manages ${school.name} and is available during evening hours`
                  : `${supervisor.name} is available during evening hours at ${school.name}`,
                priority,
                estimatedImpact: {
                  coverageImprovement: 100 / schoolLocations.length,
                  eveningVisibilityGain: true,
                  conflictsCreated: 0,
                },
              });

              // Only recommend one supervisor per school per date
              break;
            }
          }
        }
      }
    }

    // Sort recommendations by priority
    recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    logger.info(`Generated ${recommendations.length} placement recommendations`);
    return recommendations;
  }

  /**
   * Run full optimization and generate optimized schedule
   */
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    logger.info('Running supervisor scheduling optimization', { request });

    const warnings: string[] = [];
    const errors: string[] = [];

    try {
      // Gather data
      const [users, departments, locations, schedules] = await Promise.all([
        this.client.getUsers({ active: true }),
        this.client.getDepartments(),
        this.client.getLocations(),
        this.client.getSchedules({
          from: request.dateRange.from,
          to: request.dateRange.to
        }),
      ]);

      // Filter supervisors
      const supervisors = users.filter(u => (u.managed_department_ids?.length || 0) > 0);

      if (supervisors.length === 0) {
        warnings.push('No supervisors found (users with managed_department_ids)');
      }

      // Detect overlaps
      const overlaps = await this.detectOverlaps(
        request.dateRange.from,
        request.dateRange.to,
        request.specificSupervisorIds
      );

      if (overlaps.length > 0) {
        warnings.push(`Found ${overlaps.length} schedule overlaps that need resolution`);
      }

      // Analyze evening coverage for each date
      const eveningAnalyses: EveningCoverageAnalysis[] = [];
      const startDate = new Date(request.dateRange.from);
      const endDate = new Date(request.dateRange.to);

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const analysis = await this.analyzeEveningCoverage(dateStr);
        eveningAnalyses.push(analysis);
      }

      // Aggregate evening coverage
      const totalLocations = departments.length;
      const avgCoverage = eveningAnalyses.length > 0
        ? eveningAnalyses.reduce((sum, a) => sum + a.summary.coveragePercentage, 0) / eveningAnalyses.length
        : 0;

      // Build coverage gaps
      const coverageGaps: CoverageGap[] = [];
      const locationLookup = new Map<number, TandaLocation>();
      locations.forEach(l => locationLookup.set(l.id, l));

      for (const analysis of eveningAnalyses) {
        for (const locCoverage of analysis.locations) {
          if (!locCoverage.hasCoverage) {
            coverageGaps.push({
              location: locCoverage.location,
              date: analysis.date,
              timeSlot: TIME_SLOTS.EVENING,
              currentSupervisors: 0,
              requiredSupervisors: locCoverage.location.requiredSupervisors || 1,
              gapCount: 1,
              suggestedSupervisors: [], // Will be populated by recommendations
            });
          }
        }
      }

      // Generate placement recommendations
      const recommendations = await this.generatePlacementRecommendations(request);

      // Generate proposed schedules from recommendations
      const proposedSchedules = recommendations.map(rec => ({
        supervisorId: rec.supervisor.id,
        supervisorName: rec.supervisor.name,
        locationId: rec.location.id,
        locationName: rec.location.name,
        departmentId: rec.location.departmentId,
        start: rec.suggestedSchedule.start,
        finish: rec.suggestedSchedule.finish,
        action: 'create' as const,
      }));

      // Calculate summary
      const lastAnalysis = eveningAnalyses[eveningAnalyses.length - 1] || {
        summary: { coveragePercentage: 0, uncoveredLocations: 0 },
      };

      return {
        success: true,
        request,
        analysis: {
          totalSupervisors: supervisors.length,
          totalLocations: departments.length,
          existingSchedules: schedules.length,
          overlapsFound: overlaps,
          coverageGaps,
          eveningCoverage: lastAnalysis,
        },
        recommendations,
        proposedSchedules,
        summary: {
          schedulesCreated: proposedSchedules.length,
          schedulesUpdated: 0,
          schedulesRemoved: 0,
          overlapsResolved: 0,
          coverageImprovement: recommendations.length > 0
            ? Math.round((recommendations.length / Math.max(coverageGaps.length, 1)) * 100)
            : 0,
          eveningCoverageImprovement: Math.round(100 - avgCoverage),
        },
        warnings,
        errors,
      };
    } catch (error) {
      logger.error('Optimization failed', error);
      errors.push(error instanceof Error ? error.message : 'Unknown error');

      return {
        success: false,
        request,
        analysis: {
          totalSupervisors: 0,
          totalLocations: 0,
          existingSchedules: 0,
          overlapsFound: [],
          coverageGaps: [],
          eveningCoverage: {
            date: request.dateRange.from,
            locations: [],
            summary: {
              totalLocations: 0,
              coveredLocations: 0,
              uncoveredLocations: 0,
              coveragePercentage: 0,
            },
          },
        },
        recommendations: [],
        proposedSchedules: [],
        summary: {
          schedulesCreated: 0,
          schedulesUpdated: 0,
          schedulesRemoved: 0,
          overlapsResolved: 0,
          coverageImprovement: 0,
          eveningCoverageImprovement: 0,
        },
        warnings,
        errors,
      };
    }
  }

  /**
   * Validate proposed schedules for overlaps
   */
  async validateSchedules(
    schedules: Array<{ supervisorId: number; start: string; finish: string; departmentId: number }>
  ): Promise<ScheduleValidation> {
    const overlaps: ScheduleOverlap[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Group by supervisor
    const bySupervisor = new Map<number, typeof schedules>();
    schedules.forEach(s => {
      const existing = bySupervisor.get(s.supervisorId) || [];
      existing.push(s);
      bySupervisor.set(s.supervisorId, existing);
    });

    // Get user names
    const users = await this.client.getUsers({ active: true });
    const userLookup = new Map<number, TandaUser>();
    users.forEach(u => userLookup.set(u.id, u));

    const departments = await this.client.getDepartments();
    const deptLookup = new Map<number, TandaDepartment>();
    departments.forEach(d => deptLookup.set(d.id, d));

    // Check for overlaps within each supervisor's schedules
    for (const [supervisorId, supSchedules] of bySupervisor) {
      const user = userLookup.get(supervisorId);

      for (let i = 0; i < supSchedules.length; i++) {
        for (let j = i + 1; j < supSchedules.length; j++) {
          const s1 = supSchedules[i];
          const s2 = supSchedules[j];

          const start1 = new Date(s1.start);
          const end1 = new Date(s1.finish);
          const start2 = new Date(s2.start);
          const end2 = new Date(s2.finish);

          const overlap = this.doPeriodsOverlap(start1, end1, start2, end2);

          if (overlap.overlaps && overlap.overlapStart && overlap.overlapEnd) {
            const durationMinutes = Math.round(
              (overlap.overlapEnd.getTime() - overlap.overlapStart.getTime()) / 60000
            );

            overlaps.push({
              supervisorId,
              supervisorName: user?.name || 'Unknown',
              conflictingSchedules: [
                {
                  scheduleId: 0, // Not created yet
                  locationName: deptLookup.get(s1.departmentId)?.name || 'Unknown',
                  departmentId: s1.departmentId,
                  start: s1.start,
                  finish: s1.finish,
                },
                {
                  scheduleId: 0,
                  locationName: deptLookup.get(s2.departmentId)?.name || 'Unknown',
                  departmentId: s2.departmentId,
                  start: s2.start,
                  finish: s2.finish,
                },
              ],
              overlapPeriod: {
                start: overlap.overlapStart.toISOString(),
                finish: overlap.overlapEnd.toISOString(),
                durationMinutes,
              },
              severity: durationMinutes > 30 ? 'critical' : 'warning',
            });
          }
        }
      }
    }

    if (overlaps.length > 0) {
      warnings.push(`${overlaps.length} overlapping schedules detected`);
      suggestions.push('Consider adjusting schedule times or assigning different supervisors');
    }

    return {
      isValid: overlaps.length === 0,
      overlaps,
      warnings,
      suggestions,
    };
  }

  /**
   * Create schedules in bulk with validation
   */
  async createBulkSchedules(request: BulkScheduleRequest): Promise<BulkScheduleResult> {
    logger.info('Creating bulk schedules', { count: request.schedules.length });

    // Validate first
    const validation = await this.validateSchedules(request.schedules);

    if (!validation.isValid && !request.skipConflicts) {
      return {
        success: false,
        created: [],
        skipped: request.schedules.map(s => ({
          supervisorId: s.supervisorId,
          departmentId: s.departmentId,
          reason: 'Schedule validation failed due to overlaps',
        })),
        failed: [],
        summary: {
          totalRequested: request.schedules.length,
          totalCreated: 0,
          totalSkipped: request.schedules.length,
          totalFailed: 0,
        },
      };
    }

    if (request.validateOnly) {
      return {
        success: validation.isValid,
        created: [],
        skipped: [],
        failed: [],
        summary: {
          totalRequested: request.schedules.length,
          totalCreated: 0,
          totalSkipped: 0,
          totalFailed: 0,
        },
      };
    }

    // Create schedules
    const created: BulkScheduleResult['created'] = [];
    const skipped: BulkScheduleResult['skipped'] = [];
    const failed: BulkScheduleResult['failed'] = [];

    // Track conflicting schedules to skip
    const conflictingKeys = new Set<string>();
    validation.overlaps.forEach(o => {
      o.conflictingSchedules.forEach(cs => {
        conflictingKeys.add(`${o.supervisorId}-${cs.start}`);
      });
    });

    for (const schedule of request.schedules) {
      const key = `${schedule.supervisorId}-${schedule.start}`;

      if (request.skipConflicts && conflictingKeys.has(key)) {
        skipped.push({
          supervisorId: schedule.supervisorId,
          departmentId: schedule.departmentId,
          reason: 'Schedule conflicts with another assignment',
        });
        continue;
      }

      try {
        const result = await this.client.createSchedule({
          user_id: schedule.supervisorId,
          department_id: schedule.departmentId,
          start: schedule.start,
          finish: schedule.finish,
          notes: schedule.notes,
        });

        created.push({
          scheduleId: result.id,
          supervisorId: schedule.supervisorId,
          departmentId: schedule.departmentId,
          start: schedule.start,
          finish: schedule.finish,
        });
      } catch (error) {
        failed.push({
          supervisorId: schedule.supervisorId,
          departmentId: schedule.departmentId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      success: failed.length === 0,
      created,
      skipped,
      failed,
      summary: {
        totalRequested: request.schedules.length,
        totalCreated: created.length,
        totalSkipped: skipped.length,
        totalFailed: failed.length,
      },
    };
  }
}
