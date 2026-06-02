// Admin-only user management.
//
// Lists every row in the `users` table and lets an admin:
//   - flip role between viewer / editor / approver / admin
//   - activate / deactivate (deactivation is a soft delete:
//     the row is preserved so audit FKs and last-seen timestamps
//     stay intact; the user just can't sign in anymore)
//   - edit display name
//   - provision a new user inline
//
// The server enforces admin-only access on every /api/users
// endpoint; this page additionally surfaces a friendly redirect
// to the dashboard if a non-admin somehow lands here.
//
// Self-lockout safety: the UI greys out role/active controls on
// your own row. The server independently rejects the same edits
// with a 400 even if the UI is bypassed.

import { useMemo, useState } from 'react'
import { Navigate, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  ALL_METRIC_GRANT_KEYS,
  RoleSchema,
  UsersCreateBodySchema,
  UsersListResponseSchema,
  UsersMutationResponseSchema,
  type MetricGrantKey,
  type Role,
  type SessionEnvelope,
  type UserRecord,
  type UsersListResponse,
  type UsersUpdateBody,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function usersLoader(): Promise<UsersListResponse> {
  return loadJson('/api/users', UsersListResponseSchema)
}

const ROLE_OPTIONS: Role[] = [...RoleSchema.options]

// Human-readable copy + URL hint per metric grant key. Keep in sync
// with the children list in AppShell.tsx → buildPrimarySidebarNodes
// (the Metrics branch).
const METRIC_GRANT_DISPLAY: Record<MetricGrantKey, { label: string; description: string; href: string }> = {
  explore: {
    label: 'Explore',
    description:
      'The /metrics dashboard — Essentials / Sales & ops / Geography / Catalog / Customer value / Scatter tabs.',
    href: '/metrics',
  },
  brands: {
    label: 'Brands',
    description: 'Brand index + per-brand category drill-down.',
    href: '/metrics/brands',
  },
  distributors: {
    label: 'Distributors',
    description: 'Distributor index + per-distributor category drill-down.',
    href: '/metrics/distributors',
  },
  staff: {
    label: 'Staff',
    description: 'Budtender performance dashboard.',
    href: '/metrics/staff',
  },
  reordering: {
    label: 'Reordering',
    description: 'Inventory / running-low / slow-movers metrics.',
    href: '/metrics/reordering',
  },
}

interface MetricGrantsRowProps {
  readonly user: UserRecord
  readonly busy: boolean
  readonly onToggle: (key: MetricGrantKey, nextOn: boolean) => void
}

function MetricGrantsRow({ user, busy, onToggle }: MetricGrantsRowProps) {
  const isAdmin = user.role === 'admin'
  const stored = new Set(user.metricGrants)
  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: '1px solid var(--control-border, #d8d8d8)',
      }}
    >
      <div className="subtle-copy" style={{ marginBottom: 6 }}>
        Metrics access
        {isAdmin ? (
          <>
            {' '}— <strong>admin</strong>: implicitly has every grant. The
            checkboxes below show / edit the literal stored set (used if
            this user is later demoted from admin).
          </>
        ) : (
          <>
            {' '}— grants control which Metrics sub-pages this user can see.
            Server enforces the gate on every API call.
          </>
        )}
      </div>
      <div className="filter-row wrap-row" style={{ alignItems: 'center', gap: 16 }}>
        {ALL_METRIC_GRANT_KEYS.map((key) => {
          const display = METRIC_GRANT_DISPLAY[key]
          const checked = stored.has(key)
          return (
            <label
              key={key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title={`${display.description} (${display.href})`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={(event) => onToggle(key, event.target.checked)}
              />
              <span>{display.label}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function rolePillTone(role: Role): PillProps['tone'] {
  switch (role) {
    case 'admin':
      return 'success'
    case 'approver':
      return 'warning'
    case 'editor':
      return 'muted'
    case 'viewer':
      return 'muted'
  }
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return '—'
  }
  try {
    return new Date(value).toLocaleString(undefined, { hour12: false })
  } catch {
    return value
  }
}

export function UsersPage() {
  useRegisterConfigSidebarSubtree()
  const initialData = useLoaderData() as UsersListResponse
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const revalidator = useRevalidator()

  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Inline-edit draft for display names. We only flush a name update
  // when the field loses focus AND the value actually changed, to
  // avoid spamming the audit log on every keystroke.
  const [nameDrafts, setNameDrafts] = useState<Record<number, string>>({})

  // New-user form
  const [createEmail, setCreateEmail] = useState('')
  const [createName, setCreateName] = useState('')
  const [createRole, setCreateRole] = useState<Role>('viewer')
  const [creating, setCreating] = useState(false)

  const meId = session?.user?.id ?? null

  const users = initialData.users
  const adminCount = useMemo(
    () => users.filter((u) => u.role === 'admin' && u.active).length,
    [users],
  )

  // Defense-in-depth client gate. The server is authoritative.
  if (session && session.user && !session.permissions.canManageUsers) {
    return <Navigate to="/" replace />
  }

  async function patchUser(userId: number, patch: UsersUpdateBody, summary: string): Promise<void> {
    setBusyUserId(userId)
    setErrorMessage(null)
    setNotice(null)
    try {
      await mutateJson(`/api/users/${userId}`, UsersMutationResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setNotice(summary)
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to update user.')
    } finally {
      setBusyUserId(null)
    }
  }

  async function handleCreate(): Promise<void> {
    setCreating(true)
    setErrorMessage(null)
    setNotice(null)
    try {
      const parsed = UsersCreateBodySchema.parse({
        email: createEmail,
        name: createName,
        role: createRole,
      })
      await mutateJson('/api/users', UsersMutationResponseSchema, {
        method: 'POST',
        body: JSON.stringify(parsed),
      })
      setNotice(`Provisioned ${parsed.email} as ${parsed.role}.`)
      setCreateEmail('')
      setCreateName('')
      setCreateRole('viewer')
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to provision user.')
    } finally {
      setCreating(false)
    }
  }

  function commitNameIfChanged(user: UserRecord): void {
    const draft = nameDrafts[user.id]
    if (draft === undefined) {
      return
    }
    const trimmed = draft.trim()
    if (trimmed === user.name || trimmed.length === 0) {
      // Reset draft so the field re-syncs with the canonical row.
      setNameDrafts((current) => {
        const { [user.id]: _omit, ...rest } = current
        return rest
      })
      return
    }
    void patchUser(user.id, { name: trimmed }, `Renamed ${user.email} → "${trimmed}".`)
    setNameDrafts((current) => {
      const { [user.id]: _omit, ...rest } = current
      return rest
    })
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Access</p>
          <h2>Users</h2>
          <p className="subtle-copy">
            Manage who can sign in to Helios and what they can do. Role changes take effect on the
            user's next request. Deactivating preserves the row (and audit/last-login history) but
            blocks future sign-ins.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{`${users.length} total`}</Pill>
          <Pill tone="success">{`${adminCount} active admin${adminCount === 1 ? '' : 's'}`}</Pill>
        </div>
      </div>

      {errorMessage ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy">{errorMessage}</span>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="success">saved</Pill>
            <span className="subtle-copy">{notice}</span>
          </div>
        </div>
      ) : null}

      <article className="history-card" style={{ marginTop: 16 }}>
        <header>
          <strong>Provision a new user</strong>
        </header>
        <p className="subtle-copy" style={{ marginTop: 4 }}>
          Email must be a <code>@freshlybaked.nyc</code> address (or appear in the
          <code> GOOGLE_OAUTH_ALLOWED_EMAILS</code> nix allowlist). Provisioning here only adds the
          row to the database — to make the change survive future <code>nixos-rebuild</code>s, also
          add the user to <code>services.helios.provisionedUsers</code> in
          <code> hosts/per-host/vps-nixos-3.nix</code>.
        </p>
        <div className="filter-row" style={{ marginTop: 8 }}>
          <input
            type="email"
            placeholder="email@freshlybaked.nyc"
            value={createEmail}
            onChange={(event) => setCreateEmail(event.target.value)}
            disabled={creating}
            style={{ minWidth: 240 }}
          />
          <input
            type="text"
            placeholder="Display name"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            disabled={creating}
            style={{ minWidth: 180 }}
          />
          <select
            value={createRole}
            onChange={(event) => setCreateRole(event.target.value as Role)}
            disabled={creating}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <button
            className="ghost-button"
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || createEmail.trim() === '' || createName.trim() === ''}
          >
            {creating ? 'Provisioning…' : 'Provision'}
          </button>
        </div>
      </article>

      <div className="stacked-list" style={{ marginTop: 16 }}>
        {users.length === 0 ? (
          <article className="history-card">
            <p className="subtle-copy">No users yet.</p>
          </article>
        ) : (
          users.map((user) => {
            const isSelf = meId === user.id
            const lastAdmin = user.role === 'admin' && user.active && adminCount === 1
            const lockSelfRole = isSelf
            const lockSelfActive = isSelf
            const busy = busyUserId === user.id
            const nameDraft = nameDrafts[user.id] ?? user.name
            return (
              <article className="history-card" key={user.id}>
                <div className="history-card-topline">
                  <div>
                    <strong>{user.email}</strong>
                    <p className="subtle-copy" style={{ marginTop: 2 }}>
                      id #{user.id} · last sign-in {formatTimestamp(user.lastLoginAt)}
                      {' · '}provisioned {formatTimestamp(user.createdAt)}
                      {' · '}google identity {user.googleSubClaimed ? 'claimed' : 'not yet claimed'}
                    </p>
                  </div>
                  <div className="inline-row wrap-row">
                    <Pill tone={rolePillTone(user.role)}>{user.role}</Pill>
                    <Pill tone={user.active ? 'success' : 'danger'}>
                      {user.active ? 'active' : 'inactive'}
                    </Pill>
                    {isSelf ? <Pill tone="muted">you</Pill> : null}
                    {lastAdmin && !isSelf ? <Pill tone="warning">last admin</Pill> : null}
                  </div>
                </div>

                <div className="filter-row" style={{ marginTop: 12, alignItems: 'center' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="subtle-copy">Name</span>
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(event) =>
                        setNameDrafts((current) => ({ ...current, [user.id]: event.target.value }))
                      }
                      onBlur={() => commitNameIfChanged(user)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur()
                        }
                      }}
                      disabled={busy}
                      style={{ minWidth: 180 }}
                    />
                  </label>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="subtle-copy">Role</span>
                    <select
                      value={user.role}
                      disabled={busy || lockSelfRole}
                      title={lockSelfRole ? 'You cannot change your own role.' : undefined}
                      onChange={(event) => {
                        const nextRole = event.target.value as Role
                        if (nextRole === user.role) {
                          return
                        }
                        void patchUser(
                          user.id,
                          { role: nextRole },
                          `Changed ${user.email}: role ${user.role} → ${nextRole}.`,
                        )
                      }}
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>{role}</option>
                      ))}
                    </select>
                  </label>

                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    title={lockSelfActive ? 'You cannot deactivate your own account.' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={user.active}
                      disabled={busy || lockSelfActive}
                      onChange={(event) => {
                        const nextActive = event.target.checked
                        if (nextActive === user.active) {
                          return
                        }
                        void patchUser(
                          user.id,
                          { active: nextActive },
                          `${nextActive ? 'Activated' : 'Deactivated'} ${user.email}.`,
                        )
                      }}
                    />
                    <span className="subtle-copy">Active (can sign in)</span>
                  </label>

                  {busy ? <span className="subtle-copy">saving…</span> : null}
                </div>

                <MetricGrantsRow
                  user={user}
                  busy={busy}
                  onToggle={(key, nextOn) => {
                    const current = new Set(user.metricGrants)
                    if (nextOn) current.add(key)
                    else current.delete(key)
                    const next = ALL_METRIC_GRANT_KEYS.filter((k) => current.has(k))
                    void patchUser(
                      user.id,
                      { metricGrants: next },
                      `${nextOn ? 'Granted' : 'Revoked'} ${user.email}: metrics.${key}.`,
                    )
                  }}
                />
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
