// Confirmation modal for the admin "Update defaults" / "Reset defaults"
// flow. Dumb/presentational: the host computes the change rows and owns
// the confirm action. Reuses the shared `.wh-modal*` styles.

export interface MetricsDefaultsChange {
  /** Human label, e.g. "Essentials — y-axis" or "Scatter — colour by". */
  readonly label: string
  readonly before: string
  readonly after: string
}

export interface MetricsDefaultsModalProps {
  readonly title: string
  readonly intro: string
  readonly changes: ReadonlyArray<MetricsDefaultsChange>
  readonly confirmLabel: string
  readonly busy: boolean
  readonly error: string | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function MetricsDefaultsModal({
  title,
  intro,
  changes,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: MetricsDefaultsModalProps) {
  const hasChanges = changes.length > 0
  return (
    <div
      className="wh-modal-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="wh-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p className="subtle-copy">{intro}</p>
        {hasChanges ? (
          <table className="metrics-defaults-diff">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Current</th>
                <th>New</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td className="metrics-defaults-diff-before">{c.before}</td>
                  <td className="metrics-defaults-diff-after">{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="subtle-copy">
            <em>No changes — the current view already matches the saved defaults.</em>
          </p>
        )}
        {error ? <p className="metrics-defaults-error">{error}</p> : null}
        <div className="wh-modal-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onConfirm}
            disabled={busy || !hasChanges}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
