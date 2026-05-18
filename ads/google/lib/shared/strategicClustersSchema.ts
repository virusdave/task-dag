/**
 * Strategic-clusters config schema + loader.
 *
 * The operator-curated `ads/google/config/strategic-clusters.yaml` file
 * is the single source-of-truth for the strategic-cluster intent that
 * both the gads L2 cluster-sweep and the landing-pages L2 cluster mode
 * (in mostly-static-sites) reconcile against current campaign and
 * landing-page state.
 *
 * Provenance: operator-driven Gemini session
 *   https://gemini.google.com/share/638489c01b1b
 *
 * Schema design notes:
 *   - Every field is explicit; the validator rejects unknown top-level
 *     fields so a typo in the yaml fails loud at load time.
 *   - `target_query_patterns` and `seed_keyword_examples` are split
 *     because the L2 uses the former for negative-keyword discovery
 *     (don't bid against ourselves on a different cluster's pattern)
 *     and the latter as concrete keyword candidates for an Ads-Editor
 *     CSV. They overlap in practice but the semantics differ.
 *   - `reconciliation_hint` is free-text by design: the L2 reads it as
 *     operator context for the reconcile decision rather than as a
 *     hard rule. The verdicts themselves are constrained by the L2
 *     output schema, not by this file.
 *   - This module deliberately avoids the `zod` dependency so it stays
 *     usable from both the `ads/google/` scripts (no zod in
 *     `automation/node_modules`) and the `helios/` server (which does
 *     have zod but doesn't need it here).
 */

/** A single strategic cluster. */
export interface StrategicCluster {
  /** Stable identifier used in file paths, URLs, and manifest entries. */
  slug: string;
  /** Human-readable name shown in helios UI. */
  display_name: string;
  /** Operator-authored summary of who is searching and what they want. */
  intent_summary: string;
  /**
   * Query *patterns* — used by the L2 for negative-keyword discovery
   * and for understanding the shape of cluster intent. Free-form;
   * angle-bracketed placeholders (e.g. `<strain-name>`) are intentional.
   */
  target_query_patterns: string[];
  /**
   * Concrete keyword candidates the L2 may emit into an Ads-Editor CSV
   * directly. Used to seed the cluster's positive-keyword list.
   */
  seed_keyword_examples: string[];
  /** The landing-page slug this cluster is proposed to drive traffic to. */
  proposed_landing_page_slug: string;
  /** Ad-copy themes the L2 should weave into responsive search ads. */
  proposed_ad_themes: string[];
  /**
   * USP hooks the L2 should foreground in ad copy and landing-page
   * hero sections. Distinguished from generic ad_themes so the L2
   * can prioritise them on every variant.
   */
  usp_hooks: string[];
  /**
   * Free-text operator context the L2 reads when deciding whether to
   * `extend-existing`, `merge-into-existing`, `create-new`, or
   * `pause-and-replace`. Not a hard rule.
   */
  reconciliation_hint: string;
}

/** The complete strategic-clusters.yaml file shape. */
export interface StrategicClustersConfig {
  /** Schema version for forward-compat checks. */
  version: string;
  /** Where the cluster ideas originated (audit trail). */
  provenance_url: string;
  /** Operator notes the L2 treats as binding context when reconciling. */
  operator_context: string;
  /** The strategic clusters themselves. */
  clusters: StrategicCluster[];
}

const CLUSTER_FIELDS: ReadonlyArray<keyof StrategicCluster> = [
  'slug',
  'display_name',
  'intent_summary',
  'target_query_patterns',
  'seed_keyword_examples',
  'proposed_landing_page_slug',
  'proposed_ad_themes',
  'usp_hooks',
  'reconciliation_hint',
] as const;

const CONFIG_FIELDS: ReadonlyArray<keyof StrategicClustersConfig> = [
  'version',
  'provenance_url',
  'operator_context',
  'clusters',
] as const;

class ValidationError extends Error {
  constructor(public issues: string[]) {
    super(`Strategic-clusters config failed validation:\n${issues.map((s) => `  - ${s}`).join('\n')}`);
    this.name = 'ValidationError';
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function isNonEmptyStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.length > 0 && x.every(isNonEmptyString);
}

const SLUG_RE = /^[a-z0-9-]+$/;
const LANDING_RE = /^\/[a-z0-9/-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function validateCluster(input: unknown, path: string, out: string[]): StrategicCluster | undefined {
  if (!isPlainObject(input)) {
    out.push(`${path}: must be an object`);
    return undefined;
  }

  // Reject unknown keys.
  for (const k of Object.keys(input)) {
    if (!(CLUSTER_FIELDS as readonly string[]).includes(k)) {
      out.push(`${path}.${k}: unknown field`);
    }
  }

  const errs: string[] = [];
  const req = (cond: boolean, msg: string) => {
    if (!cond) errs.push(`${path}.${msg}`);
  };

  req(isNonEmptyString(input.slug), 'slug: must be a non-empty string');
  if (isNonEmptyString(input.slug)) {
    req(SLUG_RE.test(input.slug), 'slug: must be lowercase letters/digits/hyphens only');
  }
  req(isNonEmptyString(input.display_name), 'display_name: must be a non-empty string');
  req(isNonEmptyString(input.intent_summary), 'intent_summary: must be a non-empty string');
  req(isNonEmptyStringArray(input.target_query_patterns), 'target_query_patterns: must be a non-empty array of non-empty strings');
  req(isNonEmptyStringArray(input.seed_keyword_examples), 'seed_keyword_examples: must be a non-empty array of non-empty strings');
  req(isNonEmptyString(input.proposed_landing_page_slug), 'proposed_landing_page_slug: must be a non-empty string');
  if (isNonEmptyString(input.proposed_landing_page_slug)) {
    req(LANDING_RE.test(input.proposed_landing_page_slug), 'proposed_landing_page_slug: must be a `/`-prefixed lowercase path');
  }
  req(isNonEmptyStringArray(input.proposed_ad_themes), 'proposed_ad_themes: must be a non-empty array of non-empty strings');
  req(isNonEmptyStringArray(input.usp_hooks), 'usp_hooks: must be a non-empty array of non-empty strings');
  req(isNonEmptyString(input.reconciliation_hint), 'reconciliation_hint: must be a non-empty string');

  if (errs.length > 0) {
    out.push(...errs);
    return undefined;
  }
  return input as unknown as StrategicCluster;
}

/**
 * Validate a parsed yaml document against the strategic-clusters schema.
 * Returns the typed config or throws ValidationError with all issues.
 */
export function validateStrategicClustersConfig(input: unknown): StrategicClustersConfig {
  const issues: string[] = [];

  if (!isPlainObject(input)) {
    throw new ValidationError(['root: yaml document must be an object']);
  }

  // Reject unknown top-level keys.
  for (const k of Object.keys(input)) {
    if (!(CONFIG_FIELDS as readonly string[]).includes(k)) {
      issues.push(`root.${k}: unknown field`);
    }
  }

  if (!isNonEmptyString(input.version)) {
    issues.push('root.version: must be a non-empty string');
  } else if (!SEMVER_RE.test(input.version)) {
    issues.push('root.version: must be semver (e.g. "1.0.0")');
  }

  if (!isNonEmptyString(input.provenance_url)) {
    issues.push('root.provenance_url: must be a non-empty string');
  } else {
    try {
      new URL(input.provenance_url);
    } catch {
      issues.push('root.provenance_url: must be a valid URL');
    }
  }

  if (!isNonEmptyString(input.operator_context)) {
    issues.push('root.operator_context: must be a non-empty string');
  }

  let clusters: StrategicCluster[] = [];
  if (!Array.isArray(input.clusters) || input.clusters.length === 0) {
    issues.push('root.clusters: must be a non-empty array');
  } else {
    const seen = new Map<string, number>();
    for (let i = 0; i < input.clusters.length; i++) {
      const c = validateCluster(input.clusters[i], `clusters[${i}]`, issues);
      if (c) {
        const prev = seen.get(c.slug);
        if (prev !== undefined) {
          issues.push(`clusters[${i}].slug: duplicate "${c.slug}" (also at clusters[${prev}].slug)`);
        }
        seen.set(c.slug, i);
        clusters.push(c);
      }
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return {
    version: input.version as string,
    provenance_url: input.provenance_url as string,
    operator_context: input.operator_context as string,
    clusters,
  };
}

/**
 * Load + validate a strategic-clusters yaml file from disk.
 *
 * @param filePath  Absolute or cwd-relative path to the yaml file.
 * @returns         Parsed + validated config. Throws on parse or validation error.
 */
export async function loadStrategicClustersConfig(
  filePath: string
): Promise<StrategicClustersConfig> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const yaml = await import('js-yaml');

  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read strategic-clusters config at ${resolved}: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML in ${resolved}: ${(err as Error).message}`
    );
  }

  try {
    return validateStrategicClustersConfig(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new Error(`${resolved}:\n${err.message}`);
    }
    throw err;
  }
}

export { ValidationError as StrategicClustersValidationError };
