#!/usr/bin/env bash
# run-cluster-sweep — placeholder implementation of the gads cluster
# sweep job (P1c of the gemini-clusters epic).
#
# The systemd unit `gads-cluster-sweep.service` (declared in
# nixos-sbc/modules/google-ads-automation.nix) invokes this script
# on its weekly timer and on every operator click of the
# "Run cluster sweep now" button on the helios Ads → Cluster proposals
# page.
#
# This placeholder writes a run directory under
# `ads/google/outputs/cluster-sweep/run-<UTC-timestamp>/` containing:
#
#   - manifest.json       (machine-readable index)
#   - README.md           (operator-facing summary)
#   - strategic-context.yaml  (copy of the seed config that would drive
#                              the real LLM-driven sweep when P1c lands)
#   - clusters/<slug>/verdict.md  (one stub per seeded cluster so the
#                                  bundle ZIP is non-empty and
#                                  visually walks the operator
#                                  through the eventual layout)
#
# When the real LLM-driven cluster-sweep (P1a/P1b/P1c) lands, replace
# the body of this script (or swap the ExecStart in the nix module to
# a node/tsx entrypoint) — the surrounding plumbing (systemd unit,
# helios trigger button, on-disk layout, bundle ZIP endpoint) does
# not need to change.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
GOOGLE_ADS_DIR="${REPO_ROOT}/ads/google"
OUTPUTS_DIR="${GOOGLE_ADS_DIR}/outputs/cluster-sweep"
STRATEGIC_CLUSTERS_YAML="${GOOGLE_ADS_DIR}/config/strategic-clusters.yaml"

# UTC ISO-like timestamp without colons/seconds-fraction — safe for
# filesystems + sorts chronologically.
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ID="run-${TIMESTAMP}"
RUN_DIR="${OUTPUTS_DIR}/${RUN_ID}"

mkdir -p "${RUN_DIR}/clusters"

# Strategic context: copy verbatim if present so the bundle audit
# trail records which seed config drove this run. Until P0 lands the
# strategic-clusters yaml on every working tree, fall back to a stub.
if [[ -f "${STRATEGIC_CLUSTERS_YAML}" ]]; then
  cp "${STRATEGIC_CLUSTERS_YAML}" "${RUN_DIR}/strategic-context.yaml"
else
  cat > "${RUN_DIR}/strategic-context.yaml" <<'YAML'
# strategic-clusters.yaml not found on this host at the time of the
# sweep run. The real cluster-sweep implementation (P1a/P1b/P1c of
# the gemini-clusters epic) will require this file to be present
# under ads/google/config/.
YAML
fi

# Enumerate the seeded cluster slugs from the yaml so the placeholder
# stub mirrors the real cluster set. Fall back to a hard-coded list
# if the yaml isn't present (so the bundle is non-empty either way).
SLUGS=()
if [[ -f "${STRATEGIC_CLUSTERS_YAML}" ]]; then
  # Pull `slug:` lines from the yaml without depending on a yaml
  # parser; the schema constrains slugs to lower-kebab so a regex is
  # safe enough for the placeholder.
  while IFS= read -r line; do
    SLUGS+=("$line")
  done < <(grep -E '^\s+slug:\s+[a-z][a-z0-9-]*' "${STRATEGIC_CLUSTERS_YAML}" \
             | sed -E 's/^\s+slug:\s+([a-z][a-z0-9-]+)\s*$/\1/' \
             | sort -u)
fi
if [[ ${#SLUGS[@]} -eq 0 ]]; then
  SLUGS=(
    strain-brand-power
    local-discovery
    delivery-revamped
    bronx-arthur-ave
    brand-protection
    general-category
    financial-logistics
    regulatory-legitimacy
  )
fi

for slug in "${SLUGS[@]}"; do
  cluster_dir="${RUN_DIR}/clusters/${slug}"
  mkdir -p "${cluster_dir}"
  cat > "${cluster_dir}/verdict.md" <<MD
# ${slug}

**verdict:** _pending real cluster-sweep implementation_

This is a stub entry written by the placeholder
\`run-cluster-sweep.sh\` while P1a/P1b/P1c of the gemini-clusters
epic are still in flight. When those land, this file will contain:

- the LLM's reconciliation verdict against existing campaigns
  (\`extend-existing\` | \`merge-into-existing\` | \`create-new\` |
  \`pause-and-replace\`)
- rationale + referenced existing campaign IDs
- per-action Lane tagging (A — Ads Editor CSV, C — Web-UI checklist)
- expected upside / policy-risk signals
MD
done

# Operator-facing README.
cat > "${RUN_DIR}/README.md" <<MD
# Cluster-sweep run \`${RUN_ID}\`

This is a **stub run** produced by the placeholder
\`ads/google/scripts/run-cluster-sweep.sh\` while the real
LLM-driven cluster-sweep (P1a/P1b/P1c of the gemini-clusters epic)
is still being implemented.

The plumbing it exercises end-to-end:

- helios button on the Ads → Cluster proposals page
- \`sudo -n gads-cluster-sweep-trigger\` wrapper (sudo-whitelisted)
- \`gads-cluster-sweep.service\` systemd oneshot unit on vps-nixos-3
- this script
- the per-run directory structure under
  \`ads/google/outputs/cluster-sweep/\`
- the helios bundle ZIP endpoint that streams these files back

What's intentionally absent until P1c lands:

- real LLM reconciliation verdicts (each cluster's \`verdict.md\` is
  a placeholder)
- per-cluster Ads Editor CSVs (\`campaign.csv\`, etc.)
- Lane C operator checklist with web-UI deep-links
- a real \`repairs/\` queue ingested from the daily L2 output
- machine-readable per-cluster action manifest
MD

# Machine-readable manifest. The helios cluster-proposals page uses
# `manifest_present` (computed from the existence of this file) to
# render the "complete" vs "in progress / incomplete" pill.
#
# Built natively by jq (never hand-assembled braces/commas): the scalars
# arrive as --arg/--argjson and the slug list as positional --args, so
# jq owns all JSON structure/escaping and a future field/order edit can't
# desync a comma into invalid JSON.
if [[ -f "${STRATEGIC_CLUSTERS_YAML}" ]]; then
  strategic_context_present=true
else
  strategic_context_present=false
fi
jq -n \
  --arg run_id "${RUN_ID}" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson strategic_context_present "${strategic_context_present}" \
  --args \
  '{
    schema_version: 0,
    run_id: $run_id,
    generated_at: $generated_at,
    kind: "placeholder",
    note: "Stub run; replace once P1c of the gemini-clusters epic lands.",
    clusters: ($ARGS.positional | map({ slug: ., files: ["verdict.md"] })),
    repairs: [],
    strategic_context_present: $strategic_context_present
  }' \
  "${SLUGS[@]}" > "${RUN_DIR}/manifest.json"

echo "wrote ${RUN_DIR}"
