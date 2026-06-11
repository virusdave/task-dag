import { describe, expect, it } from 'vitest'

import { compareVersions, parseRendererConstraint, satisfiesRendererConstraint } from './rendererVersion.js'

describe('rendererVersion', () => {
  it('parses a component>=version constraint', () => {
    expect(parseRendererConstraint('mss-lp-runtime>=0.4.0')).toEqual({
      component: 'mss-lp-runtime',
      operator: '>=',
      version: '0.4.0',
    })
  })

  it('returns null on unparseable constraints', () => {
    expect(parseRendererConstraint('garbage')).toBeNull()
    expect(parseRendererConstraint('foo~1.0.0')).toBeNull()
  })

  it('compares versions numerically by segment', () => {
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.4.1', '0.4.0')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  it('evaluates >=, >, = and fails closed on unparseable', () => {
    expect(satisfiesRendererConstraint('mss-lp-runtime>=0.4.0', '0.4.0')).toBe(true)
    expect(satisfiesRendererConstraint('mss-lp-runtime>=0.4.0', '0.3.9')).toBe(false)
    expect(satisfiesRendererConstraint('mss-lp-runtime>0.4.0', '0.4.0')).toBe(false)
    expect(satisfiesRendererConstraint('mss-lp-runtime>0.4.0', '0.4.1')).toBe(true)
    expect(satisfiesRendererConstraint('mss-lp-runtime=0.4.0', '0.4.0')).toBe(true)
    expect(satisfiesRendererConstraint('garbage', '99.0.0')).toBe(false)
  })
})
