import { describe, expect, it } from 'vitest'

import {
  isGenerationMode,
  isTopicCategory,
  isValidScheduleKey,
  MAX_FB_NEWS_WEIGHT,
  MAX_POSTS_PER_WEEK,
  newPromptScheduleId,
  PROMPT_SCHEDULE_ID_RE,
  validatePromptScheduleConfig,
  type PromptScheduleConfigInput,
} from './promptSchedule.js'

function baseConfig(
  overrides: Partial<PromptScheduleConfigInput> = {},
): PromptScheduleConfigInput {
  return {
    postsPerWeek: 2,
    mode: 'dual',
    topicMix: [
      { category: 'local_culture', weight: 55 },
      { category: 'industry_news', weight: 30 },
      { category: 'fb_news', weight: 15 },
    ],
    promptTemplates: { article_brief: 'Write a useful local post.' },
    ...overrides,
  }
}

describe('newPromptScheduleId', () => {
  it('mints an id matching the frozen format (UTC)', () => {
    const id = newPromptScheduleId(new Date('2026-06-17T08:09:10Z'))
    expect(id).toMatch(PROMPT_SCHEDULE_ID_RE)
    expect(id.startsWith('seopsch_2026-06-17_080910_')).toBe(true)
  })
})

describe('vocabulary guards', () => {
  it('isValidScheduleKey accepts kebab, rejects junk', () => {
    expect(isValidScheduleKey('weekly-nyc-mix')).toBe(true)
    for (const bad of ['Weekly', 'a_b', 'a b', '-a', 'a-', '']) {
      expect(isValidScheduleKey(bad)).toBe(false)
    }
  })

  it('isTopicCategory / isGenerationMode reflect the allowed sets', () => {
    expect(isTopicCategory('local_culture')).toBe(true)
    expect(isTopicCategory('bogus')).toBe(false)
    expect(isGenerationMode('dual')).toBe(true)
    expect(isGenerationMode('partial')).toBe(false)
  })
})

describe('validatePromptScheduleConfig', () => {
  it('accepts a well-formed config', () => {
    expect(validatePromptScheduleConfig(baseConfig())).toEqual([])
  })

  it('rejects a non-integer or out-of-range cadence', () => {
    expect(validatePromptScheduleConfig(baseConfig({ postsPerWeek: 2.5 }))).toHaveLength(1)
    expect(validatePromptScheduleConfig(baseConfig({ postsPerWeek: 0 }))).toHaveLength(1)
    expect(
      validatePromptScheduleConfig(baseConfig({ postsPerWeek: MAX_POSTS_PER_WEEK + 1 })),
    ).toHaveLength(1)
    expect(validatePromptScheduleConfig(baseConfig({ postsPerWeek: MAX_POSTS_PER_WEEK }))).toEqual(
      [],
    )
  })

  it('rejects an unknown generation mode', () => {
    const problems = validatePromptScheduleConfig(baseConfig({ mode: 'nope' }))
    expect(problems.map((p) => p.field)).toContain('mode')
  })

  it('requires a non-empty topic mix', () => {
    const problems = validatePromptScheduleConfig(baseConfig({ topicMix: [] }))
    expect(problems.map((p) => p.field)).toContain('topicMix')
  })

  it('rejects weights that do not sum to 100', () => {
    const problems = validatePromptScheduleConfig(
      baseConfig({
        topicMix: [
          { category: 'local_culture', weight: 60 },
          { category: 'industry_news', weight: 30 },
        ],
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('sum to 100')
  })

  it('rejects an unknown category', () => {
    const problems = validatePromptScheduleConfig(
      baseConfig({
        topicMix: [
          { category: 'mystery', weight: 50 },
          { category: 'local_culture', weight: 50 },
        ],
      }),
    )
    expect(problems.some((p) => p.message.includes('Unknown topic category'))).toBe(true)
  })

  it('rejects a duplicate category', () => {
    const problems = validatePromptScheduleConfig(
      baseConfig({
        topicMix: [
          { category: 'local_culture', weight: 50 },
          { category: 'local_culture', weight: 50 },
        ],
      }),
    )
    expect(problems.some((p) => p.message.includes('Duplicate topic category'))).toBe(true)
  })

  it('rejects a weight outside [0,100] or non-integer', () => {
    expect(
      validatePromptScheduleConfig(
        baseConfig({
          topicMix: [
            { category: 'local_culture', weight: 101 },
            { category: 'industry_news', weight: -1 },
          ],
        }),
      ).length,
    ).toBeGreaterThan(0)
  })

  it('enforces the FB-news self-promotion cap', () => {
    const problems = validatePromptScheduleConfig(
      baseConfig({
        topicMix: [
          { category: 'fb_news', weight: MAX_FB_NEWS_WEIGHT + 5 },
          { category: 'local_culture', weight: 100 - (MAX_FB_NEWS_WEIGHT + 5) },
        ],
      }),
    )
    expect(problems.some((p) => p.message.includes('fb_news'))).toBe(true)
  })

  it('rejects an unknown prompt-template key', () => {
    const problems = validatePromptScheduleConfig(
      baseConfig({ promptTemplates: { not_a_real_template: 'x' } }),
    )
    expect(problems.some((p) => p.field === 'promptTemplates')).toBe(true)
  })
})
