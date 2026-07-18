#!/usr/bin/env bash
# Validate a per-repo .github/workflows/task-dag.yml caller against the
# canonical reusable-workflow wiring contract in docs/MIGRATION.md.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: validate-caller-workflow.sh [options] [PATH]

Validate a task-dag caller workflow (default: .github/workflows/task-dag.yml).
The check is read-only and verifies the required event triggers, job
permissions, secrets, reusable workflow source, graph-converge/backstop wiring,
and push-range inputs before a per-repo rollout lands.

Options:
  --expected-ref=REF          Expected virusdave/task-dag reusable-workflow ref
                             in every `uses:` line (default: master).
  --require-materialise       Require the optional materialise caller job.
  --require-comment-sync-app  Require comment-sync to pass TASK_DAG_APP_* creds
                             for repos that can auto-close delegated epics.
  -h, --help                  Show this help.
EOF
}

workflow_path=".github/workflows/task-dag.yml"
expected_ref="master"
require_materialise=false
require_comment_sync_app=false

while [ "$#" -gt 0 ]; do
    case "$1" in
        --expected-ref=*) expected_ref="${1#*=}"; shift ;;
        --expected-ref)
            [ "$#" -ge 2 ] || { echo "--expected-ref requires a value" >&2; exit 2; }
            expected_ref="$2"
            shift 2
            ;;
        --require-materialise) require_materialise=true; shift ;;
        --require-comment-sync-app) require_comment_sync_app=true; shift ;;
        -h|--help) usage; exit 0 ;;
        --*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        *) workflow_path="$1"; shift ;;
    esac
done

[ -n "$expected_ref" ] || { echo "--expected-ref must not be empty" >&2; exit 2; }
[ -f "$workflow_path" ] || { echo "Workflow file not found: $workflow_path" >&2; exit 2; }

if ! command -v ruby >/dev/null 2>&1; then
    if command -v nix-shell >/dev/null 2>&1; then
        rerun_args=("--expected-ref=$expected_ref")
        [ "$require_materialise" = true ] && rerun_args+=(--require-materialise)
        [ "$require_comment_sync_app" = true ] && rerun_args+=(--require-comment-sync-app)
        rerun_args+=("$workflow_path")
        cmd=$(printf '%q ' "$0" "${rerun_args[@]}")
        exec nix-shell -p ruby --run "$cmd"
    fi
    echo "ruby is required to parse workflow YAML (or install nix-shell for the ruby fallback)" >&2
    exit 2
fi

ruby -ryaml - "$workflow_path" "$expected_ref" "$require_materialise" "$require_comment_sync_app" <<'RUBY'
path, expected_ref, require_materialise_s, require_comment_sync_app_s = ARGV
require_materialise = require_materialise_s == 'true'
require_comment_sync_app = require_comment_sync_app_s == 'true'

begin
  workflow = YAML.load_file(path)
rescue Psych::SyntaxError => e
  warn "#{path}: YAML syntax error: #{e.message}"
  exit 1
end

unless workflow.is_a?(Hash)
  warn "#{path}: workflow root must be a mapping"
  exit 1
end

errors = []

def fetch_map(parent, key)
  value = parent[key]
  value.is_a?(Hash) ? value : {}
end

def fetch_array(parent, key)
  value = parent[key]
  value.is_a?(Array) ? value : []
end

def fmt(value)
  value.inspect
end

def expect_equal(errors, label, actual, expected)
  errors << "#{label}: expected #{fmt(expected)}, got #{fmt(actual)}" unless actual == expected
end

def expect_includes(errors, label, actual, required)
  missing = required - actual
  errors << "#{label}: missing #{missing.inspect} from #{actual.inspect}" unless missing.empty?
end

def expect_contains(errors, label, actual, needle)
  errors << "#{label}: expected to contain #{needle.inspect}, got #{fmt(actual)}" unless actual.to_s.include?(needle)
end

# Ruby's stdlib YAML parser treats the unquoted GitHub Actions key `on:` as the
# boolean true (YAML 1.1 compatibility). Accept that parser representation here;
# the workflow file itself still uses normal GitHub Actions syntax.
events = workflow.key?('on') ? workflow['on'] : workflow[true]
jobs = fetch_map(workflow, 'jobs')

unless events.is_a?(Hash)
  errors << "top-level on: must be a mapping of caller events"
  events = {}
end

issue_types = fetch_array(fetch_map(events, 'issues'), 'types')
comment_types = fetch_array(fetch_map(events, 'issue_comment'), 'types')
push_branches = fetch_array(fetch_map(events, 'push'), 'branches')
schedule = events['schedule']

expect_includes(errors, 'on.issues.types', issue_types, %w[opened reopened edited])
expect_includes(errors, 'on.issue_comment.types', comment_types, %w[created])
expect_includes(errors, 'on.push.branches', push_branches, %w[master])
errors << 'on.schedule: must be present for projection/graph backstops' unless schedule.is_a?(Array) && !schedule.empty?
errors << 'on.workflow_dispatch: must be present for manual projection/graph backstops' unless events.key?('workflow_dispatch')

required_jobs = %w[
  issue-to-task
  reopen-notice
  comment-sync
  close-completed
  graph-converge
  completion-aggregate
]
required_jobs << 'materialise' if require_materialise
expect_includes(errors, 'jobs', jobs.keys, required_jobs)

def job(errors, jobs, name)
  j = jobs[name]
  unless j.is_a?(Hash)
    errors << "jobs.#{name}: missing or not a mapping"
    return {}
  end
  j
end

def check_uses(errors, jobs, name, workflow_file, expected_ref)
  j = job(errors, jobs, name)
  expected = "virusdave/task-dag/.github/workflows/#{workflow_file}@#{expected_ref}"
  expect_equal(errors, "jobs.#{name}.uses", j['uses'], expected)
  j
end

def check_permissions(errors, jobs, name, expected)
  perms = fetch_map(job(errors, jobs, name), 'permissions')
  expected.each { |k, v| expect_equal(errors, "jobs.#{name}.permissions.#{k}", perms[k], v) }
end

def check_secret(errors, jobs, name, secret, expected)
  secrets = fetch_map(job(errors, jobs, name), 'secrets')
  expect_equal(errors, "jobs.#{name}.secrets.#{secret}", secrets[secret], expected)
end

def check_with(errors, jobs, name, input, expected)
  with = fetch_map(job(errors, jobs, name), 'with')
  expect_equal(errors, "jobs.#{name}.with.#{input}", with[input], expected)
end

check_uses(errors, jobs, 'issue-to-task', 'issue-to-task.yml', expected_ref)
expect_contains(errors, 'jobs.issue-to-task.if', job(errors, jobs, 'issue-to-task')['if'], "github.event_name == 'issues'")
check_permissions(errors, jobs, 'issue-to-task', { 'contents' => 'write', 'issues' => 'write' })
check_secret(errors, jobs, 'issue-to-task', 'token', '${{ secrets.GITHUB_TOKEN }}')

check_uses(errors, jobs, 'reopen-notice', 'reopen-notice.yml', expected_ref)
expect_contains(errors, 'jobs.reopen-notice.if', job(errors, jobs, 'reopen-notice')['if'], "github.event_name == 'issues'")
expect_contains(errors, 'jobs.reopen-notice.if', job(errors, jobs, 'reopen-notice')['if'], "github.event.action == 'reopened'")
check_permissions(errors, jobs, 'reopen-notice', { 'issues' => 'write' })
check_secret(errors, jobs, 'reopen-notice', 'token', '${{ secrets.GITHUB_TOKEN }}')

check_uses(errors, jobs, 'comment-sync', 'sync-comment-to-task.yml', expected_ref)
expect_contains(errors, 'jobs.comment-sync.if', job(errors, jobs, 'comment-sync')['if'], "github.event_name == 'issue_comment'")
check_with(errors, jobs, 'comment-sync', 'ref', expected_ref)
check_permissions(errors, jobs, 'comment-sync', { 'contents' => 'write', 'issues' => 'write' })
check_secret(errors, jobs, 'comment-sync', 'token', '${{ secrets.GITHUB_TOKEN }}')
comment_secrets = fetch_map(job(errors, jobs, 'comment-sync'), 'secrets')
has_comment_app_id = comment_secrets.key?('app_id')
has_comment_app_key = comment_secrets.key?('app_private_key')
if has_comment_app_id != has_comment_app_key
  errors << 'jobs.comment-sync.secrets: app_id and app_private_key must be supplied together or both omitted'
elsif require_comment_sync_app
  expect_equal(errors, 'jobs.comment-sync.secrets.app_id', comment_secrets['app_id'], '${{ secrets.TASK_DAG_APP_ID }}')
  expect_equal(errors, 'jobs.comment-sync.secrets.app_private_key', comment_secrets['app_private_key'], '${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}')
end

check_uses(errors, jobs, 'close-completed', 'close-completed-issues.yml', expected_ref)
%w[push schedule workflow_dispatch].each { |event| expect_contains(errors, 'jobs.close-completed.if', job(errors, jobs, 'close-completed')['if'], "github.event_name == '#{event}'") }
check_permissions(errors, jobs, 'close-completed', { 'contents' => 'write', 'issues' => 'write' })
check_secret(errors, jobs, 'close-completed', 'token', '${{ secrets.GITHUB_TOKEN }}')

check_uses(errors, jobs, 'graph-converge', 'graph-converge.yml', expected_ref)
%w[push schedule workflow_dispatch].each { |event| expect_contains(errors, 'jobs.graph-converge.if', job(errors, jobs, 'graph-converge')['if'], "github.event_name == '#{event}'") }
check_permissions(errors, jobs, 'graph-converge', { 'contents' => 'write' })
check_with(errors, jobs, 'graph-converge', 'base_sha', "${{ github.event_name == 'push' && github.event.before || '' }}")
check_with(errors, jobs, 'graph-converge', 'head_sha', "${{ github.event_name == 'push' && github.sha || '' }}")

check_uses(errors, jobs, 'completion-aggregate', 'aggregate-cross-repo-completions.yml', expected_ref)
expect_contains(errors, 'jobs.completion-aggregate.if', job(errors, jobs, 'completion-aggregate')['if'], "github.event_name == 'push'")
check_with(errors, jobs, 'completion-aggregate', 'base_sha', '${{ github.event.before }}')
check_with(errors, jobs, 'completion-aggregate', 'head_sha', '${{ github.sha }}')
check_secret(errors, jobs, 'completion-aggregate', 'app_id', '${{ secrets.TASK_DAG_APP_ID }}')
check_secret(errors, jobs, 'completion-aggregate', 'app_private_key', '${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}')

if jobs.key?('materialise')
  materialise_job = job(errors, jobs, 'materialise')
  materialise_uses = materialise_job['uses'].to_s
  materialise_match = materialise_uses.match(%r{\Avirusdave/task-dag/\.github/workflows/materialise-child-epic\.yml@([0-9a-f]{40})\z})
  errors << 'jobs.materialise.uses: must pin the privileged reusable workflow to an exact 40-hex commit' unless materialise_match
  %w[push schedule workflow_dispatch].each { |event| expect_contains(errors, 'jobs.materialise.if', job(errors, jobs, 'materialise')['if'], "github.event_name == '#{event}'") }
  check_permissions(errors, jobs, 'materialise', { 'contents' => 'write', 'issues' => 'write' })
  check_with(errors, jobs, 'materialise', 'base_sha', "${{ github.event_name == 'push' && github.event.before || '' }}")
  check_with(errors, jobs, 'materialise', 'head_sha', "${{ github.event_name == 'push' && github.sha || '' }}")
  materialise_ref = fetch_map(materialise_job, 'with')['ref'].to_s
  errors << 'jobs.materialise.with.ref: must equal the exact reusable-workflow commit' unless materialise_match && materialise_ref == materialise_match[1]
  check_secret(errors, jobs, 'materialise', 'app_id', '${{ secrets.TASK_DAG_APP_ID }}')
  check_secret(errors, jobs, 'materialise', 'app_private_key', '${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}')
end

if errors.empty?
  puts "PASS: #{path} matches the task-dag caller workflow contract (ref #{expected_ref})"
  exit 0
end

warn "#{path}: task-dag caller workflow contract violations:"
errors.each { |e| warn "  - #{e}" }
exit 1
RUBY
