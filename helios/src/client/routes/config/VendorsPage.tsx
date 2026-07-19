import { useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useRouteLoaderData } from 'react-router-dom'

import {
  VendorCreateRequestSchema,
  VendorResponseSchema,
  VendorsListResponseSchema,
  type SessionEnvelope,
  type Vendor,
  type VendorCreateRequest,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyCalendarDate } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function vendorsLoader(): Promise<{ vendors: Vendor[] }> {
  return loadJson('/api/vendors', VendorsListResponseSchema)
}

type NullableBooleanDraft = '' | 'true' | 'false'
export const MAX_VENDOR_ASSOCIATIONS = 300

export interface VendorAssociationDraft {
  readonly key: string
  brandName: string
  isPrimary: boolean
  targetDaysOnHand: string
  assetUrl: string
  codRequired: NullableBooleanDraft
  codDiscountSource: string
  minimumOrderDollars: string
  comments: string
}

export interface VendorDraft {
  name: string
  isMso: boolean
  isMicro: boolean
  codOnly: boolean
  associations: VendorAssociationDraft[]
}

let nextDraftKey = 1

function blankAssociationDraft(): VendorAssociationDraft {
  return {
    key: `new-association-${nextDraftKey++}`,
    brandName: '',
    isPrimary: true,
    targetDaysOnHand: '',
    assetUrl: '',
    codRequired: '',
    codDiscountSource: '',
    minimumOrderDollars: '',
    comments: '',
  }
}

export function vendorToDraft(vendor?: Vendor): VendorDraft {
  if (!vendor) {
    return { name: '', isMso: false, isMicro: false, codOnly: false, associations: [] }
  }
  return {
    name: vendor.name,
    isMso: vendor.isMso,
    isMicro: vendor.isMicro,
    codOnly: vendor.codOnly,
    associations: vendor.associations.map((association) => ({
      key: `association-${association.id}`,
      brandName: association.brandName,
      isPrimary: association.isPrimary,
      targetDaysOnHand: association.targetDaysOnHand?.toString() ?? '',
      assetUrl: association.assetUrl ?? '',
      codRequired: association.codRequired === null ? '' : association.codRequired.toString() as NullableBooleanDraft,
      codDiscountSource: association.codDiscountSource ?? '',
      minimumOrderDollars: association.minimumOrderDollars?.toString() ?? '',
      comments: association.comments ?? '',
    })),
  }
}

export interface NormalizedVendorDraft {
  readonly input: VendorCreateRequest | null
  readonly errors: Readonly<Record<string, string>>
}

function optionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : Number(trimmed)
}

export function normalizeVendorDraft(draft: VendorDraft): NormalizedVendorDraft {
  const candidate = {
    name: draft.name.trim(),
    isMso: draft.isMso,
    isMicro: draft.isMicro,
    codOnly: draft.codOnly,
    associations: draft.associations.map((association) => ({
      brandName: association.brandName.trim(),
      isPrimary: association.isPrimary,
      targetDaysOnHand: optionalNumber(association.targetDaysOnHand),
      assetUrl: optionalText(association.assetUrl),
      codRequired: association.codRequired === '' ? null : association.codRequired === 'true',
      codDiscountSource: optionalText(association.codDiscountSource),
      minimumOrderDollars: optionalNumber(association.minimumOrderDollars),
      comments: optionalText(association.comments),
    })),
  }
  const parsed = VendorCreateRequestSchema.safeParse(candidate)
  if (parsed.success) return { input: parsed.data, errors: {} }
  const errors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.')
    if (!(path in errors)) errors[path] = issue.message
  }
  return { input: null, errors }
}

export interface VendorConflict {
  readonly fieldPath: string
  readonly message: string
  readonly vendorId: number
}

export function findVendorConflict(
  input: VendorCreateRequest,
  vendors: readonly Vendor[],
  editedVendorId: number | null,
): VendorConflict | null {
  const comparable = vendors.filter((vendor) => vendor.id !== editedVendorId)
  const vendorsByName = new Map<string, Vendor>()
  const primaryVendorByBrand = new Map<string, Vendor>()
  for (const vendor of comparable) {
    vendorsByName.set(vendor.name.toLocaleLowerCase('en-US'), vendor)
    for (const association of vendor.associations) {
      if (association.isPrimary) {
        primaryVendorByBrand.set(association.brandName.toLocaleLowerCase('en-US'), vendor)
      }
    }
  }
  const nameConflict = vendorsByName.get(input.name.toLocaleLowerCase('en-US'))
  if (nameConflict) {
    return {
      fieldPath: 'name',
      message: `The loaded vendor “${nameConflict.name}” already uses this name.`,
      vendorId: nameConflict.id,
    }
  }
  for (let index = 0; index < input.associations.length; index += 1) {
    const association = input.associations[index]
    if (!association?.isPrimary) continue
    const primaryConflict = primaryVendorByBrand.get(association.brandName.toLocaleLowerCase('en-US'))
    if (primaryConflict) {
      return {
        fieldPath: `associations.${index}.isPrimary`,
        message: `“${primaryConflict.name}” is already the primary vendor for ${association.brandName} among loaded vendors.`,
        vendorId: primaryConflict.id,
      }
    }
  }
  return null
}

export function filterVendors(vendors: readonly Vendor[], query: string): Vendor[] {
  const needle = query.trim().toLocaleLowerCase('en-US')
  if (needle === '') return [...vendors]
  return vendors.filter((vendor) => [
    vendor.name,
    ...vendor.associations.map((association) => association.brandName),
    ...vendor.observedDistributors.map((distributor) => distributor.name),
  ].some((value) => value.toLocaleLowerCase('en-US').includes(needle)))
}

export function brandSummaryLabel(vendor: Vendor): string {
  const names = vendor.associations.map((association) => association.brandName)
  if (names.length === 0) return 'No brands'
  const visible = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${visible} +${names.length - 3} more` : visible
}

export function distributorSummaryLabel(vendor: Vendor): string {
  const count = vendor.observedDistributors.length
  return `${count === 20 ? '20+' : count} observed distributor${count === 1 ? '' : 's'}`
}

export function canEditVendors(session: SessionEnvelope | undefined): boolean {
  return session?.user?.role !== undefined && session.user.role !== 'viewer'
}

export function vendorCountLabel(count: number): string {
  if (count >= 500) return `${count}+ vendors`
  return `${count} vendor${count === 1 ? '' : 's'}`
}

export function uniqueBrandCountLabel(count: number): string {
  return `${count} unique brand${count === 1 ? '' : 's'} loaded`
}

export function canSearchVendors(activeEditor: ActiveEditor | null): boolean {
  return activeEditor === null
}

function displayValue(value: string | number | null): string {
  return value === null || value === '' ? 'Not set' : String(value)
}

function codLabel(value: boolean | null): string {
  if (value === null) return 'Not set'
  return value ? 'Required' : 'Not required'
}

export function VendorReadOnlyDetails({ vendor }: { readonly vendor: Vendor }) {
  return (
    <div className="vendor-details-grid">
      <section>
        <h4>Brand associations</h4>
        {vendor.associations.length === 0 ? <p className="subtle-copy">No brand associations.</p> : (
          <div className="vendor-association-list">
            {vendor.associations.map((association) => (
              <article className="vendor-association-summary" key={association.id}>
                <div className="inline-row wrap-row">
                  <strong>{association.brandName}</strong>
                  {association.isPrimary ? <Pill tone="success">primary vendor</Pill> : null}
                </div>
                <dl className="vendor-definition-grid">
                  <div><dt>Target days on hand</dt><dd>{displayValue(association.targetDaysOnHand)}</dd></div>
                  <div><dt>Minimum order</dt><dd>{association.minimumOrderDollars === null ? 'Not set' : association.minimumOrderDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</dd></div>
                  <div><dt>COD requirement</dt><dd>{codLabel(association.codRequired)}</dd></div>
                  <div><dt>COD discount source</dt><dd>{displayValue(association.codDiscountSource)}</dd></div>
                  <div className="vendor-wide-value"><dt>Asset URL</dt><dd>{association.assetUrl ? <a href={association.assetUrl} rel="noreferrer" target="_blank">{association.assetUrl}</a> : 'Not set'}</dd></div>
                  <div className="vendor-wide-value"><dt>Comments</dt><dd>{displayValue(association.comments)}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
      <section>
        <h4>Observed distributors</h4>
        {vendor.observedDistributors.length === 0 ? <p className="subtle-copy">No purchase history observed.</p> : (
          <div className="vendor-distributor-list">
            {vendor.observedDistributors.map((distributor) => (
              <article key={`${distributor.name}-${distributor.siteKeys.join('-')}`}>
                <div className="inline-row wrap-row">
                  <strong>{distributor.name}</strong>
                  <span>{distributor.purchaseCount} purchase{distributor.purchaseCount === 1 ? '' : 's'}</span>
                </div>
                <p className="subtle-copy">
                  Last delivery {distributor.lastDeliveryDate ? nyCalendarDate(distributor.lastDeliveryDate) : 'not recorded'}
                </p>
                <div className="inline-row wrap-row vendor-site-pills">
                  {distributor.siteKeys.map((site) => <Pill key={site} tone="muted">{site}</Pill>)}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export interface VendorEditorProps {
  readonly draft: VendorDraft
  readonly errors: Readonly<Record<string, string>>
  readonly busy: boolean
  readonly unchanged: boolean
  readonly conflict: VendorConflict | null
  readonly submitLabel: string
  readonly onChange: (draft: VendorDraft) => void
  readonly onCancel: () => void
  readonly onOpenConflict: (vendorId: number) => void
  readonly onSubmit: () => void
}

export function VendorEditor({
  draft,
  errors,
  busy,
  unchanged,
  conflict,
  submitLabel,
  onChange,
  onCancel,
  onOpenConflict,
  onSubmit,
}: VendorEditorProps) {
  const fieldRefs = useRef(new Map<string, HTMLElement>())
  const [referenceDetailsOpen, setReferenceDetailsOpen] = useState<ReadonlySet<string>>(() => new Set(
    draft.associations
      .filter((association) => association.assetUrl.trim() !== '' || association.comments.trim() !== '')
      .map((association) => association.key),
  ))

  function register(path: string) {
    return (node: HTMLElement | null): void => {
      if (node) fieldRefs.current.set(path, node)
      else fieldRefs.current.delete(path)
    }
  }

  function updateAssociation(index: number, patch: Partial<VendorAssociationDraft>): void {
    onChange({
      ...draft,
      associations: draft.associations.map((association, currentIndex) =>
        currentIndex === index ? { ...association, ...patch } : association),
    })
  }

  function addAssociation(): void {
    if (draft.associations.length >= MAX_VENDOR_ASSOCIATIONS) return
    const association = blankAssociationDraft()
    onChange({ ...draft, associations: [...draft.associations, association] })
    requestAnimationFrame(() => fieldRefs.current.get(`association-key.${association.key}.brandName`)?.focus())
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit()
  }

  useEffect(() => {
    const firstPath = Object.keys(errors)[0]
    if (!firstPath) return
    const referenceMatch = /^associations\.(\d+)\.(assetUrl|comments)$/.exec(firstPath)
    const association = referenceMatch ? draft.associations[Number(referenceMatch[1])] : undefined
    if (association) {
      setReferenceDetailsOpen((current) => new Set([...current, association.key]))
      requestAnimationFrame(() => fieldRefs.current.get(firstPath)?.focus())
      return
    }
    fieldRefs.current.get(firstPath)?.focus()
  }, [draft.associations, errors])

  const errorFor = (path: string): string | undefined => errors[path]
  const describedBy = (path: string): string | undefined => errorFor(path) ? `vendor-error-${path.replaceAll('.', '-')}` : undefined

  return (
    <form className="vendor-editor" onSubmit={submit} noValidate>
      <div className="vendor-form-grid">
        <label className="vendor-wide-value">
          <span>Vendor name</span>
          <input
            ref={register('name')}
            type="text"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            aria-invalid={Boolean(errorFor('name'))}
            aria-describedby={describedBy('name')}
            disabled={busy}
          />
          <FieldError path="name" message={errorFor('name')} />
        </label>
        <label className="vendor-check"><input type="checkbox" checked={draft.isMso} onChange={(event) => onChange({ ...draft, isMso: event.target.checked })} disabled={busy} /> MSO</label>
        <label className="vendor-check"><input type="checkbox" checked={draft.isMicro} onChange={(event) => onChange({ ...draft, isMicro: event.target.checked })} disabled={busy} /> Microbusiness</label>
        <label className="vendor-check"><input type="checkbox" checked={draft.codOnly} onChange={(event) => onChange({ ...draft, codOnly: event.target.checked })} disabled={busy} /> COD only</label>
      </div>

      <div className="vendor-editor-heading" ref={register('associations')} tabIndex={-1}>
        <h4>Brand associations</h4>
        <span className="subtle-copy">{draft.associations.length} of {MAX_VENDOR_ASSOCIATIONS}</span>
        <button className="ghost-button" type="button" onClick={addAssociation} disabled={busy || draft.associations.length >= MAX_VENDOR_ASSOCIATIONS}>Add brand</button>
      </div>
      <FieldError path="associations" message={errorFor('associations')} />
      {draft.associations.length === 0 ? <p className="subtle-copy">No brand associations.</p> : null}
      <div className="vendor-association-list">
        {draft.associations.map((association, index) => {
          const path = (field: string) => `associations.${index}.${field}`
          return (
            <fieldset className="vendor-association-editor" key={association.key}>
              <legend>{association.brandName.trim() || `Brand ${index + 1}`}</legend>
              <div className="vendor-form-grid">
                <label>
                  <span>Brand</span>
                  <input
                    ref={(node) => {
                      register(path('brandName'))(node)
                      register(`association-key.${association.key}.brandName`)(node)
                    }}
                    type="text"
                    value={association.brandName}
                    onChange={(event) => updateAssociation(index, { brandName: event.target.value })}
                    aria-invalid={Boolean(errorFor(path('brandName')))}
                    aria-describedby={describedBy(path('brandName'))}
                    disabled={busy}
                  />
                  <FieldError path={path('brandName')} message={errorFor(path('brandName'))} />
                </label>
                <label className="vendor-check">
                  <input
                    ref={register(path('isPrimary')) as React.Ref<HTMLInputElement>}
                    type="checkbox"
                    checked={association.isPrimary}
                    onChange={(event) => updateAssociation(index, { isPrimary: event.target.checked })}
                    aria-invalid={Boolean(errorFor(path('isPrimary')))}
                    aria-describedby={describedBy(path('isPrimary'))}
                    disabled={busy}
                  />
                  Primary vendor for this brand
                  <FieldError path={path('isPrimary')} message={errorFor(path('isPrimary'))} />
                </label>
              </div>
              <h5>Ordering</h5>
              <div className="vendor-form-grid">
                <label><span>Target days on hand</span><input ref={register(path('targetDaysOnHand')) as React.Ref<HTMLInputElement>} type="text" inputMode="numeric" value={association.targetDaysOnHand} onChange={(event) => updateAssociation(index, { targetDaysOnHand: event.target.value })} aria-invalid={Boolean(errorFor(path('targetDaysOnHand')))} aria-describedby={describedBy(path('targetDaysOnHand'))} disabled={busy} /><FieldError path={path('targetDaysOnHand')} message={errorFor(path('targetDaysOnHand'))} /></label>
                <label><span>Minimum order ($)</span><input ref={register(path('minimumOrderDollars')) as React.Ref<HTMLInputElement>} type="text" inputMode="decimal" value={association.minimumOrderDollars} onChange={(event) => updateAssociation(index, { minimumOrderDollars: event.target.value })} aria-invalid={Boolean(errorFor(path('minimumOrderDollars')))} aria-describedby={describedBy(path('minimumOrderDollars'))} disabled={busy} /><FieldError path={path('minimumOrderDollars')} message={errorFor(path('minimumOrderDollars'))} /></label>
              </div>
              <h5>Payment</h5>
              <div className="vendor-form-grid">
                <label><span>COD requirement</span><select value={association.codRequired} onChange={(event) => updateAssociation(index, { codRequired: event.target.value as NullableBooleanDraft })} disabled={busy}><option value="">Not set</option><option value="true">Required</option><option value="false">Not required</option></select></label>
                <label><span>COD discount source</span><input ref={register(path('codDiscountSource')) as React.Ref<HTMLInputElement>} type="text" value={association.codDiscountSource} onChange={(event) => updateAssociation(index, { codDiscountSource: event.target.value })} aria-invalid={Boolean(errorFor(path('codDiscountSource')))} aria-describedby={describedBy(path('codDiscountSource'))} disabled={busy} /><FieldError path={path('codDiscountSource')} message={errorFor(path('codDiscountSource'))} /></label>
              </div>
              <details
                className="vendor-more-details"
                open={referenceDetailsOpen.has(association.key)}
                onToggle={(event) => setReferenceDetailsOpen((current) => {
                  const next = new Set(current)
                  if (event.currentTarget.open) next.add(association.key)
                  else next.delete(association.key)
                  return next
                })}
              >
                <summary>More details</summary>
                <div className="vendor-form-grid">
                  <label className="vendor-wide-value"><span>Asset URL</span><input ref={register(path('assetUrl')) as React.Ref<HTMLInputElement>} type="url" value={association.assetUrl} onChange={(event) => updateAssociation(index, { assetUrl: event.target.value })} aria-invalid={Boolean(errorFor(path('assetUrl')))} aria-describedby={describedBy(path('assetUrl'))} disabled={busy} /><FieldError path={path('assetUrl')} message={errorFor(path('assetUrl'))} /></label>
                  <label className="vendor-wide-value"><span>Comments</span><textarea ref={register(path('comments')) as React.Ref<HTMLTextAreaElement>} value={association.comments} onChange={(event) => updateAssociation(index, { comments: event.target.value })} aria-invalid={Boolean(errorFor(path('comments')))} aria-describedby={describedBy(path('comments'))} disabled={busy} /><FieldError path={path('comments')} message={errorFor(path('comments'))} /></label>
                </div>
              </details>
              <button className="danger-button vendor-remove-association" type="button" onClick={() => onChange({ ...draft, associations: draft.associations.filter((_, currentIndex) => currentIndex !== index) })} disabled={busy} aria-label={`Remove ${association.brandName.trim() || `brand ${index + 1}`} association`}>Remove brand</button>
            </fieldset>
          )
        })}
      </div>

      {conflict ? (
        <div className="vendor-conflict" role="alert">
          <span>{conflict.message}</span>
          <button className="ghost-button" type="button" onClick={() => onOpenConflict(conflict.vendorId)}>Open vendor</button>
        </div>
      ) : null}
      <div className="vendor-editor-actions">
        <button className="primary-button" type="submit" disabled={busy || unchanged}>{busy ? 'Saving…' : submitLabel}</button>
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

function FieldError({ path, message }: { readonly path: string; readonly message?: string }) {
  return message ? <span className="vendor-field-error" id={`vendor-error-${path.replaceAll('.', '-')}`}>{message}</span> : null
}

export type ActiveEditor = { readonly kind: 'create' } | { readonly kind: 'edit'; readonly vendorId: number }

export function VendorsPage() {
  useRegisterConfigSidebarSubtree()
  const loaded = useLoaderData() as { vendors: Vendor[] }
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const canEdit = canEditVendors(session)
  const [vendors, setVendors] = useState(() => [...loaded.vendors].sort((a, b) => a.name.localeCompare(b.name)))
  const [query, setQuery] = useState('')
  const [activeEditor, setActiveEditor] = useState<ActiveEditor | null>(null)
  const [draft, setDraft] = useState<VendorDraft | null>(null)
  const [baseline, setBaseline] = useState('')
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [conflict, setConflict] = useState<VendorConflict | null>(null)
  const [busy, setBusy] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [noticeVendorId, setNoticeVendorId] = useState<number | null>(null)
  const [detailsOpen, setDetailsOpen] = useState<ReadonlySet<number>>(new Set())
  const cardRefs = useRef(new Map<number, HTMLElement>())

  const visibleVendors = useMemo(() => filterVendors(vendors, query), [vendors, query])
  const uniqueBrands = useMemo(() => new Set(vendors.flatMap((vendor) => vendor.associations.map(
    (association) => association.brandName.toLocaleLowerCase('en-US'),
  ))).size, [vendors])
  const dirty = draft !== null && JSON.stringify(draft) !== baseline

  function startEditor(editor: ActiveEditor, nextDraft: VendorDraft): void {
    setActiveEditor(editor)
    setDraft(nextDraft)
    setBaseline(JSON.stringify(nextDraft))
    setErrors({})
    setConflict(null)
    setRequestError(null)
  }

  function cancelEditor(): void {
    setActiveEditor(null)
    setDraft(null)
    setBaseline('')
    setErrors({})
    setConflict(null)
    setRequestError(null)
  }

  function openVendor(vendorId: number): void {
    setQuery('')
    setDetailsOpen((current) => new Set([...current, vendorId]))
    requestAnimationFrame(() => {
      const card = cardRefs.current.get(vendorId)
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card?.focus()
    })
  }

  async function save(): Promise<void> {
    if (!draft || !activeEditor) return
    const normalized = normalizeVendorDraft(draft)
    if (!normalized.input) {
      setErrors(normalized.errors)
      setConflict(null)
      return
    }
    const editedVendorId = activeEditor.kind === 'edit' ? activeEditor.vendorId : null
    const nextConflict = findVendorConflict(normalized.input, vendors, editedVendorId)
    if (nextConflict) {
      setErrors({ [nextConflict.fieldPath]: nextConflict.message })
      setConflict(nextConflict)
      return
    }
    setBusy(true)
    setErrors({})
    setConflict(null)
    setRequestError(null)
    try {
      const response = await mutateJson(
        editedVendorId === null ? '/api/vendors' : `/api/vendors/${editedVendorId}`,
        VendorResponseSchema,
        { method: editedVendorId === null ? 'POST' : 'PATCH', body: JSON.stringify(normalized.input) },
      )
      setVendors((current) => [...current.filter((vendor) => vendor.id !== response.vendor.id), response.vendor]
        .sort((a, b) => a.name.localeCompare(b.name)))
      setNoticeVendorId(response.vendor.id)
      setDetailsOpen((current) => new Set([...current, response.vendor.id]))
      setQuery('')
      cancelEditor()
      requestAnimationFrame(() => openVendor(response.vendor.id))
    } catch (cause) {
      setRequestError(cause instanceof Error ? cause.message : 'Failed to save vendor.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="vendors-page">
      <div className="page-header">
        <div><p className="eyebrow">Admin &amp; Config / Purchasing</p><h2>Vendors</h2></div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{vendorCountLabel(vendors.length)}</Pill>
          <Pill tone="muted">{uniqueBrandCountLabel(uniqueBrands)}</Pill>
          <Pill tone="muted">{`${visibleVendors.length} shown`}</Pill>
        </div>
      </div>
      <div className="vendor-toolbar">
        <label><span className="sr-only">Search vendors</span><input type="search" placeholder="Search vendors, brands, distributors" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!canSearchVendors(activeEditor)} /></label>
        {canEdit ? <button className="primary-button" type="button" disabled={dirty || busy} onClick={() => startEditor({ kind: 'create' }, vendorToDraft())}>New vendor</button> : <Pill tone="muted">read only</Pill>}
      </div>
      {dirty ? <p className="vendor-editor-status" role="status">Save or cancel the current draft before editing another vendor.</p> : null}
      {requestError ? <p className="error-banner" role="alert">{requestError}</p> : null}
      {activeEditor?.kind === 'create' && draft ? (
        <article className="history-card vendor-create-card">
          <h3>New vendor</h3>
          <VendorEditor draft={draft} errors={errors} busy={busy} unchanged={!dirty} conflict={conflict} submitLabel="Create vendor" onChange={setDraft} onCancel={cancelEditor} onOpenConflict={openVendor} onSubmit={() => void save()} />
        </article>
      ) : null}
      <div className="stacked-list vendor-directory">
        {visibleVendors.length === 0 ? <article className="history-card"><p>No vendors match this search.</p></article> : visibleVendors.map((vendor) => {
          const editing = activeEditor?.kind === 'edit' && activeEditor.vendorId === vendor.id
          return (
            <article className="history-card vendor-card" key={vendor.id} ref={(node) => { if (node) cardRefs.current.set(vendor.id, node); else cardRefs.current.delete(vendor.id) }} tabIndex={-1}>
              <div className="history-card-topline">
                <div><h3>{vendor.name}</h3><p className="subtle-copy">{brandSummaryLabel(vendor)}</p></div>
                <div className="inline-row wrap-row">
                  {vendor.isMso ? <Pill tone="muted">MSO</Pill> : null}
                  {vendor.isMicro ? <Pill tone="muted">micro</Pill> : null}
                  {vendor.codOnly ? <Pill tone="warning">COD only</Pill> : null}
                  <Pill tone="muted">{distributorSummaryLabel(vendor)}</Pill>
                </div>
              </div>
              {noticeVendorId === vendor.id ? <p className="vendor-save-notice" role="status">Vendor saved.</p> : null}
              <div className="vendor-card-actions">
                <button className="ghost-button" type="button" aria-expanded={detailsOpen.has(vendor.id)} onClick={() => setDetailsOpen((current) => { const next = new Set(current); if (next.has(vendor.id)) next.delete(vendor.id); else next.add(vendor.id); return next })}>{detailsOpen.has(vendor.id) ? 'Hide details' : 'Details'}</button>
                {canEdit ? <button className="ghost-button" type="button" disabled={busy || editing || (dirty && !editing)} onClick={() => startEditor({ kind: 'edit', vendorId: vendor.id }, vendorToDraft(vendor))}>{editing ? 'Editing' : 'Edit'}</button> : null}
              </div>
              {detailsOpen.has(vendor.id) ? <VendorReadOnlyDetails vendor={vendor} /> : null}
              {editing && draft ? <VendorEditor draft={draft} errors={errors} busy={busy} unchanged={!dirty} conflict={conflict} submitLabel="Save vendor" onChange={setDraft} onCancel={cancelEditor} onOpenConflict={openVendor} onSubmit={() => void save()} /> : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}
