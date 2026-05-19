import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'

import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → New entry page.
 *
 * Implements step 4 of the catalog-one-offs epic plan
 * (`docs/helios/catalog-one-offs/EPIC_PLAN.md`, issue #12 bullet 3):
 * a mobile-first form an operator can use to propose a brand-new
 * catalog entry from a freeform English description plus zero or
 * more product / variant photos.
 *
 * **Current scope (intake stub).** The page lights up the operator-
 * facing surface and captures the form locally, but the server
 * intake / LLM extraction / proposal-materialization / apply path
 * (steps 1–3 of the epic plan) are not yet wired. Submitting the
 * form therefore surfaces a clear "backend not yet wired" banner with
 * a link to the epic plan, rather than silently dropping the
 * submission or pretending it was queued. This is deliberate — see
 * the epic plan for the phased rollout.
 */
export function CatalogNewEntryPage() {
  useRegisterCatalogSidebarSubtree()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [description, setDescription] = useState('')
  const [department, setDepartment] = useState('')
  const [category, setCategory] = useState('')
  const [brand, setBrand] = useState('')
  const [retailPrice, setRetailPrice] = useState('')
  const [barcode, setBarcode] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [feedback, setFeedback] = useState<{ kind: 'info' | 'err'; message: string } | null>(null)

  const handlePhotosChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files
    if (!selected) {
      setPhotos([])
      return
    }
    setPhotos(Array.from(selected))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (description.trim().length === 0) {
      setFeedback({
        kind: 'err',
        message: 'Description is required — at minimum, tell us what you want added.',
      })
      return
    }
    setFeedback({
      kind: 'info',
      message:
        'Captured locally. Server intake endpoint is not yet wired — see the catalog-one-offs epic plan ' +
        '(docs/helios/catalog-one-offs/EPIC_PLAN.md) for the phased rollout. For now please paste the ' +
        'description into Slack and attach the photos there so the catalog team can act on it manually.',
    })
  }

  const handleReset = () => {
    setDescription('')
    setDepartment('')
    setCategory('')
    setBrand('')
    setRetailPrice('')
    setBarcode('')
    setPhotos([])
    setFeedback(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <section className="catalog-new-entry-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>New catalog entry</h2>
          <p className="subtle-copy">
            Propose a brand-new catalog group (or a small number of variants) for review.
            Describe what we need in plain English and attach zero or more product / variant
            photos. Especially useful for non-cannabis items (510 batteries, rolling papers,
            blunt wraps, etc.).
          </p>
        </div>
        <Pill tone="muted">intake-stub</Pill>
      </div>

      <div
        className="catalog-new-entry-banner"
        role="note"
        style={{
          border: '1px dashed var(--surface-border, #b8b8b8)',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          background: 'rgba(120, 120, 120, 0.08)',
        }}
      >
        <strong>Heads-up:</strong>{' '}
        <span className="subtle-copy">
          The server intake, LLM extraction, and approval / apply paths for this flow are
          tracked in <code>docs/helios/catalog-one-offs/EPIC_PLAN.md</code> (issue #12,
          bullet 3) and are not yet wired up. This page captures the form locally so the
          operator-facing surface exists; submissions are not yet routed through the
          standard catalog review queue.
        </span>
      </div>

      <form className="catalog-new-entry-form" onSubmit={handleSubmit}>
        <div className="catalog-new-entry-field">
          <label htmlFor="catalog-new-entry-description">
            <strong>Description</strong>
            <span className="subtle-copy"> (required)</span>
          </label>
          <p className="subtle-copy" style={{ margin: '0.125rem 0 0.375rem' }}>
            Write it the way you would in Slack — e.g. <em>"Add Backwoods Honey Berry
            blunt wraps, 5-pack, $X retail, smoke-shop dept"</em>.
          </p>
          <textarea
            id="catalog-new-entry-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What needs to be added to the catalog?"
            rows={5}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <div
          className="catalog-new-entry-hints"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
            marginTop: '1rem',
          }}
        >
          <div className="catalog-new-entry-field">
            <label htmlFor="catalog-new-entry-department">
              <strong>Department</strong>
              <span className="subtle-copy"> (optional)</span>
            </label>
            <input
              id="catalog-new-entry-department"
              type="text"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="e.g. Accessories"
            />
          </div>
          <div className="catalog-new-entry-field">
            <label htmlFor="catalog-new-entry-category">
              <strong>Category</strong>
              <span className="subtle-copy"> (optional)</span>
            </label>
            <input
              id="catalog-new-entry-category"
              type="text"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="e.g. Blunt wraps"
            />
          </div>
          <div className="catalog-new-entry-field">
            <label htmlFor="catalog-new-entry-brand">
              <strong>Brand</strong>
              <span className="subtle-copy"> (optional)</span>
            </label>
            <input
              id="catalog-new-entry-brand"
              type="text"
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
              placeholder="e.g. Backwoods"
            />
          </div>
          <div className="catalog-new-entry-field">
            <label htmlFor="catalog-new-entry-price">
              <strong>Retail price</strong>
              <span className="subtle-copy"> (optional)</span>
            </label>
            <input
              id="catalog-new-entry-price"
              type="text"
              inputMode="decimal"
              value={retailPrice}
              onChange={(event) => setRetailPrice(event.target.value)}
              placeholder="$"
            />
          </div>
          <div className="catalog-new-entry-field">
            <label htmlFor="catalog-new-entry-barcode">
              <strong>Barcode</strong>
              <span className="subtle-copy"> (optional, if visible)</span>
            </label>
            <input
              id="catalog-new-entry-barcode"
              type="text"
              inputMode="numeric"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              placeholder="e.g. 767461887525"
            />
          </div>
        </div>

        <div className="catalog-new-entry-field" style={{ marginTop: '1rem' }}>
          <label htmlFor="catalog-new-entry-photos">
            <strong>Photos</strong>
            <span className="subtle-copy"> (zero or more)</span>
          </label>
          <p className="subtle-copy" style={{ margin: '0.125rem 0 0.375rem' }}>
            Tap to take photos with your phone or pick existing ones. The first product
            photo will become the candidate group image once the LLM-extraction backend
            ships.
          </p>
          <input
            ref={fileInputRef}
            id="catalog-new-entry-photos"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handlePhotosChange}
          />
          {photos.length > 0 ? (
            <ul className="subtle-copy" style={{ marginTop: '0.375rem' }}>
              {photos.map((file, index) => (
                <li key={`${file.name}:${index}`}>
                  {file.name} ({formatBytes(file.size)})
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div
          className="catalog-new-entry-actions"
          style={{
            display: 'flex',
            gap: '0.5rem',
            marginTop: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <button type="submit" className="primary-button">
            Propose
          </button>
          <button type="button" className="ghost-button" onClick={handleReset}>
            Reset
          </button>
        </div>
      </form>

      {feedback ? (
        <div
          role={feedback.kind === 'err' ? 'alert' : 'status'}
          className={`catalog-new-entry-feedback catalog-new-entry-feedback--${feedback.kind}`}
          style={{
            marginTop: '1rem',
            border: '1px solid',
            borderRadius: 6,
            padding: '0.5rem 0.75rem',
            background:
              feedback.kind === 'err'
                ? 'rgba(180, 30, 30, 0.12)'
                : 'rgba(40, 90, 160, 0.10)',
            borderColor: feedback.kind === 'err' ? 'rgb(180, 30, 30)' : 'rgb(40, 90, 160)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {feedback.message}
        </div>
      ) : null}
    </section>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
