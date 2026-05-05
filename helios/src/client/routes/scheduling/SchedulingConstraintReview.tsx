import { useMemo, useState } from 'react'

import type {
  LLMExtractedConstraints,
  NormalizedSolverInput,
  SchedulingWeekday,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'

const WEEKDAY_ORDER: SchedulingWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

const WEEKDAY_LABELS: Record<SchedulingWeekday, string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
}

type ConstraintReviewTab = 'employees' | 'requirements'

interface RequirementLane {
  allowedEmployeeNames: string[]
  continuityGroup: string | null
  dayOfWeek: SchedulingWeekday
  disallowedEmployeeNames: string[]
  endTime: string
  key: string
  label: string
  requiredHeadcount: number
  requiredQualifications: string[]
  roleLabel: string | null
  source: 'extracted' | 'reviewed'
  startTime: string
  tags: string[]
}

interface RequirementGroup {
  continuityGroupCount: number
  key: string
  label: string
  requirementCount: number
  requirements: RequirementLane[]
  roleLabels: string[]
  tags: string[]
  totalHeadcount: number
}

export function SchedulingConstraintReview(input: {
  extractedConstraints: LLMExtractedConstraints
  normalizedInput: NormalizedSolverInput | null
}) {
  const [activeTab, setActiveTab] = useState<ConstraintReviewTab>('employees')
  const [selectedEmployeeName, setSelectedEmployeeName] = useState<string | null>(null)
  const [selectedRequirementKey, setSelectedRequirementKey] = useState<string | null>(null)

  const employees = useMemo(
    () => [...input.extractedConstraints.employees].sort((left, right) => left.name.localeCompare(right.name)),
    [input.extractedConstraints.employees],
  )
  const requirementLanes = useMemo(
    () => buildRequirementLanes(input.extractedConstraints, input.normalizedInput),
    [input.extractedConstraints, input.normalizedInput],
  )
  const requirementGroups = useMemo(() => buildRequirementGroups(requirementLanes), [requirementLanes])
  const employeeAttention = useMemo(() => buildEmployeeAttention(input.extractedConstraints), [input.extractedConstraints])
  const requirementAttention = useMemo(() => buildRequirementAttention(requirementLanes), [requirementLanes])

  const selectedEmployee = employees.find((employee) => employee.name === selectedEmployeeName) ?? employees[0] ?? null
  const selectedRequirement = requirementLanes.find((requirement) => requirement.key === selectedRequirementKey) ?? requirementLanes[0] ?? null
  const selectedRequirementPreferredEmployees = useMemo(
    () => buildPreferredTagMatches(selectedRequirement, employees),
    [employees, selectedRequirement],
  )

  return (
    <article className="detail-panel scheduling-constraint-review" style={{ marginTop: '1rem' }}>
      <div className="page-header" style={{ marginBottom: '0.85rem' }}>
        <div>
          <h3 style={{ margin: 0 }}>Constraint review</h3>
          <p className="subtle-copy">
            Review recurring weekly availability, softer employee preferences, and store shift requirements before editing the JSON.
          </p>
        </div>
        <div className="inline-row wrap-row scheduling-constraint-legend-row">
          <Pill tone="success">Availability = hard window</Pill>
          <Pill tone="warning">Preference = soft signal</Pill>
          <Pill tone="muted">Requirements repeat weekly</Pill>
        </div>
      </div>

      <div className="pricing-metric-grid scheduling-constraint-summary-grid">
        <div className="value-panel">
          <span>Validation issues</span>
          <p>{input.extractedConstraints.issues.length}</p>
        </div>
        <div className="value-panel">
          <span>Unknown entities</span>
          <p>{input.extractedConstraints.unknownEntities.length}</p>
        </div>
        <div className="value-panel">
          <span>Employees without availability</span>
          <p>{employeeAttention.missingAvailabilityCount}</p>
        </div>
        <div className="value-panel">
          <span>Explicit 0h preferences</span>
          <p>{employeeAttention.explicitZeroPreferredHoursCount}</p>
        </div>
        <div className="value-panel">
          <span>Unspecified max hours</span>
          <p>{employeeAttention.unspecifiedMaxHoursCount}</p>
        </div>
        <div className="value-panel">
          <span>Constrained shift templates</span>
          <p>{requirementAttention.constrainedRequirementCount}</p>
        </div>
        <div className="value-panel">
          <span>Qualification-gated shifts</span>
          <p>{requirementAttention.qualifiedRequirementCount}</p>
        </div>
        <div className="value-panel">
          <span>Continuity groups</span>
          <p>{requirementAttention.continuityGroupCount}</p>
        </div>
      </div>

      <div className="scheduling-constraint-tab-row" role="tablist" aria-label="Constraint review tabs">
        <button
          aria-selected={activeTab === 'employees'}
          className={`ghost-button scheduling-constraint-tab${activeTab === 'employees' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('employees')}
          role="tab"
          type="button"
        >
          Employees
        </button>
        <button
          aria-selected={activeTab === 'requirements'}
          className={`ghost-button scheduling-constraint-tab${activeTab === 'requirements' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('requirements')}
          role="tab"
          type="button"
        >
          Store requirements
        </button>
      </div>

      {activeTab === 'employees' ? (
        <div className="scheduling-constraint-layout">
          <div className="scheduling-constraint-board-shell">
            <table className="data-table scheduling-constraint-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  {WEEKDAY_ORDER.map((weekday) => <th key={weekday}>{WEEKDAY_LABELS[weekday]}</th>)}
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => (
                  <tr key={employee.name}>
                    <td>
                      <button
                        className={`scheduling-constraint-anchor${selectedEmployee?.name === employee.name ? ' is-selected' : ''}`}
                        onClick={() => setSelectedEmployeeName(employee.name)}
                        type="button"
                      >
                        <span className="scheduling-constraint-anchor-title">{employee.name}</span>
                        <span className="scheduling-constraint-anchor-subtle">${employee.hourlyRate.toFixed(2)}/hr</span>
                        <span className="scheduling-constraint-badges">
                          {buildEmployeeBadges(employee).map((badge, badgeIndex) => (
                            <span className={`scheduling-constraint-badge tone-${badge.tone}`} key={`${employee.name}-${badge.label}-${badgeIndex}`}>{badge.label}</span>
                          ))}
                        </span>
                      </button>
                    </td>
                    {WEEKDAY_ORDER.map((weekday) => {
                      const availability = employee.availability.filter((window) => window.dayOfWeek === weekday)
                      const isPreferredDay = employee.preferredDays.includes(weekday)

                      return (
                        <td className={isPreferredDay ? 'scheduling-constraint-day-cell is-soft-preference' : 'scheduling-constraint-day-cell'} key={`${employee.name}-${weekday}`}>
                          <div className="scheduling-constraint-cell-stack">
                            {availability.map((window, index) => (
                              <div className="scheduling-constraint-window-chip" key={`${employee.name}-${weekday}-${index}`}>
                                {formatTimeRange(window.startTime, window.endTime)}
                              </div>
                            ))}
                            {isPreferredDay ? <div className="scheduling-constraint-soft-flag">Preferred day</div> : null}
                            {availability.length === 0 && !isPreferredDay ? <span className="scheduling-constraint-empty-mark">-</span> : null}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="scheduling-constraint-detail-card">
            {selectedEmployee ? (
              <>
                <div className="page-header" style={{ marginBottom: '0.75rem' }}>
                  <div>
                    <h4 style={{ margin: 0 }}>{selectedEmployee.name}</h4>
                    <p className="subtle-copy">Employee extraction details</p>
                  </div>
                  <Pill tone="muted">Soft preferences never block</Pill>
                </div>
                <div className="scheduling-constraint-detail-stack">
                  <div>
                    <strong>Availability</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      {selectedEmployee.availability.length > 0 ? selectedEmployee.availability.map((window, index) => (
                        <li key={`${selectedEmployee.name}-availability-${index}`}>
                          {WEEKDAY_LABELS[window.dayOfWeek]} · {formatTimeRange(window.startTime, window.endTime)}
                        </li>
                      )) : <li>No availability windows extracted.</li>}
                    </ul>
                  </div>
                  <div>
                    <strong>Preferences</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      <li>{formatPreferredHoursSummary(selectedEmployee.preferredHoursPerWeek)}</li>
                      <li>{selectedEmployee.preferredDays.length > 0 ? `Preferred days: ${selectedEmployee.preferredDays.map((day) => WEEKDAY_LABELS[day]).join(', ')}` : 'Preferred days unspecified'}</li>
                      <li>{selectedEmployee.preferredShiftTags.length > 0 ? `Preferred shift tags: ${selectedEmployee.preferredShiftTags.join(', ')}` : 'Preferred shift tags unspecified'}</li>
                    </ul>
                  </div>
                  <div>
                    <strong>Attributes</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      <li>Hourly rate: ${selectedEmployee.hourlyRate.toFixed(2)}/hr</li>
                      <li>{selectedEmployee.maxHoursPerWeek === null ? 'Weekly max hours unspecified in extraction' : `Weekly max hours: ${formatHoursLabel(selectedEmployee.maxHoursPerWeek)}`}</li>
                      <li>{selectedEmployee.qualifications.length > 0 ? `Qualifications: ${selectedEmployee.qualifications.join(', ')}` : 'No qualifications extracted'}</li>
                    </ul>
                  </div>
                </div>
              </>
            ) : (
              <p className="subtle-copy">No employees extracted yet.</p>
            )}
          </aside>
        </div>
      ) : (
        <div className="scheduling-constraint-layout">
          <div className="scheduling-constraint-board-shell">
            <table className="data-table scheduling-constraint-table">
              <thead>
                <tr>
                  <th>Shift label</th>
                  {WEEKDAY_ORDER.map((weekday) => <th key={weekday}>{WEEKDAY_LABELS[weekday]}</th>)}
                </tr>
              </thead>
              <tbody>
                {requirementGroups.map((group) => (
                  <tr key={group.key}>
                    <td>
                      <button
                        className={`scheduling-constraint-anchor${group.requirements.some((requirement) => requirement.key === selectedRequirement?.key) ? ' is-selected' : ''}`}
                        onClick={() => setSelectedRequirementKey(group.requirements[0]?.key ?? null)}
                        type="button"
                      >
                        <span className="scheduling-constraint-anchor-title">{group.label}</span>
                        <span className="scheduling-constraint-anchor-subtle">{formatRequirementGroupSummary(group)}</span>
                        <span className="scheduling-constraint-badges">
                          <span className="scheduling-constraint-badge tone-muted">{group.requirementCount} template{group.requirementCount === 1 ? '' : 's'}</span>
                          <span className="scheduling-constraint-badge tone-muted">Weekly seats {group.totalHeadcount}</span>
                          {group.roleLabels.map((roleLabel) => <span className="scheduling-constraint-badge tone-muted" key={`${group.key}-${roleLabel}`}>{roleLabel}</span>)}
                          {group.continuityGroupCount > 0 ? <span className="scheduling-constraint-badge tone-warning">Continuity</span> : null}
                        </span>
                      </button>
                    </td>
                    {WEEKDAY_ORDER.map((weekday) => {
                      const weekdayRequirements = group.requirements.filter((requirement) => requirement.dayOfWeek === weekday)

                      return (
                        <td className="scheduling-constraint-day-cell" key={`${group.key}-${weekday}`}>
                          {weekdayRequirements.length > 0 ? (
                            <div className="scheduling-constraint-cell-stack">
                              {weekdayRequirements.map((requirement) => (
                                <button
                                  className={`scheduling-requirement-card${selectedRequirement?.key === requirement.key ? ' is-selected' : ''}`}
                                  key={requirement.key}
                                  onClick={() => setSelectedRequirementKey(requirement.key)}
                                  type="button"
                                >
                                  <span className="scheduling-requirement-card-title">{formatTimeRange(requirement.startTime, requirement.endTime)}</span>
                                  <span className="scheduling-constraint-badges">
                                    <span className="scheduling-constraint-badge tone-muted">Headcount {requirement.requiredHeadcount}</span>
                                    {requirement.requiredQualifications.length > 0 ? <span className="scheduling-constraint-badge tone-success">{requirement.requiredQualifications.join(', ')}</span> : null}
                                    {requirement.tags.length > 0 ? <span className="scheduling-constraint-badge tone-muted">{requirement.tags.join(', ')}</span> : null}
                                    {requirement.allowedEmployeeNames.length > 0 ? <span className="scheduling-constraint-badge tone-warning">Allow list</span> : null}
                                    {requirement.disallowedEmployeeNames.length > 0 ? <span className="scheduling-constraint-badge tone-danger">Disallow list</span> : null}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : <span className="scheduling-constraint-empty-mark">-</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="scheduling-constraint-detail-card">
            {selectedRequirement ? (
              <>
                <div className="page-header" style={{ marginBottom: '0.75rem' }}>
                  <div>
                    <h4 style={{ margin: 0 }}>{selectedRequirement.label}</h4>
                    <p className="subtle-copy">{WEEKDAY_LABELS[selectedRequirement.dayOfWeek]} · {formatTimeRange(selectedRequirement.startTime, selectedRequirement.endTime)}</p>
                  </div>
                  <Pill tone={selectedRequirement.source === 'reviewed' ? 'success' : 'muted'}>
                    {selectedRequirement.source === 'reviewed' ? 'Reviewed normalized lane' : 'Extracted lane'}
                  </Pill>
                </div>
                <div className="scheduling-constraint-detail-stack">
                  <div>
                    <strong>Coverage</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      <li>Required headcount: {selectedRequirement.requiredHeadcount}</li>
                      <li>{selectedRequirement.roleLabel ? `Role: ${selectedRequirement.roleLabel}` : 'No explicit role label'}</li>
                      <li>{selectedRequirement.continuityGroup ? `Continuity group: ${selectedRequirement.continuityGroup}` : 'No continuity link'}</li>
                    </ul>
                  </div>
                  <div>
                    <strong>Eligibility</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      <li>{selectedRequirement.requiredQualifications.length > 0 ? `Required qualifications: ${selectedRequirement.requiredQualifications.join(', ')}` : 'No hard qualification extracted'}</li>
                      <li>{selectedRequirement.allowedEmployeeNames.length > 0 ? `Allowed employees: ${selectedRequirement.allowedEmployeeNames.join(', ')}` : 'No allow-list constraint'}</li>
                      <li>{selectedRequirement.disallowedEmployeeNames.length > 0 ? `Disallowed employees: ${selectedRequirement.disallowedEmployeeNames.join(', ')}` : 'No disallow-list constraint'}</li>
                    </ul>
                  </div>
                  <div>
                    <strong>Tags</strong>
                    <ul className="timeline-list scheduling-constraint-detail-list">
                      <li>{selectedRequirement.tags.length > 0 ? selectedRequirement.tags.join(', ') : 'No tags extracted'}</li>
                      <li>{selectedRequirement.tags.length > 0 ? 'Shift tags are soft preference hooks for matching employee preferred shift tags.' : 'No tag-based employee preference matching on this shift.'}</li>
                      <li>{selectedRequirementPreferredEmployees.length > 0 ? `Employees who prefer these tags: ${selectedRequirementPreferredEmployees.join(', ')}` : 'No employee preferred shift tags currently match this shift.'}</li>
                    </ul>
                  </div>
                </div>
              </>
            ) : (
              <p className="subtle-copy">No shift requirements extracted yet.</p>
            )}
          </aside>
        </div>
      )}
    </article>
  )
}

function buildEmployeeAttention(extractedConstraints: LLMExtractedConstraints) {
  return {
    explicitZeroPreferredHoursCount: extractedConstraints.employees.filter((employee) => employee.preferredHoursPerWeek === 0).length,
    missingAvailabilityCount: extractedConstraints.employees.filter((employee) => employee.availability.length === 0).length,
    unspecifiedMaxHoursCount: extractedConstraints.employees.filter((employee) => employee.maxHoursPerWeek === null).length,
  }
}

function buildRequirementAttention(requirementLanes: RequirementLane[]) {
  return {
    continuityGroupCount: new Set(requirementLanes.filter((requirement) => requirement.continuityGroup).map((requirement) => requirement.continuityGroup)).size,
    constrainedRequirementCount: requirementLanes.filter((requirement) => requirement.allowedEmployeeNames.length > 0 || requirement.disallowedEmployeeNames.length > 0).length,
    qualifiedRequirementCount: requirementLanes.filter((requirement) => requirement.requiredQualifications.length > 0).length,
  }
}

function buildRequirementGroups(requirementLanes: RequirementLane[]): RequirementGroup[] {
  const groups = new Map<string, RequirementGroup>()

  for (const requirement of requirementLanes) {
    const existingGroup = groups.get(requirement.label)
    if (existingGroup) {
      existingGroup.requirements.push(requirement)
      existingGroup.totalHeadcount += requirement.requiredHeadcount
      if (requirement.continuityGroup) {
        existingGroup.continuityGroupCount += 1
      }
      if (requirement.roleLabel && !existingGroup.roleLabels.includes(requirement.roleLabel)) {
        existingGroup.roleLabels.push(requirement.roleLabel)
      }
      requirement.tags.forEach((tag) => {
        if (!existingGroup.tags.includes(tag)) {
          existingGroup.tags.push(tag)
        }
      })
      continue
    }

    groups.set(requirement.label, {
      continuityGroupCount: requirement.continuityGroup ? 1 : 0,
      key: `group:${requirement.label}`,
      label: requirement.label,
      requirementCount: 0,
      requirements: [requirement],
      roleLabels: requirement.roleLabel ? [requirement.roleLabel] : [],
      tags: [...requirement.tags],
      totalHeadcount: requirement.requiredHeadcount,
    })
  }

  return [...groups.values()].map((group) => ({
    ...group,
    requirementCount: group.requirements.length,
    requirements: [...group.requirements].sort(compareRequirementLanes),
    roleLabels: [...group.roleLabels].sort(),
    tags: [...group.tags].sort(),
  }))
}

function buildRequirementLanes(
  extractedConstraints: LLMExtractedConstraints,
  normalizedInput: NormalizedSolverInput | null,
): RequirementLane[] {
  const employeeNameById = new Map((normalizedInput?.employees ?? []).map((employee) => [employee.id, employee.name]))
  const reviewedLanes = normalizedInput?.shiftRequirements.map((requirement) => ({
    allowedEmployeeNames: requirement.allowedEmployeeIds.map((employeeId) => employeeNameById.get(employeeId) ?? employeeId),
    continuityGroup: requirement.continuityGroup,
    dayOfWeek: requirement.dayOfWeek,
    disallowedEmployeeNames: requirement.disallowedEmployeeIds.map((employeeId) => employeeNameById.get(employeeId) ?? employeeId),
    endTime: requirement.endTime,
    key: `reviewed:${requirement.id}`,
    label: requirement.label,
    requiredHeadcount: requirement.requiredHeadcount,
    requiredQualifications: requirement.requiredQualifications,
    roleLabel: requirement.roleLabel,
    source: 'reviewed' as const,
    startTime: requirement.startTime,
    tags: requirement.tags,
  })) ?? []

  if (reviewedLanes.length > 0) {
    return [...reviewedLanes].sort(compareRequirementLanes)
  }

  return extractedConstraints.shiftRequirements.map((requirement, index) => ({
    allowedEmployeeNames: requirement.allowedEmployeeNames,
    continuityGroup: requirement.continuityGroup,
    dayOfWeek: requirement.dayOfWeek,
    disallowedEmployeeNames: requirement.disallowedEmployeeNames,
    endTime: requirement.endTime,
    key: `extracted:${index}:${requirement.label}:${requirement.dayOfWeek}:${requirement.startTime}`,
    label: requirement.label,
    requiredHeadcount: requirement.requiredHeadcount,
    requiredQualifications: requirement.requiredQualifications,
    roleLabel: requirement.roleLabel,
    source: 'extracted' as const,
    startTime: requirement.startTime,
    tags: requirement.tags,
  })).sort(compareRequirementLanes)
}

function compareRequirementLanes(left: RequirementLane, right: RequirementLane): number {
  const dayDifference = WEEKDAY_ORDER.indexOf(left.dayOfWeek) - WEEKDAY_ORDER.indexOf(right.dayOfWeek)
  if (dayDifference !== 0) {
    return dayDifference
  }

  if (left.startTime !== right.startTime) {
    return left.startTime.localeCompare(right.startTime)
  }

  return left.label.localeCompare(right.label)
}

function buildPreferredTagMatches(
  requirement: RequirementLane | null,
  employees: LLMExtractedConstraints['employees'],
): string[] {
  if (!requirement || requirement.tags.length === 0) {
    return []
  }

  const tags = new Set(requirement.tags)
  return employees
    .filter((employee) => employee.preferredShiftTags.some((tag) => tags.has(tag)))
    .map((employee) => employee.name)
    .sort((left, right) => left.localeCompare(right))
}

function buildEmployeeBadges(employee: LLMExtractedConstraints['employees'][number]): Array<{ label: string; tone: 'danger' | 'muted' | 'success' | 'warning' }> {
  const badges: Array<{ label: string; tone: 'danger' | 'muted' | 'success' | 'warning' }> = []

  if (employee.preferredHoursPerWeek !== null) {
    badges.push({
      label: employee.preferredHoursPerWeek === 0 ? 'Preferred 0h (explicit)' : `Preferred ${formatHoursLabel(employee.preferredHoursPerWeek)}`,
      tone: 'warning',
    })
  }

  badges.push({
    label: employee.maxHoursPerWeek === null ? 'Max unspecified' : `Max ${formatHoursLabel(employee.maxHoursPerWeek)}`,
    tone: employee.maxHoursPerWeek === null ? 'warning' : 'muted',
  })

  employee.qualifications.forEach((qualification) => badges.push({ label: qualification, tone: 'success' }))
  employee.preferredShiftTags.forEach((tag) => badges.push({ label: `Prefers ${tag}`, tone: 'muted' }))

  return badges
}

function formatPreferredHoursSummary(preferredHoursPerWeek: number | null): string {
  if (preferredHoursPerWeek === null) {
    return 'Preferred weekly hours unspecified'
  }

  if (preferredHoursPerWeek === 0) {
    return 'Preferred weekly hours: 0h (explicit)'
  }

  return `Preferred weekly hours: ${formatHoursLabel(preferredHoursPerWeek)}`
}

function formatHoursLabel(value: number): string {
  return Number.isInteger(value) ? `${value}h` : `${value.toFixed(1)}h`
}

function formatTimeRange(startTime: string, endTime: string): string {
  return `${formatClockLabel(startTime)} - ${formatClockLabel(endTime)}`
}

function formatRequirementGroupSummary(group: RequirementGroup): string {
  if (group.requirements.length === 0) {
    return 'No recurring templates'
  }

  const uniqueDays = new Set(group.requirements.map((requirement) => requirement.dayOfWeek))
  return `${uniqueDays.size} day${uniqueDays.size === 1 ? '' : 's'} · ${group.requirements.length} recurring template${group.requirements.length === 1 ? '' : 's'}`
}

function formatClockLabel(value: string): string {
  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const normalizedHour = hour % 12 === 0 ? 12 : hour % 12
  const meridiem = hour >= 12 ? 'PM' : 'AM'
  return `${normalizedHour}:${String(minute).padStart(2, '0')} ${meridiem}`
}
