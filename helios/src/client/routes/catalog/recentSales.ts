import type { RecentSalesSummary } from '../../../shared/contracts/index.js'

export function describeRecentSales(summary: RecentSalesSummary): {
  detailLabel: string
  tone: 'danger' | 'muted' | 'success'
} {
  if (summary.coverageCount === 0) {
    return {
      detailLabel: 'No sales data',
      tone: 'muted',
    }
  }

  const unitsPerDay = summary.unitsPerDay ?? 0
  if (unitsPerDay >= 1) {
    return {
      detailLabel: `${formatRate(unitsPerDay)} units/day`,
      tone: 'success',
    }
  }

  if (unitsPerDay > 0 && summary.daysPerUnit !== null) {
    return {
      detailLabel: `${formatRate(summary.daysPerUnit)} days/unit`,
      tone: 'danger',
    }
  }

  return {
    detailLabel: 'No recent sales',
    tone: 'danger',
  }
}

export function formatCoverage(summary: RecentSalesSummary): string {
  return `${summary.coverageCount}/${summary.combinationCount} covered`
}

export function formatCurrency(value: number | null): string {
  if (value === null) {
    return '—'
  }

  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(value)
}

export function formatCount(value: number | null): string {
  if (value === null) {
    return '—'
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value)
}

function formatRate(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value >= 10 ? 1 : 2,
    minimumFractionDigits: value >= 10 ? 1 : 2,
  }).format(value)
}
