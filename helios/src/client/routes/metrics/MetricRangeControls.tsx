import { type ReactNode } from 'react'

import { nyDateTimeLocalInput, nyDateTimeLocalInputToInstant } from '../../app/nyTime.js'

import { RangeNudgeRow, type NudgeRange } from './RangeNudgeRow.js'

export interface MetricRangePresetOption {
  readonly label: string
  readonly active: boolean
  readonly onSelect: () => void
}

export interface MetricRangeControlsProps {
  readonly presets: ReadonlyArray<MetricRangePresetOption>
  readonly range: NudgeRange
  readonly setRange: (next: NudgeRange) => void
  readonly label?: string
  readonly children?: ReactNode
}

export function MetricRangeControls({
  presets,
  range,
  setRange,
  label = 'range',
  children,
}: MetricRangeControlsProps): JSX.Element {
  return (
    <div className="metrics-control-group">
      <span className="subtle-copy">{label}</span>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className={preset.active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
          onClick={preset.onSelect}
          aria-pressed={preset.active}
        >
          {preset.label}
        </button>
      ))}
      <details className="metrics-range-custom">
        <summary>custom</summary>
        <div className="metrics-range-custom-inputs">
          <label className="subtle-copy">
            from{' '}
            <input
              type="datetime-local"
              value={nyDateTimeLocalInput(range.fromMs)}
              onChange={(e) => {
                const ms = nyDateTimeLocalInputToInstant(e.target.value)
                if (ms !== null) setRange({ fromMs: ms, toMs: range.toMs })
              }}
            />
          </label>
          <label className="subtle-copy">
            to{' '}
            <input
              type="datetime-local"
              value={nyDateTimeLocalInput(range.toMs)}
              onChange={(e) => {
                const ms = nyDateTimeLocalInputToInstant(e.target.value)
                if (ms !== null) setRange({ fromMs: range.fromMs, toMs: ms })
              }}
            />
          </label>
        </div>
        <RangeNudgeRow range={range} setRange={setRange} />
        {children}
      </details>
    </div>
  )
}
