import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import {
  ScreensInventoryResponseSchema,
  type ScreensInventoryResponse,
  listHeliosScreensSiteDealers,
} from '../../shared/contracts/index.js'

const RefreshArtifactSchema = z.object({
  finishedAt: z.string().optional(),
  mode: z.enum(['apply', 'dry-run']).optional(),
  siteDealers: z.array(z.object({
    dealerId: z.number().int().positive(),
    dealerName: z.string().trim().min(1),
    screens: z.array(z.object({
      banners: z.array(z.object({
        bannerId: z.union([z.string(), z.number()]).transform((value) => String(value)),
        bannerName: z.string().trim().min(1),
        duration: z.number().int().nullable().optional(),
        finalEnabled: z.boolean().optional(),
        finalTotalDuration: z.number().int().nullable().optional(),
        originalEnabled: z.boolean().optional(),
        originalTotalDuration: z.number().int().nullable().optional(),
        promoActionId: z.union([z.string(), z.number()]).transform((value) => String(value)).nullable().optional(),
        totalDuration: z.number().int().nullable().optional(),
        type: z.string().trim().min(1),
      }).passthrough()),
      screenId: z.number().int().positive(),
      screenName: z.string().trim().min(1),
      screenToggle: z.object({
        finalEnabled: z.boolean().optional(),
        originalEnabled: z.boolean().optional(),
      }).passthrough().optional(),
    }).passthrough()),
  }).passthrough()),
  startedAt: z.string().optional(),
}).passthrough()

const DirectReadbackArtifactSchema = z.object({
  readAt: z.string(),
  sites: z.array(z.object({
    dealerId: z.number().int().positive(),
    dealerName: z.string().trim().min(1),
    screens: z.array(z.object({
      banners: z.array(z.object({
        bannerId: z.union([z.string(), z.number()]).transform((value) => String(value)),
        bannerName: z.string().trim().min(1),
        duration: z.number().int().nullable().optional(),
        enabled: z.boolean(),
        promoActionId: z.union([z.string(), z.number()]).transform((value) => String(value)).nullable().optional(),
        totalDuration: z.number().int().nullable().optional(),
        type: z.string().trim().min(1),
      }).passthrough()),
      screenEnabled: z.boolean().nullable().optional(),
      screenId: z.number().int().positive(),
      screenName: z.string().trim().min(1),
      totalScreenDuration: z.number().int().nullable().optional(),
    }).passthrough()),
  }).passthrough()),
}).passthrough()

interface ArtifactCandidate {
  filePath: string
  modifiedAtMs: number
}

export async function loadScreensInventory(): Promise<ScreensInventoryResponse> {
  const configuredSiteDealers = listHeliosScreensSiteDealers().map((dealer) => dealer.dealerId)
  const artifact = await findLatestInventoryArtifact()

  if (!artifact) {
    return ScreensInventoryResponseSchema.parse({
      configuredSiteDealers,
      inventorySource: null,
      sites: [],
      summary: {
        bannerCount: 0,
        imageBannerCount: 0,
        screenCount: 0,
        siteCount: 0,
        zeroDurationBannerCount: 0,
      },
    })
  }

  const fileContents = await readFile(artifact.filePath, 'utf-8')
  const parsedJson = JSON.parse(fileContents) as unknown
  const normalized = normalizeArtifact(parsedJson, artifact.filePath)

  return ScreensInventoryResponseSchema.parse({
    configuredSiteDealers,
    ...normalized,
  })
}

async function findLatestInventoryArtifact(): Promise<ArtifactCandidate | null> {
  const directories = [
    resolve(process.cwd(), 'runtime-artifacts/screens'),
  ]
  const candidates: ArtifactCandidate[] = []

  for (const directoryPath of directories) {
    const entryNames = await safeReadDir(directoryPath)
    for (const entryName of entryNames) {
      if (!isInventoryArtifactFile(entryName)) {
        continue
      }

      const filePath = resolve(directoryPath, entryName)
      const fileStat = await safeStat(filePath)
      if (!fileStat?.isFile()) {
        continue
      }

      candidates.push({
        filePath,
        modifiedAtMs: fileStat.mtimeMs,
      })
    }
  }

  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
  return candidates[0] ?? null
}

function normalizeArtifact(parsedJson: unknown, artifactPath: string): Omit<ScreensInventoryResponse, 'configuredSiteDealers'> {
  const refreshArtifact = RefreshArtifactSchema.safeParse(parsedJson)
  if (refreshArtifact.success) {
    const sites = refreshArtifact.data.siteDealers.map((site) => ({
      dealerId: site.dealerId,
      dealerName: site.dealerName,
      screens: site.screens.map((screen) => ({
        banners: screen.banners.map((banner) => ({
          bannerId: banner.bannerId,
          bannerName: banner.bannerName,
          duration: banner.duration ?? null,
          enabled: banner.finalEnabled ?? banner.originalEnabled ?? false,
          promoActionId: banner.promoActionId ?? null,
          totalDuration: banner.finalTotalDuration ?? banner.totalDuration ?? banner.originalTotalDuration ?? null,
          type: banner.type,
        })),
        screenEnabled: screen.screenToggle?.finalEnabled ?? screen.screenToggle?.originalEnabled ?? null,
        screenId: screen.screenId,
        screenName: screen.screenName,
        totalScreenDuration: null,
      })),
    }))

    return {
      inventorySource: {
        artifactKind: 'refresh_run',
        artifactPath,
        capturedAt: refreshArtifact.data.finishedAt ?? refreshArtifact.data.startedAt ?? new Date(0).toISOString(),
        mode: normalizeRunMode(refreshArtifact.data.mode ?? null),
      },
      sites,
      summary: summarizeSites(sites),
    }
  }

  const directReadbackArtifact = DirectReadbackArtifactSchema.parse(parsedJson)
  const sites = directReadbackArtifact.sites.map((site) => ({
    dealerId: site.dealerId,
    dealerName: site.dealerName,
    screens: site.screens.map((screen) => ({
      banners: screen.banners.map((banner) => ({
        bannerId: banner.bannerId,
        bannerName: banner.bannerName,
        duration: banner.duration ?? null,
        enabled: banner.enabled,
        promoActionId: banner.promoActionId ?? null,
        totalDuration: banner.totalDuration ?? null,
        type: banner.type,
      })),
      screenEnabled: screen.screenEnabled ?? null,
      screenId: screen.screenId,
      screenName: screen.screenName,
      totalScreenDuration: screen.totalScreenDuration ?? null,
    })),
  }))

  return {
    inventorySource: {
      artifactKind: 'direct_readback',
      artifactPath,
      capturedAt: directReadbackArtifact.readAt,
      mode: null,
    },
    sites,
    summary: summarizeSites(sites),
  }
}

function summarizeSites(sites: ScreensInventoryResponse['sites']): ScreensInventoryResponse['summary'] {
  let screenCount = 0
  let bannerCount = 0
  let imageBannerCount = 0
  let zeroDurationBannerCount = 0

  for (const site of sites) {
    screenCount += site.screens.length
    for (const screen of site.screens) {
      bannerCount += screen.banners.length
      for (const banner of screen.banners) {
        if (banner.type.toLowerCase() === 'image') {
          imageBannerCount += 1
        }
        if (banner.totalDuration === 0) {
          zeroDurationBannerCount += 1
        }
      }
    }
  }

  return {
    bannerCount,
    imageBannerCount,
    screenCount,
    siteCount: sites.length,
    zeroDurationBannerCount,
  }
}

function normalizeRunMode(mode: 'apply' | 'dry-run' | null): 'apply' | 'dry_run' | null {
  if (mode === 'apply') {
    return 'apply'
  }
  if (mode === 'dry-run') {
    return 'dry_run'
  }
  return null
}

function isInventoryArtifactFile(fileName: string): boolean {
  return (
    /^screens-banner-refresh-job-.*\.json$/i.test(fileName) ||
    /^screen_banner_refresh_results.*\.json$/i.test(fileName) ||
    /^banner_direct_readback(_post_refresh.*)?\.json$/i.test(fileName)
  )
}

async function safeReadDir(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath)
  } catch {
    return []
  }
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}
