import { describe, expect, it } from 'vitest'

import type { Role, SessionUser } from '../contracts/domain/auth.js'
import { isAdminUser } from './permissions.js'

function user(role: Role): SessionUser {
  return {
    active: true,
    email: `${role}@example.com`,
    id: 1,
    metricGrants: [],
    name: `${role} user`,
    role,
  }
}

describe('isAdminUser', () => {
  it('recognizes only the explicit admin role', () => {
    expect(isAdminUser(user('admin'))).toBe(true)
    expect(isAdminUser(user('approver'))).toBe(false)
    expect(isAdminUser(user('editor'))).toBe(false)
    expect(isAdminUser(user('viewer'))).toBe(false)
    expect(isAdminUser(null)).toBe(false)
    expect(isAdminUser(undefined)).toBe(false)
  })
})
