interface PillProps {
  tone?: 'danger' | 'muted' | 'success' | 'warning'
  children: string
}

export function Pill({ children, tone = 'muted' }: PillProps) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}
