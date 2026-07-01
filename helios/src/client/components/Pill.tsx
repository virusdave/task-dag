import type { ReactNode } from 'react'

export interface PillProps {
  tone?: 'danger' | 'muted' | 'success' | 'warning'
  // A Pill is a presentational <span> wrapper, so it accepts any
  // renderable content. Call sites legitimately pass mixed children
  // (e.g. `{count} issue{count === 1 ? '' : 's'}`), which JSX types as
  // an array of strings/numbers/elements, i.e. ReactNode.
  children: ReactNode
  // Optional native tooltip, e.g. to expose the full reason behind a
  // short status label on hover.
  title?: string
}

export function Pill({ children, tone = 'muted', title }: PillProps) {
  return <span className={`pill pill-${tone}`} title={title}>{children}</span>
}
