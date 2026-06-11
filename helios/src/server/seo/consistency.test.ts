import { describe, expect, it } from 'vitest'

import { compileSeoBundle, SeoCompileError } from './compile.js'
import { FIXTURE_HERO_SHA, validCompileInput } from './__tests__/fixtures.js'

function compileExpectingErrors(mutate: (input: ReturnType<typeof validCompileInput>) => void): string[] {
  const input = validCompileInput()
  mutate(input)
  try {
    compileSeoBundle(input)
    return []
  } catch (e) {
    if (e instanceof SeoCompileError) return e.problems
    throw e
  }
}

describe('SEO cross-artifact consistency', () => {
  it('compiles a fully valid bundle', () => {
    const compiled = compileSeoBundle(validCompileInput())
    expect(compiled.seoBundleId).toMatch(/^seob_/)
    expect(compiled.widgets.widgets).toHaveLength(2)
  })

  it('rejects a physical site claiming the reserved `all` id', () => {
    const problems = compileExpectingErrors((i) => {
      i.sites = { all: { hosts: ['x'], mode: 'raw' }, ...i.sites }
    })
    expect(problems.join('\n')).toMatch(/reserved global scope token/)
  })

  it('rejects a widget referencing a missing faq set', () => {
    const problems = compileExpectingErrors((i) => {
      ;(i.widgets[0] as { faq_set_id: string }).faq_set_id = 'nope'
    })
    expect(problems.join('\n')).toMatch(/faq_set_id 'nope' not in content/)
  })

  it('rejects a widget whose scope disagrees with its content scope', () => {
    const problems = compileExpectingErrors((i) => {
      ;(i.widgets[0] as { scope: string }).scope = 'fb_us'
    })
    expect(problems.join('\n')).toMatch(/scope 'fb_us' != faq_set/)
  })

  it('rejects an invalid scope token', () => {
    const problems = compileExpectingErrors((i) => {
      i.content.faq_sets[0].scope = 'fb_xx'
      ;(i.widgets[0] as { scope: string }).scope = 'fb_xx'
    })
    expect(problems.join('\n')).toMatch(/is not a site id or 'all'/)
  })

  it('rejects a post referencing a non-approved hero image', () => {
    const problems = compileExpectingErrors((i) => {
      i.assets = i.assets.map((a) =>
        a.sha256 === FIXTURE_HERO_SHA ? { ...a, approval_status: 'rejected' as const } : a,
      )
    })
    expect(problems.join('\n')).toMatch(/is 'rejected', not approved/)
  })

  it('rejects a sitemap entry for a noindex post', () => {
    const problems = compileExpectingErrors((i) => {
      i.content.posts[0].noindex = true
    })
    expect(problems.join('\n')).toMatch(/noindex and must not be in the sitemap/)
  })

  it('rejects a duplicate blog route (scope + slug)', () => {
    const problems = compileExpectingErrors((i) => {
      i.content.posts.push({ ...i.content.posts[0], post_id: 'post_two' })
      i.widgets.push({
        widget_id: 'post_widget_two',
        type: 'BlogPost',
        scope: 'all',
        enabled: true,
        post_id: 'post_two',
      })
    })
    expect(problems.join('\n')).toMatch(/duplicate blog route/)
  })

  it('rejects a policy rule referencing an unknown widget', () => {
    const problems = compileExpectingErrors((i) => {
      i.policy.rules[0].widget_ids = ['ghost_widget']
    })
    expect(problems.join('\n')).toMatch(/widget_id 'ghost_widget' not in widgets/)
  })

  it('rejects a kill-list entry that does not resolve', () => {
    const problems = compileExpectingErrors((i) => {
      i.disabledContent = [
        { content_kind: 'post', content_id: 'nonexistent', reason: 'x', effective_at: '2026-06-11T00:00:00Z' },
      ]
    })
    expect(problems.join('\n')).toMatch(/does not exist in the bundle/)
  })

  it('rejects content missing the sanitized variant (schema-level)', () => {
    const problems = compileExpectingErrors((i) => {
      ;(i.content.faq_sets[0].items[0] as { answer_sanitized: string }).answer_sanitized = ''
    })
    expect(problems.length).toBeGreaterThan(0)
  })
})
