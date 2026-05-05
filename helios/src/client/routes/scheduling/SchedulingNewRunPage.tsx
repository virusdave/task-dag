import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  DEFAULT_SCHEDULING_CANDIDATE_COUNT,
  QueueSchedulingRunAcceptedResponseSchema,
  QueueSchedulingRunRequestSchema,
  buildHeliosModulePath,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { SchedulingNav } from './SchedulingNav.js'
import { buildScheduleWeekWindowFromStartDate, formatScheduleWeekLabel, getDefaultSchedulingWeekStartDate } from './schedulingWeek.js'

export function SchedulingNewRunPage() {
  const navigate = useNavigate()
  const [candidateCount, setCandidateCount] = useState(DEFAULT_SCHEDULING_CANDIDATE_COUNT)
  const [pageOnExtractionResult, setPageOnExtractionResult] = useState(false)
  const [scheduleLengthWeeks, setScheduleLengthWeeks] = useState(4)
  const [title, setTitle] = useState('')
  const [scheduleWeekStartDate, setScheduleWeekStartDate] = useState(getDefaultSchedulingWeekStartDate)
  const [sourceText, setSourceText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const scheduleWeek = buildScheduleWeekWindowFromStartDate(scheduleWeekStartDate, scheduleLengthWeeks)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      if (!scheduleWeek) {
        throw new Error('Pick the Sunday that starts the scheduling window and a valid number of weeks. Helios schedules one or more full Sunday-through-Saturday weeks at a time.')
      }

      const body = QueueSchedulingRunRequestSchema.parse({
        candidateCount,
        pageOnExtractionResult,
        scheduleWeek,
        sourceText,
        title: title.trim() || null,
      })

      const response = await mutateJson('/api/scheduling/runs', QueueSchedulingRunAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      await navigate(buildHeliosModulePath('scheduling', `runs/${response.schedulingRunId}`))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the scheduling run.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">New Scheduling Run</p>
          <h2>Translate scheduling notes into a reviewable run</h2>
          <p className="subtle-copy">
            Paste the plain-English staffing notes, availability, and shift needs. Helios will translate them into structured JSON,
            hold for review, and only generate candidate schedules after you approve the normalized input.
          </p>
        </div>
        <Pill tone="warning">human review required</Pill>
      </div>

      <SchedulingNav />

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      <form className="detail-panel" onSubmit={(event) => void handleSubmit(event)}>
        <label className="stack-field">
          <span>Run title</span>
          <input onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Example: Memorial Day week staffing draft" value={title} />
        </label>

        <label className="stack-field">
          <span>Scheduling week start</span>
          <input
            onChange={(event) => setScheduleWeekStartDate(event.currentTarget.value)}
            required
            type="date"
            value={scheduleWeekStartDate}
          />
        </label>

        <label className="stack-field">
          <span>How many weeks should this schedule cover?</span>
          <input
            max={12}
            min={1}
            onChange={(event) => setScheduleLengthWeeks(Number(event.currentTarget.value))}
            required
            type="number"
            value={scheduleLengthWeeks}
          />
        </label>

        <label className="stack-field">
          <span>How many candidates should Helios return?</span>
          <input
            max={12}
            min={1}
            onChange={(event) => setCandidateCount(Number(event.currentTarget.value))}
            required
            type="number"
            value={candidateCount}
          />
        </label>

        <label className="inline-row" style={{ alignItems: 'flex-start', gap: '0.75rem' }}>
          <input
            checked={pageOnExtractionResult}
            onChange={(event) => setPageOnExtractionResult(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>
            Page Dave when extraction finishes or fails.
            <br />
            <span className="subtle-copy">Use this for long Mantle runs when you do not want to keep polling the run detail page.</span>
          </span>
        </label>

        <p className="subtle-copy" style={{ marginBottom: '1rem' }}>
          {scheduleWeek
            ? `Selected window: ${formatScheduleWeekLabel(scheduleWeek)}. All preferred hours per week and max hours per week are measured separately inside each Sunday-through-Saturday week across this window.`
            : 'Pick a Sunday start date and a valid number of weeks. Helios schedules one or more full Sunday-through-Saturday weeks per run.'}
        </p>

        <label className="stack-field">
          <span>Scheduling notes</span>
          <textarea
            onChange={(event) => setSourceText(event.currentTarget.value)}
            placeholder="Paste employee availability, staffing rules, shift coverage needs, and any preference notes here."
            rows={18}
            style={{ width: '100%', resize: 'vertical' }}
            value={sourceText}
          />
        </label>

        <p className="subtle-copy" style={{ marginBottom: '1rem' }}>
          The Mantle step is limited to structured constraint extraction for this workflow. It does not pick the final schedule. Candidate generation will target {candidateCount} option{candidateCount === 1 ? '' : 's'}.
        </p>

        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Queueing scheduling run...' : 'Queue scheduling run'}
        </button>
      </form>
    </section>
  )
}
