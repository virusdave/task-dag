import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'

import { DayPilot, DayPilotMonth, DayPilotScheduler } from '@daypilot/daypilot-lite-react'

import type { NormalizedSolverInput, ScheduleCandidate } from '../../../shared/contracts/index.js'
import {
  buildSchedulingCandidateCsv,
  buildSchedulingCandidatePresentation,
  type PresentedDay,
  type PresentedEmployee,
  type PresentedShiftAssignment,
} from './schedulingResultsPresenter.js'

export function SchedulingCandidateResults(input: {
  candidateId: number
  mode?: 'calendar-only' | 'full'
  normalizedInput: NormalizedSolverInput
  runId: number
  schedule: ScheduleCandidate
}) {
  const [exportError, setExportError] = useState<string | null>(null)
  const presentation = useMemo(() => buildSchedulingCandidatePresentation(input), [input])
  const mode = input.mode ?? 'full'
  const monthCalendars = useMemo(
    () => buildDayPilotMonthCalendars(presentation, input.normalizedInput.scheduleWeek),
    [input.normalizedInput.scheduleWeek, presentation],
  )
  const schedulerModel = useMemo(
    () => buildDayPilotSchedulerModel(presentation, input.normalizedInput.scheduleWeek),
    [input.normalizedInput.scheduleWeek, presentation],
  )

  function handleExport(view: 'calendar' | 'daily') {
    setExportError(null)

    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      setExportError('Allow pop-ups for Helios to export the PDF view.')
      return
    }

    printWindow.document.open()
    printWindow.document.write(buildPrintDocument({
      candidateLabel: input.schedule.label,
      candidateSummary: input.schedule.summary,
      presentation,
      view,
      weekLabel: `${input.normalizedInput.scheduleWeek.startDate} to ${input.normalizedInput.scheduleWeek.endDate}`,
    }))
    printWindow.document.close()
  }

  function handleExportCsv() {
    setExportError(null)

    const csv = buildSchedulingCandidateCsv({
      candidateId: input.candidateId,
      candidateLabel: input.schedule.label,
      candidateSummary: input.schedule.summary,
      presentation,
      runId: input.runId,
      scheduleWeek: input.normalizedInput.scheduleWeek,
    })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = buildCsvFileName(input.runId, input.candidateId, input.schedule.label)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }

  return (
    <div className={`scheduling-results-stack${mode === 'calendar-only' ? ' is-calendar-only' : ''}`}>
      {mode === 'full' ? (
        <>
          <div className="page-header" style={{ marginBottom: '0.75rem' }}>
            <div>
              <h5 style={{ margin: 0, fontSize: '1rem' }}>Calendar view</h5>
              <p className="subtle-copy">Month-at-a-glance coverage plus detailed shift lanes for the selected Sunday-through-Saturday scheduling window.</p>
            </div>
            <div className="inline-row wrap-row">
              <button className="ghost-button" onClick={() => handleExport('calendar')} type="button">
                Export calendar PDF
              </button>
              <button className="ghost-button" onClick={() => handleExport('daily')} type="button">
                Export day-by-day PDF
              </button>
              <button className="ghost-button" onClick={() => handleExportCsv()} type="button">
                Download CSV
              </button>
            </div>
          </div>

          {exportError ? <p className="error-text">{exportError}</p> : null}

          {presentation.employeeLegend.length > 0 ? (
            <div className="scheduling-employee-legend">
              {presentation.employeeLegend.map((employee) => <EmployeeChip employee={employee} key={employee.id} />)}
            </div>
          ) : null}
        </>
      ) : null}

      <div className={`scheduling-months-grid${mode === 'calendar-only' ? ' is-calendar-only' : ''}`}>
        {monthCalendars.map((month) => (
          <section className="scheduling-month-panel" key={month.startDate}>
            <div className="page-header" style={{ marginBottom: '0.65rem' }}>
              <h5 style={{ margin: 0, fontSize: '1rem' }}>{month.label}</h5>
            </div>
            <div className="scheduling-daypilot-month-shell">
              <DayPilotMonth
                cellHeaderHeight={22}
                cellHeight={118}
                eventBarVisible={false}
                eventClickHandling="Disabled"
                eventDeleteHandling="Disabled"
                eventHeight={22}
                eventMoveHandling="Disabled"
                eventResizeHandling="Disabled"
                events={month.events}
                headerHeight={26}
                lineSpace={2}
                onBeforeCellRender={(args) => {
                  const date = args.cell.start.toString('yyyy-MM-dd')
                  if (date < input.normalizedInput.scheduleWeek.startDate || date > input.normalizedInput.scheduleWeek.endDate) {
                    return
                  }
                  args.cell.properties.backColor = 'rgba(227, 139, 78, 0.12)'
                }}
                showToolTip
                startDate={month.startDate}
                timeRangeSelectedHandling="Disabled"
                width="100%"
              />
            </div>
          </section>
        ))}
      </div>

      {mode === 'full' ? (
        <>
          <div>
            <h5 style={{ marginBottom: '0.65rem' }}>Scheduling swimlanes</h5>
            <div className="scheduling-daypilot-scheduler-shell">
              <DayPilotScheduler
                cellWidth={76}
                days={schedulerModel.dayCount}
                durationBarVisible={false}
                eventClickHandling="Disabled"
                eventDeleteHandling="Disabled"
                eventHeight={46}
                eventMoveHandling="Disabled"
                eventResizeHandling="Disabled"
                eventTextWrappingEnabled
                events={schedulerModel.events}
                height={schedulerModel.height}
                heightSpec="Max"
                resources={schedulerModel.resources}
                rowHeaderWidth={260}
                rowMarginBottom={2}
                rowMarginTop={2}
                scale="Day"
                showToolTip
                startDate={input.normalizedInput.scheduleWeek.startDate}
                timeHeaders={[
                  { groupBy: 'Month' },
                  { format: 'ddd d', groupBy: 'Day' },
                ]}
                timeRangeSelectedHandling="Disabled"
                width="100%"
              />
            </div>
          </div>

          {presentation.coverageWarnings.length > 0 ? (
            <div>
              <strong>Coverage warnings</strong>
              <ul className="timeline-list" style={{ marginTop: '0.5rem' }}>
                {presentation.coverageWarnings.map((warning) => (
                  <li key={`${warning.date}-${warning.shiftLabel}-${warning.message}`}>
                    {warning.dateLabel} · {warning.shiftLabel}: {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function buildCsvFileName(runId: number, candidateId: number, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'schedule'
  return `scheduling-run-${runId}-candidate-${candidateId}-${slug}.csv`
}

function EmployeeChip({ employee, title }: { employee: PresentedEmployee; title?: string }) {
  return (
    <span className="scheduling-employee-chip" style={buildEmployeeChipStyle(employee.color)} title={title}>
      {employee.name}
    </span>
  )
}

function buildAssignmentTooltipLines(assignment: PresentedShiftAssignment, employeeId?: string): string[] {
  const matchingEmployees = assignment.assignedEmployees
    .filter((employee) => employeeId === undefined || employee.id === employeeId)

  if (matchingEmployees.length === 0) {
    return [[
      `Employee: ${assignment.unfilledSeatCount > 0 ? `Unfilled x${assignment.unfilledSeatCount}` : 'Unassigned'}`,
      `Date: ${assignment.dateLabel}`,
      `Shift: ${assignment.label}`,
      `Position: ${assignment.roleLabel ?? 'Unspecified'}`,
      `Hours: ${assignment.timeLabel}`,
    ].join(' | ')]
  }

  return matchingEmployees.map((employee) => [
    `Employee: ${employee.name}`,
    `Date: ${assignment.dateLabel}`,
    `Shift: ${assignment.label}`,
    `Position: ${assignment.roleLabel ?? 'Unspecified'}`,
    `Hours: ${assignment.timeLabel}`,
  ].join(' | '))
}

function buildEmployeeChipStyle(employeeColor: PresentedEmployee['color']): CSSProperties {
  return {
    background: employeeColor.background,
    borderColor: employeeColor.border,
    color: employeeColor.text,
  }
}

function buildDayPilotMonthCalendars(
  presentation: ReturnType<typeof buildSchedulingCandidatePresentation>,
  scheduleWeek: NormalizedSolverInput['scheduleWeek'],
): Array<{ events: DayPilot.EventData[]; label: string; startDate: string }> {
  const events = buildDayPilotMonthEvents(presentation.days)
  return buildTouchedMonthStarts(scheduleWeek.startDate, scheduleWeek.endDate).map((startDate, index) => ({
    events,
    label: presentation.months[index]?.label ?? startDate,
    startDate,
  }))
}

function buildDayPilotMonthEvents(days: PresentedDay[]): DayPilot.EventData[] {
  return days.flatMap((day) => day.assignments.map((assignment) => buildMonthEvent(day, assignment)))
}

function buildMonthEvent(day: PresentedDay, assignment: PresentedShiftAssignment): DayPilot.EventData {
  const timing = buildAssignmentEventTiming(assignment)
  const employeeSummary = formatAssignmentEmployeeSummary(assignment)
  const colors = buildAssignmentEventColors(assignment)

  return {
    backColor: colors.backColor,
    borderColor: colors.borderColor,
    end: timing.end,
    fontColor: colors.fontColor,
    html: escapeHtml(`${employeeSummary} - ${assignment.label}`),
    id: `month:${assignment.occurrenceKey}`,
    start: timing.start,
    text: `${employeeSummary} - ${assignment.label}`,
    toolTip: [
      day.titleLabel,
      ...buildAssignmentTooltipLines(assignment),
    ].join('\n'),
  }
}

function buildDayPilotSchedulerModel(
  presentation: ReturnType<typeof buildSchedulingCandidatePresentation>,
  scheduleWeek: NormalizedSolverInput['scheduleWeek'],
): {
  dayCount: number
  events: DayPilot.EventData[]
  height: number
  resources: DayPilot.ResourceData[]
} {
  const resources = presentation.shiftLanes.map((lane) => ({
    html: buildSchedulerLaneHtml(lane),
    id: lane.key,
    name: lane.label,
    toolTip: [lane.label, lane.timeLabel, lane.roleLabel, lane.tags.join(', ')].filter(Boolean).join('\n'),
  }))

  const events = presentation.shiftLanes.flatMap((lane) => lane.cells.flatMap((cell) => cell.assignments.map((assignment) => {
    const timing = buildAssignmentEventTiming(assignment)
    const employeeSummary = formatAssignmentEmployeeSummary(assignment)
    const colors = buildAssignmentEventColors(assignment)

    return {
      backColor: colors.backColor,
      borderColor: colors.borderColor,
      end: timing.end,
      fontColor: colors.fontColor,
      html: buildSchedulerEventHtml(assignment),
      id: `scheduler:${assignment.occurrenceKey}`,
      resource: lane.key,
      start: timing.start,
      text: `${employeeSummary} - ${assignment.timeLabel}`,
      toolTip: buildAssignmentTooltipLines(assignment).join('\n'),
    } satisfies DayPilot.EventData
  })))

  return {
    dayCount: countDaysInclusive(scheduleWeek.startDate, scheduleWeek.endDate),
    events,
    height: Math.min(Math.max(resources.length * 56 + 110, 260), 720),
    resources,
  }
}

function buildSchedulerLaneHtml(lane: ReturnType<typeof buildSchedulingCandidatePresentation>['shiftLanes'][number]): string {
  const metadata = [lane.timeLabel, lane.roleLabel, lane.tags.join(', ')].filter((value) => value && value.length > 0).join(' · ')
  return `<div style="display:grid;gap:2px;"><strong>${escapeHtml(lane.label)}</strong>${metadata ? `<span style="font-size:12px;opacity:0.72;">${escapeHtml(metadata)}</span>` : ''}</div>`
}

function buildSchedulerEventHtml(assignment: PresentedShiftAssignment): string {
  const employeeSummary = formatAssignmentEmployeeSummary(assignment)
  const metadata = [assignment.label, assignment.roleLabel, assignment.timeLabel].filter((value) => value && value.length > 0).join(' · ')
  return `<div style="display:grid;gap:2px;line-height:1.2;"><strong>${escapeHtml(employeeSummary)}</strong><span style="font-size:12px;opacity:0.85;">${escapeHtml(metadata)}</span></div>`
}

function formatAssignmentEmployeeSummary(assignment: PresentedShiftAssignment): string {
  if (assignment.assignedEmployees.length > 0) {
    return assignment.assignedEmployees.map((employee) => employee.name).join(', ')
  }
  if (assignment.unfilledSeatCount > 0) {
    return `Unfilled x${assignment.unfilledSeatCount}`
  }
  return 'No assignment'
}

function buildAssignmentEventColors(assignment: PresentedShiftAssignment): { backColor: string; borderColor: string; fontColor: string } {
  const primaryEmployee = assignment.assignedEmployees[0]
  if (primaryEmployee) {
    return {
      backColor: primaryEmployee.color.background,
      borderColor: primaryEmployee.color.border,
      fontColor: primaryEmployee.color.text,
    }
  }

  if (assignment.unfilledSeatCount > 0) {
    return {
      backColor: 'rgba(176, 61, 61, 0.24)',
      borderColor: 'rgba(255, 153, 153, 0.75)',
      fontColor: '#fff0f0',
    }
  }

  return {
    backColor: 'rgba(255, 255, 255, 0.06)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    fontColor: '#f6efe7',
  }
}

function buildAssignmentEventTiming(assignment: PresentedShiftAssignment): { end: string; start: string } {
  const [startLabel, endLabel] = assignment.timeLabel.split(' - ')
  const startMinutes = parseClockLabelMinutes(startLabel)
  let endMinutes = parseClockLabelMinutes(endLabel)
  let endDate = assignment.date
  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60
    endDate = addDaysToIsoDate(assignment.date, 1)
  }

  return {
    end: buildIsoDateTime(endDate, endMinutes % (24 * 60)),
    start: buildIsoDateTime(assignment.date, startMinutes),
  }
}

function parseClockLabelMinutes(value: string): number {
  const normalized = value.trim()
  const [timePart, meridiem] = normalized.split(' ')
  const [hourText, minuteText] = timePart.split(':')
  let hour = Number(hourText) % 12
  if (meridiem === 'PM') {
    hour += 12
  }
  return hour * 60 + Number(minuteText)
}

function buildIsoDateTime(date: string, totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
}

function addDaysToIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function buildTouchedMonthStarts(startDate: string, endDate: string): string[] {
  const monthStarts: string[] = []
  const cursor = new Date(`${startDate}T00:00:00Z`)
  cursor.setUTCDate(1)
  const endMonth = new Date(`${endDate}T00:00:00Z`)
  endMonth.setUTCDate(1)

  while (cursor <= endMonth) {
    monthStarts.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  return monthStarts
}

function countDaysInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime()
  const end = new Date(`${endDate}T00:00:00Z`).getTime()
  return Math.round((end - start) / 86_400_000) + 1
}

function buildPrintDocument(input: {
  candidateLabel: string
  candidateSummary: string
  presentation: ReturnType<typeof buildSchedulingCandidatePresentation>
  view: 'calendar' | 'daily'
  weekLabel: string
}): string {
  const body = input.view === 'calendar'
    ? renderCalendarPrintHtml(input.presentation)
    : renderDailyPrintHtml(input.presentation.days)

  const pageOrientation = input.view === 'calendar' ? 'landscape' : 'portrait'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(input.candidateLabel)} - ${input.view === 'calendar' ? 'Calendar' : 'Day by day'} export</title>
    <style>
      @page { size: ${pageOrientation}; margin: 12mm; }
      :root { color-scheme: light; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; color: #1f1813; background: #fffdf9; font-family: 'Avenir Next', 'Segoe UI Variable', 'Helvetica Neue', sans-serif; }
      main { padding: 0; }
      header { margin-bottom: 18px; }
      h1 { margin: 0 0 4px; font-size: 24px; }
      h2 { margin: 0 0 8px; font-size: 16px; }
      h3 { margin: 0 0 8px; font-size: 14px; }
      p { margin: 0; }
      .muted { color: #6e6258; }
      .legend, .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip, .unfilled { display: inline-flex; align-items: center; border: 1px solid transparent; border-radius: 999px; padding: 4px 9px; font-size: 11px; font-weight: 600; }
      .unfilled { border-color: rgba(132, 116, 100, 0.42); background: rgba(132, 116, 100, 0.08); color: #6e6258; }
      .month-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }
      .month-head { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6e6258; }
      .month-cell { min-height: 88px; border: 1px solid rgba(94, 82, 72, 0.2); border-radius: 12px; padding: 8px; }
      .month-cell.outside { opacity: 0.45; }
      .month-cell.current-week { background: rgba(227, 139, 78, 0.08); border-color: rgba(227, 139, 78, 0.35); }
      .month-cell-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .swimlane-table { width: 100%; border-collapse: collapse; margin: 10px 0 0; }
      .swimlane-table th, .swimlane-table td { border: 1px solid rgba(94, 82, 72, 0.2); padding: 8px; vertical-align: top; text-align: left; }
      .assignment { border: 1px solid rgba(94, 82, 72, 0.14); border-radius: 10px; padding: 7px; background: rgba(255, 247, 238, 0.75); }
      .assignment + .assignment { margin-top: 6px; }
      .assignment-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
      .day-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .day-card { border: 1px solid rgba(94, 82, 72, 0.2); border-radius: 14px; padding: 12px; break-inside: avoid; }
      .day-card .assignment + .assignment { margin-top: 8px; }
      .section + .section { margin-top: 18px; }
      @media print { .page-break-before { break-before: page; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(input.candidateLabel)}</h1>
        <p class="muted">${escapeHtml(input.candidateSummary)}</p>
        <p class="muted">Schedule window: ${escapeHtml(input.weekLabel)}</p>
      </header>
      ${body}
    </main>
    <script>
      window.addEventListener('load', () => {
        window.focus();
        window.print();
      });
    </script>
  </body>
</html>`
}

function renderCalendarPrintHtml(presentation: ReturnType<typeof buildSchedulingCandidatePresentation>): string {
  return `
    <section class="section">
      ${presentation.employeeLegend.length > 0 ? `<div class="legend">${presentation.employeeLegend.map(renderEmployeeChipHtml).join('')}</div>` : ''}
    </section>
    <section class="section">
      ${presentation.months.map((month) => `
        <div style="margin-bottom: 16px;">
          <h2>${escapeHtml(month.label)}</h2>
          <div class="month-grid">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => `<div class="month-head">${label}</div>`).join('')}
            ${month.weeks.flat().map((day) => `
              <div class="month-cell${day.isCurrentMonth ? '' : ' outside'}${day.isScheduledWeek ? ' current-week' : ''}">
                <div class="month-cell-top">
                  <strong>${escapeHtml(day.dayNumberLabel)}</strong>
                  ${day.assignments.length > 0 ? `<span class="muted">${day.assignments.length} shifts</span>` : ''}
                </div>
                <div class="chips">${day.assignedEmployees.map(renderEmployeeChipHtml).join('')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </section>
    <section class="section page-break-before">
      <h2>Shift swimlanes</h2>
      <table class="swimlane-table">
        <thead>
          <tr>
            <th>Shift lane</th>
            ${presentation.days.map((day) => `<th>${escapeHtml(day.label)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${presentation.shiftLanes.map((lane) => `
            <tr>
              <th>
                <div>${escapeHtml(lane.label)}</div>
                <div class="muted">${escapeHtml(lane.timeLabel)}</div>
                ${lane.roleLabel ? `<div class="muted">${escapeHtml(lane.roleLabel)}</div>` : ''}
              </th>
              ${lane.cells.map((cell) => `<td>${cell.assignments.map(renderAssignmentCardHtml).join('') || '<span class="muted">-</span>'}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `
}

function renderDailyPrintHtml(days: PresentedDay[]): string {
  return `
    <section class="section">
      <h2>Day-by-day assignments</h2>
      <div class="day-grid">
        ${days.map((day) => `
          <article class="day-card">
            <h3>${escapeHtml(day.titleLabel)}</h3>
            <p class="muted" style="margin-bottom: 8px;">${day.assignments.length} shifts</p>
            ${day.assignments.length > 0 ? day.assignments.map(renderAssignmentCardHtml).join('') : '<p class="muted">No scheduled shifts for this day.</p>'}
          </article>
        `).join('')}
      </div>
    </section>
  `
}

function renderAssignmentCardHtml(assignment: PresentedShiftAssignment): string {
  return `
    <div class="assignment">
      <div class="assignment-top">
        <strong>${escapeHtml(assignment.label)}</strong>
        <span class="muted">${escapeHtml(assignment.timeLabel)}</span>
      </div>
      ${assignment.roleLabel ? `<div class="muted">${escapeHtml(assignment.roleLabel)}</div>` : ''}
      ${assignment.tags.length > 0 ? `<div class="muted">Tags: ${escapeHtml(assignment.tags.join(', '))}</div>` : ''}
      <div class="chips" style="margin-top: 6px;">
        ${assignment.assignedEmployees.map(renderEmployeeChipHtml).join('')}
        ${assignment.unfilledSeatCount > 0 ? `<span class="unfilled">Unfilled x${assignment.unfilledSeatCount}</span>` : ''}
      </div>
    </div>
  `
}

function renderEmployeeChipHtml(employee: PresentedEmployee): string {
  return `<span class="chip" style="background:${escapeHtml(employee.color.background)};border-color:${escapeHtml(employee.color.border)};color:${escapeHtml(employee.color.text)};">${escapeHtml(employee.name)}</span>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
