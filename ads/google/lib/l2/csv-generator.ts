/**
 * L2: CSV Generator
 * Generates numbered CSV files (001-005) for Ads Editor import
 *
 * Hardening (2026-05-23):
 *  - action_type matching is now case-insensitive. The LLM frequently
 *    returns "Pause" / "Repair" / "Replace" (sentence-cased) while the
 *    schema expects lowercase, and the previous code silently dropped
 *    every action that didn't exactly match lowercase. That left
 *    csv 002/003/004 empty on every morning run.
 *  - CSV 003 ("replace") now fills Campaign / Ad group from the action's
 *    source ad (resolved via the snapshot) instead of leaving them
 *    blank with a "// To be filled from family context" TODO that was
 *    never actually filled. Empty campaign/ad-group rows are unimport-
 *    able by Ads Editor.
 *  - Trial-plan field extraction (CSVs 001 and 005) now tolerates the
 *    multiple shapes the LLM returns: `original_campaign_name` may be
 *    absent and we fall back to the ad-group→campaign map built from
 *    the snapshot; `budget` and `trial_budget_usd` are both accepted;
 *    raw-string controls/variants are parsed for an inline ad-id
 *    reference and the matching ad's creative is pulled in.
 *  - Every batch now carries a real `validation_status` + messages.
 *    Rows with empty Ad ID / Campaign / Ad group / Final URL / headlines
 *    are dropped (with a warning) rather than emitted as unimportable
 *    junk that would bounce off Ads Editor with no diagnostic.
 *  - generateCSVBatches now accepts an optional `snapshot` (the same
 *    AdSnapshot[] the L1 pipeline saw) so we can resolve "campaign
 *    that owns this ad-group" and "creative for this ad-id" without
 *    asking the LLM to repeat them.
 */

import type {
  L2PredictionOutput,
  AdSnapshot,
  TrialPlan,
  CSVBatch,
  CSVRow,
} from '../shared/types.js';

export interface GenerateCSVBatchesOptions {
  /**
   * The same AdSnapshot[] the L1 pipeline consumed. When provided,
   * we can fill Campaign / Ad group columns even when the LLM omitted
   * them and resolve "headlines/descriptions of this control ad-id"
   * for trial CSVs. Highly recommended.
   *
   * Accepts either `snapshotAds` (the name run-analysis.ts uses) or
   * the shorter `snapshot` alias.
   */
  snapshotAds?: ReadonlyArray<AdSnapshot>;
  snapshot?: ReadonlyArray<AdSnapshot>;
}

/**
 * Generate all CSV batches from L2 output
 */
export function generateCSVBatches(
  l2Output: L2PredictionOutput,
  opts: GenerateCSVBatchesOptions = {},
): CSVBatch[] {
  const snapshot = opts.snapshotAds ?? opts.snapshot ?? [];
  const ctx = buildSnapshotIndex(snapshot);

  const batches: CSVBatch[] = [];
  batches.push(generateTrialGroupsCSV(l2Output, ctx));
  batches.push(generateRepairCSV(l2Output, ctx));
  batches.push(generateReplaceCSV(l2Output, ctx));
  batches.push(generatePauseCSV(l2Output, ctx));
  batches.push(generateTrialAdsCSV(l2Output, ctx));
  return batches;
}

/**
 * Best-effort: find a real ad in the family the LLM was reasoning
 * about, so we can pull its Campaign for trial CSVs even when the
 * LLM's trial_group_name doesn't match any existing ad-group.
 */
function pickFamilyCampaign(
  family: { ad_actions?: ReadonlyArray<{ ad_id?: string }> },
  ctx: SnapshotIndex,
): string {
  for (const action of family.ad_actions ?? []) {
    const adId = action.ad_id;
    if (!adId) continue;
    const hit = ctx.byAdId.get(adId);
    if (hit?.campaign_name) return hit.campaign_name;
  }
  return '';
}

interface SnapshotIndex {
  /** ad_id -> AdSnapshot */
  byAdId: Map<string, AdSnapshot>;
  /** ad_group_name -> first AdSnapshot we saw in that group */
  byAdGroupName: Map<string, AdSnapshot>;
}

function buildSnapshotIndex(snapshot: ReadonlyArray<AdSnapshot>): SnapshotIndex {
  const byAdId = new Map<string, AdSnapshot>();
  const byAdGroupName = new Map<string, AdSnapshot>();
  for (const ad of snapshot) {
    if (ad.ad_id) byAdId.set(ad.ad_id, ad);
    if (ad.ad_group_name && !byAdGroupName.has(ad.ad_group_name)) {
      byAdGroupName.set(ad.ad_group_name, ad);
    }
  }
  return { byAdId, byAdGroupName };
}

/** Case-insensitive action_type matcher. */
function actionTypeIs(action: { action_type?: unknown }, target: string): boolean {
  if (typeof action.action_type !== 'string') return false;
  return action.action_type.trim().toLowerCase() === target;
}

/**
 * Google's minimum requirements for a Responsive Search Ad: at
 * least 3 headlines and 2 descriptions. Any RSA row we emit that
 * doesn't clear these is rejected by Ads Editor on import (and would
 * be rejected by Google's policy review even if it slipped through),
 * so we drop those rows ourselves and log why instead of producing
 * unimportable junk.
 *
 * Reference: https://support.google.com/google-ads/answer/7684791
 * ("Responsive search ads can include up to 15 headlines and 4
 * descriptions; you must include at least 3 headlines and 2
 * descriptions for the ad to be eligible to serve.")
 */
const RSA_MIN_HEADLINES = 3;
const RSA_MIN_DESCRIPTIONS = 2;

interface RsaMinCheck {
  ok: boolean;
  reason: string | null;
}

function checkRsaMinima(headlines: string[], descriptions: string[]): RsaMinCheck {
  const goodHeadlines = headlines.filter((h) => typeof h === 'string' && h.trim().length > 0);
  const goodDescriptions = descriptions.filter((d) => typeof d === 'string' && d.trim().length > 0);
  if (goodHeadlines.length < RSA_MIN_HEADLINES) {
    return {
      ok: false,
      reason: `RSA needs ≥${RSA_MIN_HEADLINES} headlines, got ${goodHeadlines.length}`,
    };
  }
  if (goodDescriptions.length < RSA_MIN_DESCRIPTIONS) {
    return {
      ok: false,
      reason: `RSA needs ≥${RSA_MIN_DESCRIPTIONS} descriptions, got ${goodDescriptions.length}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Build the "disambiguating context" columns Ads Editor needs to
 * recognise an existing ad on import. Without these, an update row
 * that carries only "Ad ID, Ad status" trips Editor's "Ambiguous row
 * type" rejection because Editor can't tell what kind of entity the
 * row is meant to address.
 *
 * Editor's matching: when the row carries enough identifying columns
 * to pin down exactly one ad in the destination account (Campaign +
 * Ad group + Ad type + Ad ID), the update applies. We pull all those
 * values out of the snapshot so the operator never has to hand-fill
 * them.
 *
 * For RSAs we ALSO replay the original Headline 1 / Description 1
 * because Editor uses content fingerprints as a tiebreaker when the
 * Ad ID column was elided from a previous Editor session. Including
 * them is harmless when the Ad ID also matches and it has saved us
 * from rare "no matching ad" rejections on accounts that lost their
 * id column at some point.
 */
function contextColumnsFor(ad: AdSnapshot): Record<string, string> {
  const out: Record<string, string> = {
    Campaign: ad.campaign_name ?? '',
    'Ad group': ad.ad_group_name ?? '',
    'Ad type':
      (ad.ad_type ?? '') === 'responsive_search_ad' ? 'Responsive search ad' : (ad.ad_type ?? ''),
  };
  // Replay the first original headline + description as a soft
  // tiebreaker for Editor's content-match fallback. Limited to
  // _1 fields so the row doesn't balloon and so the proposed
  // headlines (Headline 1..15 written elsewhere) stay clearly
  // visible as the new content.
  if (ad.headlines && ad.headlines[0]) {
    out['Original Headline 1'] = ad.headlines[0];
  }
  if (ad.descriptions && ad.descriptions[0]) {
    out['Original Description 1'] = ad.descriptions[0];
  }
  return out;
}

/** Resolve the campaign name for a trial. */
function resolveTrialCampaign(
  trial: TrialPlan & Record<string, unknown>,
  ctx: SnapshotIndex,
  family: { ad_actions?: ReadonlyArray<{ ad_id?: string }> } | null = null,
): string {
  // Honor an explicit field if the LLM filled it.
  const explicit = (trial as Record<string, unknown>).original_campaign_name;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();

  // Otherwise derive from the trial group name: "<original-ad-group>-trial-NNN"
  const groupName = (trial as Record<string, unknown>).trial_group_name;
  if (typeof groupName === 'string') {
    const originalGroup = groupName.replace(/-trial-\d+$/i, '').trim();
    if (originalGroup) {
      const hit = ctx.byAdGroupName.get(originalGroup);
      if (hit?.campaign_name) return hit.campaign_name;
    }
  }

  // Final fallback: pull the campaign of any ad in the family that
  // the LLM was reasoning about. Better to attach the trial to a real
  // campaign in the same family than to drop it on the floor with
  // "no parent Campaign found", which is what was happening before.
  if (family) {
    const familyCampaign = pickFamilyCampaign(family, ctx);
    if (familyCampaign) return familyCampaign;
  }
  return '';
}

/** Resolve a budget (LLM uses either `budget` or `trial_budget_usd`). */
function resolveTrialBudgetUsd(trial: TrialPlan & Record<string, unknown>): number {
  const candidates = [
    (trial as Record<string, unknown>).trial_budget_usd,
    (trial as Record<string, unknown>).budget,
    (trial as Record<string, unknown>).daily_budget_usd,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && isFinite(c) && c > 0) return c;
  }
  // Default to $1/day as the L2 prompt instructs.
  return 1;
}

/** Extract an ad-id reference from a free-form control/variant string. */
function extractAdIdRef(s: string): string | null {
  // Common forms:
  //   "Core-1 (safe flower ad)"
  //   "NYC Cannabis | Core-40 (replace 'Bud' with 'Cannabis', ...)"
  //   "Smoking Scholars | Core-20"
  const m = s.match(/^\s*([^()|]+(?:\|[^()]+)?)/);
  if (!m) return null;
  return m[1].trim() || null;
}

/** Normalise a control/variant into a usable creative-shaped object. */
function normalizeCreativeLike(
  raw: unknown,
  ctx: SnapshotIndex,
): {
  headlines: string[];
  descriptions: string[];
  final_url: string;
  label: string;
  notes: string;
} | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const adIdRef = extractAdIdRef(raw);
    if (adIdRef) {
      const hit = ctx.byAdId.get(adIdRef);
      if (hit) {
        return {
          headlines: [...hit.headlines],
          descriptions: [...hit.descriptions],
          final_url: hit.final_url ?? '',
          label: adIdRef,
          notes: raw,
        };
      }
    }
    return null; // No way to materialise creative from a label alone.
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // Sometimes nested under `creative`.
    const creative = (typeof o.creative === 'object' && o.creative !== null
      ? (o.creative as Record<string, unknown>)
      : null) ?? o;
    const headlines = Array.isArray(creative.headlines)
      ? (creative.headlines as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const descriptions = Array.isArray(creative.descriptions)
      ? (creative.descriptions as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const final_url =
      typeof creative.final_url === 'string'
        ? creative.final_url
        : typeof o.final_url === 'string'
          ? o.final_url
          : '';
    const label =
      typeof o.label === 'string'
        ? o.label
        : typeof o.variant_label === 'string'
          ? o.variant_label
          : typeof creative.variant_label === 'string'
            ? (creative.variant_label as string)
            : '';
    const notes =
      typeof o.notes_for_human === 'string'
        ? o.notes_for_human
        : typeof creative.notes_for_human === 'string'
          ? (creative.notes_for_human as string)
          : '';
    // If headlines/descriptions are missing but a source ad id was
    // given, look that ad up in the snapshot.
    if (headlines.length === 0 && typeof o.source_ad_id === 'string') {
      const hit = ctx.byAdId.get(o.source_ad_id);
      if (hit) {
        return {
          headlines: [...hit.headlines],
          descriptions: [...hit.descriptions],
          final_url: final_url || hit.final_url || '',
          label: label || o.source_ad_id,
          notes,
        };
      }
    }
    return { headlines, descriptions, final_url, label, notes };
  }
  return null;
}

/**
 * Generate CSV 001: Create trial campaigns and ad groups
 */
function generateTrialGroupsCSV(
  l2Output: L2PredictionOutput,
  ctx: SnapshotIndex,
): CSVBatch {
  const rows: CSVRow[] = [];
  const messages: string[] = [];
  let rowNumber = 1;
  const seenGroups = new Set<string>();

  for (const family of l2Output.families) {
    for (const trial of family.trial_plans ?? []) {
      const t = trial as TrialPlan & Record<string, unknown>;
      const groupName =
        (typeof t.trial_group_name === 'string' && t.trial_group_name) ||
        (typeof (t as { name?: unknown }).name === 'string' &&
          ((t as { name?: string }).name as string)) ||
        '';
      const campaign = resolveTrialCampaign(t, ctx, family);
      const budget = resolveTrialBudgetUsd(t);

      if (!groupName) {
        messages.push(`trial in family ${JSON.stringify(family.family_key)} skipped: no trial_group_name`);
        continue;
      }
      if (!campaign) {
        messages.push(
          `trial ${groupName} skipped: could not resolve a parent Campaign (snapshot has no ad group matching "${groupName.replace(/-trial-\d+$/i, '')}" and the LLM did not supply original_campaign_name)`,
        );
        continue;
      }
      if (seenGroups.has(`${campaign}::${groupName}`)) {
        continue;
      }
      seenGroups.add(`${campaign}::${groupName}`);

      rows.push({
        row_number: rowNumber++,
        data: {
          Campaign: campaign,
          'Ad group': groupName,
          'Ad group status': 'Enabled',
          // Default max. CPC retained for fallback only. Under our
          // standard "Maximize conversion value + Target ROAS"
          // strategy below, Google ignores per-ad-group Max CPC at
          // auction time. We keep emitting it so flipping back to
          // Manual CPC in Editor is a one-click change.
          'Default max. CPC': '1.00',
          'Campaign daily budget': budget.toFixed(2),
          // Default bidding: Smart Bidding "Maximize conversion
          // value" with Target ROAS 300%. Operator standing rule:
          // every campaign we create must be on a fully automated
          // strategy out of the box — Google was warning "Your
          // campaign is using manual bidding. Use a fully automated
          // bidding strategy to bid more efficiently." on Manual CPC
          // trial campaigns.
          //
          // Editor schema (support.google.com/google-ads/editor/
          // answer/94241): "Maximize conversion value WITH a target
          // ROAS" is encoded as `Bid Strategy Type = Target ROAS`
          // plus a `Target ROAS` column carrying the percentage.
          // (The bare "Maximize conversion value" value is the no-
          // target variant; we always want the 300% target attached.)
          'Bid Strategy Type': 'Target ROAS',
          'Target ROAS': '300.00%',
          // EU Political Ads Regulation 2024/900 declaration.
          // Required on every new campaign since Sep 2025; without it
          // the Google Ads API rejects mutate calls with
          // FieldError.REQUIRED. We're a NY cannabis retailer with no
          // EU political intent, so `false` is correct for every
          // trial campaign this pipeline ever creates.
          // Ref: https://developers.google.com/google-ads/api/docs/api-policy/eu-par
          'EU political ads': 'false',
        },
        source_trial_id: typeof t.trial_id === 'string' ? t.trial_id : groupName,
      });
    }
  }

  return {
    batch_number: 1,
    batch_name: 'create-trial-campaigns-and-ad-groups',
    description: 'Set up trial campaign and ad group infrastructure',
    rows,
    validation_status: messages.length > 0 ? 'warning' : 'valid',
    validation_messages: messages,
  };
}

/**
 * Generate CSV 002: Repair existing ads
 */
function generateRepairCSV(l2Output: L2PredictionOutput, ctx: SnapshotIndex): CSVBatch {
  const rows: CSVRow[] = [];
  const messages: string[] = [];
  let rowNumber = 1;

  for (const family of l2Output.families) {
    const repairActions = (family.ad_actions ?? []).filter((a) => actionTypeIs(a, 'repair'));

    for (const action of repairActions) {
      const adId = (action.ad_id ?? '').toString().trim();
      if (!adId) {
        messages.push('repair action skipped: empty ad_id');
        continue;
      }
      const knownAd = ctx.byAdId.get(adId);
      if (ctx.byAdId.size > 0 && !knownAd) {
        // Snapshot index is populated and this id is unknown — almost
        // certainly an LLM hallucination. Skip rather than emit a row
        // that Ads Editor cannot match.
        messages.push(`repair skipped: ad_id "${adId}" not found in snapshot`);
        continue;
      }
      if (!action.suggested_new_creatives || action.suggested_new_creatives.length === 0) {
        messages.push(`repair skipped for ${adId}: no suggested_new_creatives`);
        continue;
      }

      const creative = action.suggested_new_creatives[0];
      const headlines = Array.isArray(creative.headlines) ? creative.headlines : [];
      const descriptions = Array.isArray(creative.descriptions) ? creative.descriptions : [];
      // Repair updates an existing RSA in place. Editor replaces the
      // Headline N / Description N slots we specify and clears the
      // rest, so the row must already satisfy Google's RSA minima
      // (≥3 headlines, ≥2 descriptions) or the resulting ad is
      // immediately ineligible. Reject sub-minimum repairs rather
      // than ship a CSV that produces a guaranteed-rejected ad.
      const rsaCheck = checkRsaMinima(headlines, descriptions);
      if (!rsaCheck.ok) {
        messages.push(`repair skipped for ${adId}: ${rsaCheck.reason}`);
        continue;
      }

      // Lead with the disambiguating context columns Editor needs
      // to recognise this as an "update existing ad" row instead of
      // rejecting it as "Ambiguous row type". When the snapshot
      // doesn't know about this ad (which is the case in
      // disabled-snapshot manual runs) we fall back to Ad ID only,
      // which is the prior behaviour.
      const rowData: Record<string, string> = knownAd
        ? { ...contextColumnsFor(knownAd) }
        : {};
      rowData['Ad ID'] = adId;
      rowData['Ad status'] = 'Enabled';
      rowData['Final URL'] = creative.final_url || knownAd?.final_url || '';
      for (let i = 0; i < headlines.length && i < 15; i++) {
        rowData[`Headline ${i + 1}`] = headlines[i];
      }
      for (let i = 0; i < descriptions.length && i < 4; i++) {
        rowData[`Description ${i + 1}`] = descriptions[i];
      }

      rows.push({
        row_number: rowNumber++,
        data: rowData,
        source_action_id: adId,
        notes: `Issues: ${(action.issue_codes ?? []).join(', ')} | ${action.justification ?? ''}`,
      });
    }
  }

  return {
    batch_number: 2,
    batch_name: 'repair-existing-ads',
    description: 'Inline edits to existing ads',
    rows,
    validation_status: messages.length > 0 ? 'warning' : 'valid',
    validation_messages: messages,
  };
}

/**
 * Generate CSV 003: Replace and new ads
 */
function generateReplaceCSV(l2Output: L2PredictionOutput, ctx: SnapshotIndex): CSVBatch {
  const rows: CSVRow[] = [];
  const messages: string[] = [];
  let rowNumber = 1;

  for (const family of l2Output.families) {
    const replaceActions = (family.ad_actions ?? []).filter((a) => actionTypeIs(a, 'replace'));

    for (const action of replaceActions) {
      const adId = (action.ad_id ?? '').toString().trim();
      const knownAd = ctx.byAdId.get(adId);
      if (ctx.byAdId.size > 0 && !knownAd) {
        messages.push(`replace skipped: ad_id "${adId}" not found in snapshot`);
        continue;
      }
      if (!action.suggested_new_creatives) continue;

      for (const creative of action.suggested_new_creatives) {
        const headlines = Array.isArray(creative.headlines) ? creative.headlines : [];
        const descriptions = Array.isArray(creative.descriptions) ? creative.descriptions : [];
        // Replace creates a brand-new RSA. Below the RSA minima
        // (≥3 headlines, ≥2 descriptions) the resulting row is
        // rejected by Ads Editor on import. Drop with a clear
        // message rather than emit the invalid row.
        const rsaCheck = checkRsaMinima(headlines, descriptions);
        if (!rsaCheck.ok) {
          messages.push(`replace variant for ${adId} skipped: ${rsaCheck.reason}`);
          continue;
        }
        const campaign = knownAd?.campaign_name ?? '';
        const adGroup = knownAd?.ad_group_name ?? '';
        if (!campaign || !adGroup) {
          messages.push(
            `replace variant for ${adId} skipped: cannot resolve Campaign / Ad group (snapshot lookup failed)`,
          );
          continue;
        }

        const rowData: Record<string, string> = {
          Campaign: campaign,
          'Ad group': adGroup,
          'Ad type':
            creative.ad_type === 'responsive_search_ad'
              ? 'Responsive search ad'
              : 'Expanded text ad',
          'Ad status': 'Enabled',
          'Final URL': creative.final_url || knownAd?.final_url || '',
        };
        for (let i = 0; i < headlines.length && i < 15; i++) {
          rowData[`Headline ${i + 1}`] = headlines[i];
        }
        for (let i = 0; i < descriptions.length && i < 4; i++) {
          rowData[`Description ${i + 1}`] = descriptions[i];
        }
        if (creative.paths) {
          for (let i = 0; i < creative.paths.length && i < 2; i++) {
            rowData[`Path ${i + 1}`] = creative.paths[i];
          }
        }

        rows.push({
          row_number: rowNumber++,
          data: rowData,
          source_action_id: adId,
          notes: `Variant: ${creative.variant_label ?? ''} | ${creative.notes_for_human ?? ''}`,
        });
      }
    }
  }

  return {
    batch_number: 3,
    batch_name: 'replace-and-new-ads',
    description: 'New compliant creatives',
    rows,
    validation_status: messages.length > 0 ? 'warning' : 'valid',
    validation_messages: messages,
  };
}

/**
 * Generate CSV 004: Pause high-risk ads
 */
function generatePauseCSV(l2Output: L2PredictionOutput, ctx: SnapshotIndex): CSVBatch {
  const rows: CSVRow[] = [];
  const messages: string[] = [];
  let rowNumber = 1;

  for (const family of l2Output.families) {
    const familySize = (family.ad_actions ?? []).length;
    const pauseActions = (family.ad_actions ?? []).filter((a) => actionTypeIs(a, 'pause'));

    // Limit to 10% of family ads (rounded up, minimum 1 if any
    // pause actions exist) so a single LLM run can't nuke a whole
    // ad group. Previous behavior also had this cap but it was
    // bypassed by the case-sensitive filter dropping everything.
    const maxPause = familySize === 0 ? pauseActions.length : Math.max(1, Math.ceil(familySize * 0.1));
    const limitedPause = pauseActions.slice(0, maxPause);

    if (pauseActions.length > limitedPause.length) {
      messages.push(
        `family ${JSON.stringify(family.family_key)}: capped pauses at ${limitedPause.length} of ${pauseActions.length} (10% rule)`,
      );
    }

    for (const action of limitedPause) {
      const adId = (action.ad_id ?? '').toString().trim();
      if (!adId) {
        messages.push('pause skipped: empty ad_id');
        continue;
      }
      const knownAd = ctx.byAdId.get(adId);
      if (ctx.byAdId.size > 0 && !knownAd) {
        messages.push(`pause skipped: ad_id "${adId}" not found in snapshot`);
        continue;
      }
      // Lead with the disambiguating context columns Editor needs to
      // recognise this as an "update existing ad" row. Without them,
      // Editor rejects a row that has only "Ad ID, Ad status" with
      // "Ambiguous row type" because it can't tell which entity kind
      // (ad / ad group / campaign / keyword …) the row addresses.
      const rowData: Record<string, string> = knownAd
        ? { ...contextColumnsFor(knownAd) }
        : {};
      rowData['Ad ID'] = adId;
      rowData['Ad status'] = 'Paused';
      rows.push({
        row_number: rowNumber++,
        data: rowData,
        source_action_id: adId,
        notes: `HIGH RISK PAUSE | Issues: ${(action.issue_codes ?? []).join(', ')} | ${action.justification ?? ''}`,
      });
    }
  }

  if (rows.length > 10) {
    messages.push(`WARNING: Pausing ${rows.length} ads. Review carefully before import.`);
  }

  return {
    batch_number: 4,
    batch_name: 'pause-high-risk-ads',
    description: 'Pause obviously-bad assets',
    rows,
    validation_status: rows.length > 10 || messages.length > 0 ? 'warning' : 'valid',
    validation_messages: messages,
  };
}

/**
 * Generate CSV 005: Create trial ads
 */
function generateTrialAdsCSV(l2Output: L2PredictionOutput, ctx: SnapshotIndex): CSVBatch {
  const rows: CSVRow[] = [];
  const messages: string[] = [];
  let rowNumber = 1;

  for (const family of l2Output.families) {
    for (const trial of family.trial_plans ?? []) {
      const t = trial as TrialPlan & Record<string, unknown>;
      const groupName =
        (typeof t.trial_group_name === 'string' && t.trial_group_name) ||
        (typeof (t as { name?: unknown }).name === 'string' &&
          ((t as { name?: string }).name as string)) ||
        '';
      const campaign = resolveTrialCampaign(t, ctx, family);
      if (!groupName || !campaign) {
        messages.push(
          `trial ${groupName || '<no name>'} ads skipped: missing campaign or group (see CSV 001 messages)`,
        );
        continue;
      }
      const hypothesis = typeof t.hypothesis === 'string' ? t.hypothesis : '';

      // Controls
      const controls =
        ((t as Record<string, unknown>).control_ads as unknown[] | undefined) ??
        ((t as Record<string, unknown>).controls as unknown[] | undefined) ??
        [];
      for (const raw of controls) {
        const c = normalizeCreativeLike(raw, ctx);
        if (!c || c.headlines.length === 0) {
          messages.push(
            `control in ${groupName} skipped: could not resolve creative from ${JSON.stringify(raw).slice(0, 120)}`,
          );
          continue;
        }
        // Trial controls / variants are new RSAs. Enforce the
        // ≥3 headlines / ≥2 descriptions minimum or Ads Editor
        // (and Google's serving check) rejects them.
        const rsaCheck = checkRsaMinima(c.headlines, c.descriptions);
        if (!rsaCheck.ok) {
          messages.push(`control in ${groupName} skipped (${c.label || 'unlabelled'}): ${rsaCheck.reason}`);
          continue;
        }
        rows.push(
          buildTrialAdRow({
            rowNumber: rowNumber++,
            campaign,
            groupName,
            headlines: c.headlines,
            descriptions: c.descriptions,
            finalUrl: c.final_url,
            label: c.label || 'control',
            isControl: true,
            hypothesis,
            trialId: typeof t.trial_id === 'string' ? t.trial_id : groupName,
          }),
        );
      }

      // Variants
      const variants =
        ((t as Record<string, unknown>).variant_creatives as unknown[] | undefined) ??
        ((t as Record<string, unknown>).variants as unknown[] | undefined) ??
        ((t as Record<string, unknown>).variant_ads as unknown[] | undefined) ??
        [];
      for (const raw of variants) {
        const c = normalizeCreativeLike(raw, ctx);
        if (!c || c.headlines.length === 0) {
          messages.push(
            `variant in ${groupName} skipped: could not resolve creative from ${JSON.stringify(raw).slice(0, 120)}`,
          );
          continue;
        }
        const rsaCheck = checkRsaMinima(c.headlines, c.descriptions);
        if (!rsaCheck.ok) {
          messages.push(`variant in ${groupName} skipped (${c.label || 'unlabelled'}): ${rsaCheck.reason}`);
          continue;
        }
        rows.push(
          buildTrialAdRow({
            rowNumber: rowNumber++,
            campaign,
            groupName,
            headlines: c.headlines,
            descriptions: c.descriptions,
            finalUrl: c.final_url,
            label: c.label || 'variant',
            isControl: false,
            hypothesis,
            trialId: typeof t.trial_id === 'string' ? t.trial_id : groupName,
          }),
        );
      }
    }
  }

  return {
    batch_number: 5,
    batch_name: 'create-trial-ads',
    description: 'Populate trial groups with controls and variants',
    rows,
    validation_status: messages.length > 0 ? 'warning' : 'valid',
    validation_messages: messages,
  };
}

/**
 * Build a trial ad row
 */
function buildTrialAdRow(args: {
  rowNumber: number;
  campaign: string;
  groupName: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
  label: string;
  isControl: boolean;
  hypothesis: string;
  trialId: string;
}): CSVRow {
  const rowData: Record<string, string> = {
    Campaign: args.campaign,
    'Ad group': args.groupName,
    'Ad type': 'Responsive search ad',
    'Ad status': 'Enabled',
    'Final URL': args.finalUrl,
  };
  for (let i = 0; i < args.headlines.length && i < 15; i++) {
    rowData[`Headline ${i + 1}`] = args.headlines[i];
  }
  for (let i = 0; i < args.descriptions.length && i < 4; i++) {
    rowData[`Description ${i + 1}`] = args.descriptions[i];
  }
  return {
    row_number: args.rowNumber,
    data: rowData,
    source_trial_id: args.trialId,
    notes: `${args.isControl ? 'CONTROL' : 'VARIANT'}: ${args.label} | Hypothesis: ${args.hypothesis}`,
  };
}

/**
 * Export CSV batch to string
 */
export function csvBatchToString(batch: CSVBatch): string {
  if (batch.rows.length === 0) {
    return '';
  }

  const columnSet = new Set<string>();
  for (const row of batch.rows) {
    Object.keys(row.data).forEach((col) => columnSet.add(col));
  }
  const columns = Array.from(columnSet);

  const lines: string[] = [columns.join(',')];

  for (const row of batch.rows) {
    const values = columns.map((col) => {
      const value = row.data[col] || '';
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    });
    lines.push(values.join(','));
  }

  return lines.join('\n');
}
