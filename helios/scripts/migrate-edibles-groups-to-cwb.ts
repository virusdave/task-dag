// Migrate every product group whose category is "Edibles" (id 1086)
// to the new "EdiblesCWB" category (id 7459), preserving each
// group's subcategory by NAME — i.e. a group that lived under
// Edibles/Chocolate (1107) lands at EdiblesCWB/Chocolate (7464).
//
// Behavior:
//   - Includes both enabled and disabled groups (mirrors the
//     2026-05-15-moonys-merge / 2026-05-17 vapes-default-cartridge
//     sweep policy: don't let a re-enable silently leave the group
//     pointing at the wrong category).
//   - Groups with no subcategory are migrated with categoryId only
//     (no subcategoryId set on the new category either).
//   - Groups whose subcategory name has no matching entry under
//     EdiblesCWB are NOT migrated; they're collected into a
//     `failuresOrSkipped` bucket so a human can decide what to do
//     (e.g. create the missing subcategory under EdiblesCWB first).
//
// Usage:
//   npx tsx scripts/migrate-edibles-groups-to-cwb.ts            # dry run
//   npx tsx scripts/migrate-edibles-groups-to-cwb.ts --apply    # writes

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureDealerContext, callSweedRpcRaw } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const SOURCE_CATEGORY_ID = 1086 // Edibles
const TARGET_CATEGORY_ID = 7459 // EdiblesCWB

interface SubcategoryRow {
  id: number
  name: string
  enabled: boolean
}
interface CategoryRow {
  id: number
  name: string
  subcategories?: SubcategoryRow[]
}

interface GroupRow {
  id: number
  fullName?: string
  enabled?: boolean
  category?: { id?: number; name?: string } | null
  subcategory?: { id?: number; name?: string } | null
}

async function fetchAllGroups(): Promise<GroupRow[]> {
  const out: GroupRow[] = []
  let page = 1
  for (;;) {
    // Pass enabled:null so disabled groups are included too — Sweed
    // omits them when the filter is undefined on some endpoints.
    const res = (await callSweedRpcRaw<unknown>('store.product.group.list', {
      page,
      pageSize: 500,
      enabled: null,
    })) as { data?: GroupRow[]; totalCount?: number }
    const data = res.data ?? []
    if (data.length === 0) break
    out.push(...data)
    if (typeof res.totalCount === 'number' && out.length >= res.totalCount) break
    page += 1
  }
  return out
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply')
  const env = getWorkerEnv()
  const startedAt = nowIso()

  const summary: Record<string, unknown> = {
    mode: apply ? 'apply' : 'dryrun',
    startedAt,
    stateDealerId: env.sweedStateDealerId,
    sourceCategoryId: SOURCE_CATEGORY_ID,
    targetCategoryId: TARGET_CATEGORY_ID,
  }

  await withSweedSession(async () => {
    await ensureDealerContext(env.sweedStateDealerId)

    // 1. Build the subcategory name → id map for the TARGET category
    //    by parsing the live category list.
    const cats = (await callSweedRpcRaw<unknown>('store.product.category.list', {})) as CategoryRow[]
    const source = cats.find((c) => c.id === SOURCE_CATEGORY_ID)
    const target = cats.find((c) => c.id === TARGET_CATEGORY_ID)
    if (!source) throw new Error(`Source category id=${SOURCE_CATEGORY_ID} not found.`)
    if (!target) throw new Error(`Target category id=${TARGET_CATEGORY_ID} not found.`)

    const targetSubByName = new Map<string, SubcategoryRow>()
    for (const s of target.subcategories ?? []) {
      targetSubByName.set(s.name.toLowerCase(), s)
    }
    summary.targetSubcategoryByName = Object.fromEntries(
      Array.from(targetSubByName, ([k, v]) => [k, { id: v.id, name: v.name, enabled: v.enabled }]),
    )

    // 2. Fetch every group, filter to source category (enabled+disabled).
    const allGroups = await fetchAllGroups()
    summary.totalGroupsScanned = allGroups.length
    const sourceGroups = allGroups.filter((g) => g.category?.id === SOURCE_CATEGORY_ID)
    summary.sourceGroupCount = sourceGroups.length
    summary.sourceEnabledCount = sourceGroups.filter((g) => g.enabled === true).length
    summary.sourceDisabledCount = sourceGroups.filter((g) => g.enabled === false).length

    // 3. Build per-group plan.
    interface Plan {
      groupId: number
      fullName: string | null
      enabled: boolean | null
      before: { categoryId: number | null; subcategoryId: number | null; subcategoryName: string | null }
      action: 'migrate' | 'skip-no-target-sub'
      editParams?: { id: number; categoryId: number; subcategoryId?: number | null }
      newSubcategoryName?: string | null
      newSubcategoryId?: number | null
      skipReason?: string
    }
    const plans: Plan[] = []
    for (const g of sourceGroups) {
      const beforeSubId = g.subcategory?.id ?? null
      const beforeSubName = g.subcategory?.name ?? null
      let action: Plan['action'] = 'migrate'
      let newSubcategoryId: number | null = null
      let skipReason: string | undefined
      if (beforeSubName) {
        const match = targetSubByName.get(beforeSubName.toLowerCase())
        if (match) {
          newSubcategoryId = match.id
        } else {
          action = 'skip-no-target-sub'
          skipReason = `Source subcategory "${beforeSubName}" has no matching name under target category.`
        }
      }
      const plan: Plan = {
        groupId: g.id,
        fullName: g.fullName ?? null,
        enabled: g.enabled ?? null,
        before: {
          categoryId: g.category?.id ?? null,
          subcategoryId: beforeSubId,
          subcategoryName: beforeSubName,
        },
        action,
        newSubcategoryName: beforeSubName,
        newSubcategoryId,
        skipReason,
      }
      if (action === 'migrate') {
        plan.editParams = beforeSubName
          ? { id: g.id, categoryId: TARGET_CATEGORY_ID, subcategoryId: newSubcategoryId! }
          : { id: g.id, categoryId: TARGET_CATEGORY_ID, subcategoryId: null }
      }
      plans.push(plan)
    }

    const toMigrate = plans.filter((p) => p.action === 'migrate')
    const toSkip = plans.filter((p) => p.action !== 'migrate')
    summary.toMigrateCount = toMigrate.length
    summary.toSkipCount = toSkip.length

    // Tabular summary by subcategory name
    const bySubName: Record<string, { migrate: number; skip: number }> = {}
    for (const p of plans) {
      const k = p.before.subcategoryName ?? '<none>'
      bySubName[k] ??= { migrate: 0, skip: 0 }
      if (p.action === 'migrate') bySubName[k].migrate += 1
      else bySubName[k].skip += 1
    }
    summary.bySourceSubcategoryName = bySubName

    console.log(JSON.stringify({
      mode: summary.mode,
      sourceCategoryId: summary.sourceCategoryId,
      targetCategoryId: summary.targetCategoryId,
      totalGroupsScanned: summary.totalGroupsScanned,
      sourceGroupCount: summary.sourceGroupCount,
      sourceEnabledCount: summary.sourceEnabledCount,
      sourceDisabledCount: summary.sourceDisabledCount,
      toMigrateCount: summary.toMigrateCount,
      toSkipCount: summary.toSkipCount,
      bySourceSubcategoryName: summary.bySourceSubcategoryName,
      targetSubcategoryByName: summary.targetSubcategoryByName,
    }, null, 2))

    if (!apply) {
      summary.plans = plans
      console.log(`\nDRY RUN — pass --apply to execute. (${toMigrate.length} would migrate, ${toSkip.length} would skip)`)
    } else {
      const results: Array<Record<string, unknown>> = []
      const failures: Array<Record<string, unknown>> = []
      for (const plan of plans) {
        if (plan.action !== 'migrate') {
          results.push({ ...plan, applied: false })
          continue
        }
        try {
          const r = await callSweedRpcRaw<unknown>(
            'store.product.group.edit',
            plan.editParams as Record<string, unknown>,
          )
          results.push({ ...plan, applied: true, response: { id: (r as { id?: number }).id } })
          console.log(
            `  [OK]   group ${plan.groupId} ${JSON.stringify(plan.fullName)} ` +
              `subcat ${plan.before.subcategoryName ?? '<none>'} -> ${plan.newSubcategoryName ?? '<none>'}`,
          )
        } catch (err) {
          const failure = { ...plan, applied: false, error: (err as Error).message }
          failures.push(failure)
          results.push(failure)
          console.error(
            `  [FAIL] group ${plan.groupId} ${JSON.stringify(plan.fullName)}: ${(err as Error).message}`,
          )
        }
      }
      summary.results = results
      summary.failures = failures
      console.log(`\nApplied: ${results.filter((r) => r.applied).length}; Failed: ${failures.length}; Skipped (no target sub): ${toSkip.length}`)
    }
  })

  summary.completedAt = nowIso()

  const __filename = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(__filename), '..', '..')
  const outDir = resolve(repoRoot, 'categories', '2026-05-24-edibles-cwb-migrate-groups')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, apply ? 'results_apply.json' : 'results_dryrun.json')
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(`\nWrote ${outPath}`)
  return summary.failures && (summary.failures as unknown[]).length > 0 ? 2 : 0
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
