use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn git(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "comment integration")
        .env("GIT_AUTHOR_EMAIL", "comment@localhost")
        .env("GIT_COMMITTER_NAME", "comment integration")
        .env("GIT_COMMITTER_EMAIL", "comment@localhost")
        .output()
        .unwrap()
}

fn ok(cwd: &Path, args: &[&str]) -> String {
    let output = git(cwd, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn framed(domain: &str, parts: &[&str]) -> String {
    fn frame(hash: &mut Sha256, value: &str) {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let mut hash = Sha256::new();
    frame(&mut hash, "task-dag-v2-framing-1");
    frame(&mut hash, domain);
    hash.update((parts.len() as u64).to_be_bytes());
    for part in parts {
        frame(&mut hash, part);
    }
    format!("{:x}", hash.finalize())
}

fn digest(value: &str) -> String {
    framed("digest", &[value])
}

struct Fixture {
    root: PathBuf,
    work: PathBuf,
    fake: PathBuf,
    state: PathBuf,
    task_id: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new(name: &str, binding: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("taskdag-comment-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let runtime_origin = root.join("runtime-origin.git");
        let work = root.join("work");
        ok(&root, &["init", "--bare", origin.to_str().unwrap()]);
        ok(&root, &["init", "--bare", runtime_origin.to_str().unwrap()]);
        let source = Path::new(env!("CARGO_MANIFEST_DIR"));
        let floor = ok(
            source,
            &["commit-tree", EMPTY_TREE, "-m", "comment fixture floor"],
        );
        ok(
            source,
            &[
                "push",
                origin.to_str().unwrap(),
                &format!("{floor}:refs/heads/master"),
            ],
        );
        ok(
            &root,
            &["clone", origin.to_str().unwrap(), work.to_str().unwrap()],
        );
        ok(&work, &["config", "user.name", "comment test"]);
        ok(&work, &["config", "user.email", "comment@localhost"]);
        fs::create_dir(work.join(".githooks")).unwrap();
        fs::copy(
            source.join(".githooks/pre-push"),
            work.join(".githooks/pre-push"),
        )
        .unwrap();
        ok(&work, &["config", "core.hooksPath", ".githooks"]);
        let runtime = env!("TASKDAG_BUILD_COMMIT");
        ok(&work, &["fetch", source.to_str().unwrap(), runtime]);
        let mut fixture = Self {
            root,
            work,
            fake: PathBuf::new(),
            state: PathBuf::new(),
            task_id: String::new(),
        };
        fixture.run_ok(&["runtime", "publish", "--commit", runtime], "normal");
        fixture.run_ok(&["init", "--trusted-floor", &floor], "normal");
        let created = fixture.run_ok(
            &[
                "create",
                "--operation-id",
                &format!("create-{name}"),
                "--title",
                "Comment fixture",
                "--description",
                "Integration fixture",
            ],
            "normal",
        );
        fixture.task_id = created["taskId"].as_str().unwrap().to_owned();
        if binding {
            fixture.install_binding(created["taskOid"].as_str().unwrap());
        }
        fixture.state = fixture.root.join("provider");
        fs::create_dir_all(&fixture.state).unwrap();
        fixture.fake = fixture.root.join("fake-gh");
        fs::write(&fixture.fake, FAKE_GH).unwrap();
        fs::set_permissions(&fixture.fake, fs::Permissions::from_mode(0o770)).unwrap();
        fixture
    }

    fn install_binding(&self, task_oid: &str) {
        let value = json!({"formatVersion":2,"issueId":"456","issueNumber":"7","operationId":"bind-fixture","provider":"github","repository":"owner/repository","repositoryId":"123","semanticId":"0".repeat(64),"taskId":self.task_id,"taskOid":task_oid});
        let file = self.root.join("binding.json");
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        let oid = ok(
            &self.work,
            &["commit-tree", EMPTY_TREE, "-F", file.to_str().unwrap()],
        );
        let target = framed("github-issue-binding-key", &["123", "456"]);
        ok(
            &self.work,
            &[
                "push",
                "origin",
                &format!(
                    "{oid}:refs/heads/tasks/comments/bindings/by-task/{}",
                    self.task_id
                ),
                &format!("{oid}:refs/heads/tasks/comments/bindings/by-target/{target}"),
            ],
        );
    }

    fn command(&self, args: &[&str], mode: &str) -> Output {
        self.command_with(args, mode, "100", "30000")
    }

    fn command_with(&self, args: &[&str], mode: &str, now: &str, deadline_ms: &str) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_task-dag"));
        command
            .current_dir(&self.work)
            .args(args)
            .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
            .env("TASKDAG_TEST_TOKEN", "comment-token-000")
            .env("TASKDAG_TEST_TIME", now)
            .env("TASKDAG_TEST_LEGACY_ACTIVATION", "1")
            .env("TASKDAG_SESSION_ID", "comment-integration")
            .env(
                "TASKDAG_TEST_RUNTIME_REMOTE",
                self.root.join("runtime-origin.git"),
            )
            .env("TASKDAG_TEST_GH", &self.fake)
            .env("TASKDAG_TEST_COMMENT_RETRY_MS", "0")
            .env("TASKDAG_TEST_COMMENT_DEADLINE_MS", deadline_ms)
            .env("FAKE_GH_STATE", &self.state)
            .env(
                "FAKE_GH_MODE",
                if mode == "claim-delay" {
                    "normal"
                } else {
                    mode
                },
            );
        if mode == "claim-delay" {
            command.env("TASKDAG_TEST_COMMENT_CLAIM_DELAY_MS", "200");
        }
        command.output().unwrap()
    }

    fn run_ok(&self, args: &[&str], mode: &str) -> Value {
        let output = self.command(args, mode);
        assert!(
            output.status.success(),
            "task-dag {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
    }

    fn post(&self, operation: &str, body: &str, mode: &str) -> Output {
        self.post_at(operation, body, mode, "100")
    }

    fn post_at(&self, operation: &str, body: &str, mode: &str, now: &str) -> Output {
        let file = self.root.join(format!("{operation}.txt"));
        fs::write(&file, body).unwrap();
        self.command_with(
            &[
                "comment",
                "post",
                &self.task_id,
                "--kind",
                "status",
                "--body-file",
                file.to_str().unwrap(),
                "--operation-id",
                operation,
            ],
            mode,
            now,
            "30000",
        )
    }

    fn calls(&self, kind: &str) -> usize {
        fs::read_to_string(self.state.join("calls"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == kind)
            .count()
    }

    fn refs(&self, pattern: &str) -> Vec<String> {
        ok(&self.work, &["ls-remote", "--refs", "origin", pattern])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn target_binding_ref(&self) -> String {
        format!(
            "refs/heads/tasks/comments/bindings/by-target/{}",
            framed("github-issue-binding-key", &["123", "456"])
        )
    }

    fn remote_update_ref(&self, reference: &str, oid: Option<&str>) {
        let origin = self.root.join("origin.git");
        let mut command = Command::new("git");
        command.args(["--git-dir", origin.to_str().unwrap(), "update-ref"]);
        if let Some(oid) = oid {
            command.args([reference, oid]);
        } else {
            command.args(["-d", reference]);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "update fixture ref: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn replace_binding_task(&self, task_oid: &str) -> String {
        let value = json!({"formatVersion":2,"issueId":"456","issueNumber":"7","operationId":"replace-binding-fixture","provider":"github","repository":"owner/repository","repositoryId":"123","semanticId":"1".repeat(64),"taskId":self.task_id,"taskOid":task_oid});
        let file = self.root.join("replacement-binding.json");
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        let binding_oid = ok(
            &self.work,
            &["commit-tree", EMPTY_TREE, "-F", file.to_str().unwrap()],
        );
        let task_staging_ref = "refs/heads/test-fixtures/replacement-task";
        ok(
            &self.work,
            &["push", "origin", &format!("{task_oid}:{task_staging_ref}")],
        );
        let staging_ref = "refs/heads/test-fixtures/replacement-binding";
        ok(
            &self.work,
            &["push", "origin", &format!("{binding_oid}:{staging_ref}")],
        );
        let task_ref = format!(
            "refs/heads/tasks/comments/bindings/by-task/{}",
            self.task_id
        );
        self.remote_update_ref(&task_ref, Some(&binding_oid));
        self.remote_update_ref(&self.target_binding_ref(), Some(&binding_oid));
        self.remote_update_ref(staging_ref, None);
        self.remote_update_ref(task_staging_ref, None);
        binding_oid
    }
}

const FAKE_GH: &str = r##"#!/usr/bin/env bash
set -euo pipefail
state=${FAKE_GH_STATE:?}
mode=${FAKE_GH_MODE:?}
endpoint=${2:?}
[[ " $* " == *" --hostname github.com "* ]] || { echo 'missing canonical hostname' >&2; exit 64; }
if [[ "$endpoint" == repos/owner/repository ]]; then
  echo TARGET_REPO >>"$state/calls"
  if [[ "$mode" == target-mismatch ]]; then id=999; else id=123; fi
  jq -n --arg id "$id" '{id:$id,full_name:"owner/repository"}'
elif [[ "$endpoint" == repos/owner/repository/issues/7 ]]; then
  echo TARGET_ISSUE >>"$state/calls"
  jq -n '{id:"456",number:"7",repository_url:"https://api.github.com/repos/owner/repository"}'
elif [[ "$endpoint" == */issues/comments/* ]]; then
  echo GET >>"$state/calls"
  id=$(cat "$state/id")
  jq -n --rawfile body "$state/body" --arg id "$id" '{id:$id,body:$body,html_url:("https://github.com/owner/repository/issues/7#issuecomment-"+$id),issue_url:"https://api.github.com/repos/owner/repository/issues/7"}'
elif [[ " $* " == *" --method POST "* ]]; then
  echo POST >>"$state/calls"
  body=; for arg in "$@"; do [[ "$arg" == body=* ]] && body=${arg#body=}; done
  git ls-remote --refs origin 'refs/heads/tasks/comments/intents/*' | grep -q . && echo yes >"$state/intent-before-post"
  printf %s "$body" >"$state/body"; echo 9007199254740993 >"$state/id"
  if [[ "$mode" == permanent-post ]]; then echo 'HTTP 422 validation failed' >&2; exit 1; fi
  if [[ "$mode" == uncertain && ! -e "$state/uncertain-done" ]]; then touch "$state/uncertain-done"; printf '{'; exit 0; fi
  jq -n '{id:"9007199254740993"}'
else
  echo LIST >>"$state/calls"
  if [[ "$mode" == slow-list ]]; then sleep 5; fi
  if [[ "$mode" == permanent-list ]]; then echo 'HTTP 403 forbidden' >&2; exit 1; fi
  if [[ -e "$state/body" ]]; then
    id=$(cat "$state/id")
    if [[ "$mode" == duplicate ]]; then jq -n --rawfile body "$state/body" --arg id "$id" '[[{id:$id,body:$body}],[{id:"2",body:$body}]]'
    else jq -n --rawfile body "$state/body" --arg id "$id" '[[],[{id:$id,body:$body}]]'; fi
  elif [[ "$mode" == duplicate ]]; then
    marker=$(git show -s --format=%B "$(git ls-remote --refs origin 'refs/heads/tasks/comments/intents/*' | awk 'NR==1 {print $1}')" | jq -r .body)
    jq -n --arg body "$marker" '[[{id:"1",body:$body},{id:"2",body:$body}]]'
  else printf '[[],[]]\n'; fi
fi
"##;

#[test]
fn paginated_search_posts_exact_bytes_and_records_receipt() {
    let fixture = Fixture::new("success", true);
    let output = fixture.post("post-success", "exact body\nsecond line\n", "normal");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let posted = fs::read_to_string(fixture.state.join("body")).unwrap();
    let intent_oid = result["intentOid"].as_str().unwrap();
    let intent: Value = serde_json::from_str(&ok(
        &fixture.work,
        &["show", "-s", "--format=%B", intent_oid],
    ))
    .unwrap();
    assert_eq!(
        posted,
        intent["body"].as_str().unwrap(),
        "POST body must exactly equal canonical intent bytes"
    );
    assert!(posted.starts_with("<!-- task-dag:status -->\n<!-- task-dag:projection:"));
    assert!(posted.ends_with("\n\nexact body\nsecond line\n"));
    assert_eq!(
        fs::read_to_string(fixture.state.join("intent-before-post"))
            .unwrap()
            .trim(),
        "yes"
    );
    assert_eq!(fixture.calls("POST"), 1);
    assert_eq!(fixture.calls("GET"), 1);
    assert_eq!(
        fixture.refs("refs/heads/tasks/comments/receipts/*").len(),
        1
    );
}

#[test]
fn uncertain_post_is_reconciled_by_marker_with_one_post() {
    let fixture = Fixture::new("uncertain", true);
    let output = fixture.post("post-uncertain", "uncertain body", "uncertain");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.calls("POST"), 1);
    assert!(fixture.calls("LIST") >= 2);
    assert_eq!(
        fixture.refs("refs/heads/tasks/comments/receipts/*").len(),
        1
    );
}

#[test]
fn exact_operation_replays_and_changed_body_fails_before_provider() {
    let fixture = Fixture::new("replay", true);
    let first = fixture.post("same-operation", "stable", "normal");
    assert!(first.status.success());
    let first_json: Value = serde_json::from_slice(&first.stdout).unwrap();
    let second = fixture.post("same-operation", "stable", "normal");
    assert!(second.status.success());
    assert_eq!(
        first_json,
        serde_json::from_slice::<Value>(&second.stdout).unwrap()
    );
    assert_eq!(fixture.calls("POST"), 1);
    let calls = fs::read_to_string(fixture.state.join("calls")).unwrap();
    let changed = fixture.post("same-operation", "changed", "normal");
    assert!(!changed.status.success());
    assert!(String::from_utf8_lossy(&changed.stderr).contains("different semantics"));
    assert_eq!(
        fs::read_to_string(fixture.state.join("calls")).unwrap(),
        calls
    );
}

#[test]
fn duplicate_marker_fails_closed_with_pending_intent() {
    let fixture = Fixture::new("duplicate", true);
    let output = fixture.post("duplicate-operation", "duplicate", "duplicate");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("multiple GitHub comments"));
    assert_eq!(fixture.calls("POST"), 0);
    assert_eq!(fixture.refs("refs/heads/tasks/comments/intents/*").len(), 1);
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/receipts/*")
            .is_empty()
    );
}

#[test]
fn permanent_provider_failure_stops_in_first_round() {
    let fixture = Fixture::new("permanent", true);
    let output = fixture.post("permanent-operation", "permanent", "permanent-list");
    assert!(!output.status.success());
    assert_eq!(fixture.calls("LIST"), 1);
    assert_eq!(fixture.calls("POST"), 0);
    assert_eq!(fixture.refs("refs/heads/tasks/comments/intents/*").len(), 1);
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/receipts/*")
            .is_empty()
    );
}

#[test]
fn missing_binding_fails_before_provider_and_intent() {
    let fixture = Fixture::new("unbound", false);
    let output = fixture.post("unbound-operation", "unbound", "normal");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no GitHub issue binding"));
    assert_eq!(
        fixture.calls("LIST") + fixture.calls("POST") + fixture.calls("GET"),
        0
    );
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/intents/*")
            .is_empty()
    );
}

#[test]
fn stable_provider_identity_mismatch_prevents_post_and_receipt() {
    let fixture = Fixture::new("target-mismatch", true);
    let output = fixture.post(
        "target-mismatch-operation",
        "must not post",
        "target-mismatch",
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("stable identity"));
    assert_eq!(fixture.calls("TARGET_REPO"), 1);
    assert_eq!(fixture.calls("POST"), 0);
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/receipts/*")
            .is_empty()
    );
}

#[test]
fn orphaned_or_conflicting_binding_aliases_fail_before_provider() {
    for mode in ["orphaned", "conflicting"] {
        let fixture = Fixture::new(mode, true);
        let target_ref = fixture.target_binding_ref();
        if mode == "orphaned" {
            fixture.remote_update_ref(&target_ref, None);
        } else {
            let unrelated = ok(&fixture.work, &["rev-parse", "HEAD"]);
            fixture.remote_update_ref(&target_ref, Some(&unrelated));
        }
        let output = fixture.post(&format!("{mode}-operation"), mode, "normal");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("binding aliases"));
        assert_eq!(
            fixture.calls("LIST") + fixture.calls("POST") + fixture.calls("GET"),
            0
        );
        assert!(
            fixture
                .refs("refs/heads/tasks/comments/intents/*")
                .is_empty()
        );
    }
}

#[test]
fn binding_must_name_the_exact_traversed_task_object() {
    let fixture = Fixture::new("stale-binding-task", true);
    let alternate = json!({"description":"alternate task object","formatVersion":2,"operationId":"alternate-task-object","requirements":[],"structuralParent":null,"taskId":fixture.task_id,"title":"Alternate task object"});
    let file = fixture.root.join("alternate-task.json");
    fs::write(&file, serde_json::to_vec(&alternate).unwrap()).unwrap();
    let alternate_oid = ok(
        &fixture.work,
        &["commit-tree", EMPTY_TREE, "-F", file.to_str().unwrap()],
    );
    fixture.replace_binding_task(&alternate_oid);
    let output = fixture.post("stale-binding-task", "must not post", "normal");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("traversed structural ancestor"));
    assert_eq!(
        fixture.calls("LIST") + fixture.calls("POST") + fixture.calls("GET"),
        0
    );
}

#[test]
fn reconciliation_rejects_a_prefixed_intent_with_a_stale_binding_task() {
    let fixture = Fixture::new("stale-intent-binding", true);
    let task_ref = format!(
        "refs/heads/tasks/comments/bindings/by-task/{}",
        fixture.task_id
    );
    let binding_line = fixture.refs(&task_ref).pop().unwrap();
    let original_binding_oid = binding_line.split_once('\t').unwrap().0;
    let original_binding: Value = serde_json::from_str(&ok(
        &fixture.work,
        &["show", "-s", "--format=%B", original_binding_oid],
    ))
    .unwrap();
    let source_task_oid = original_binding["taskOid"].as_str().unwrap();
    let alternate = json!({"description":"alternate task object","formatVersion":2,"operationId":"alternate-stale-intent-task","requirements":[],"structuralParent":null,"taskId":fixture.task_id,"title":"Alternate stale intent task"});
    let task_file = fixture.root.join("alternate-stale-intent-task.json");
    fs::write(&task_file, serde_json::to_vec(&alternate).unwrap()).unwrap();
    let alternate_oid = ok(
        &fixture.work,
        &["commit-tree", EMPTY_TREE, "-F", task_file.to_str().unwrap()],
    );
    let stale_binding_oid = fixture.replace_binding_task(&alternate_oid);
    let operation = "prefixed-stale-binding-intent";
    let intent_id = "a".repeat(64);
    let input = "stale pending";
    let body =
        format!("<!-- task-dag:status -->\n<!-- task-dag:projection:{intent_id} -->\n\n{input}\n");
    let body_digest = digest(&body);
    let intent = json!({"bindingOid":stale_binding_oid,"bindingTaskId":fixture.task_id,"body":body,"bodyDigest":body_digest,"createdAt":90,"formatVersion":2,"inputBody":input,"inputBodyDigest":digest(input),"intentId":intent_id,"issueId":"456","issueNumber":"7","kind":"status","marker":format!("<!-- task-dag:projection:{intent_id} -->"),"operationId":operation,"provider":"github","repository":"owner/repository","repositoryId":"123","semanticId":"b".repeat(64),"sourceTaskId":fixture.task_id,"sourceTaskOid":source_task_oid});
    let intent_file = fixture.root.join("stale-intent.json");
    fs::write(&intent_file, serde_json::to_vec(&intent).unwrap()).unwrap();
    let intent_oid = ok(
        &fixture.work,
        &[
            "commit-tree",
            EMPTY_TREE,
            "-F",
            intent_file.to_str().unwrap(),
        ],
    );
    let intent_ref = format!(
        "refs/heads/tasks/comments/intents/{}",
        framed("github-comment-operation-key", &[operation])
    );
    ok(
        &fixture.work,
        &["push", "origin", &format!("{intent_oid}:{intent_ref}")],
    );
    let output = fixture.command_with(
        &["comment", "reconcile", "--max", "1", "--older-than", "1s"],
        "normal",
        "500",
        "30000",
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("exact source ancestry"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.calls("LIST") + fixture.calls("POST") + fixture.calls("GET"),
        0
    );
}

#[test]
fn reconciliation_rejects_an_intent_under_the_wrong_operation_ref() {
    let fixture = Fixture::new("wrong-intent-ref", true);
    let failed = fixture.post("wrong-ref-operation", "pending", "permanent-list");
    assert!(!failed.status.success());
    let line = fixture
        .refs("refs/heads/tasks/comments/intents/*")
        .pop()
        .unwrap();
    let (oid, correct_ref) = line.split_once('\t').unwrap();
    let wrong_ref = format!("refs/heads/tasks/comments/intents/{}", "f".repeat(64));
    fixture.remote_update_ref(&wrong_ref, Some(oid));
    fixture.remote_update_ref(correct_ref, None);
    let prior_calls = fs::read_to_string(fixture.state.join("calls")).unwrap();
    let output = fixture.command_with(
        &["comment", "reconcile", "--max", "1", "--older-than", "1s"],
        "normal",
        "101",
        "30000",
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("operation identity"));
    assert_eq!(
        fs::read_to_string(fixture.state.join("calls")).unwrap(),
        prior_calls
    );
}

#[test]
fn reconciliation_rejects_a_live_claim_under_the_wrong_intent_ref() {
    let fixture = Fixture::new("wrong-claim-ref", true);
    let failed = fixture.post("wrong-claim-operation", "pending", "permanent-list");
    assert!(!failed.status.success());
    let line = fixture
        .refs("refs/heads/tasks/comments/delivery-claims/*")
        .pop()
        .unwrap();
    let (oid, correct_ref) = line.split_once('\t').unwrap();
    let wrong_ref = format!(
        "refs/heads/tasks/comments/delivery-claims/{}",
        "e".repeat(64)
    );
    fixture.remote_update_ref(&wrong_ref, Some(oid));
    fixture.remote_update_ref(correct_ref, None);
    let prior_calls = fs::read_to_string(fixture.state.join("calls")).unwrap();
    let output = fixture.command_with(
        &["comment", "reconcile", "--max", "1", "--older-than", "1s"],
        "normal",
        "101",
        "30000",
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("claim ref"));
    assert_eq!(
        fs::read_to_string(fixture.state.join("calls")).unwrap(),
        prior_calls
    );
}

#[test]
fn delivery_deadline_prevents_post_after_a_slow_listing() {
    let fixture = Fixture::new("deadline", true);
    let body = fixture.root.join("deadline.txt");
    fs::write(&body, "deadline").unwrap();
    let output = fixture.command_with(
        &[
            "comment",
            "post",
            &fixture.task_id,
            "--kind",
            "status",
            "--body-file",
            body.to_str().unwrap(),
            "--operation-id",
            "deadline-operation",
        ],
        "slow-list",
        "100",
        "3000",
    );
    assert!(!output.status.success());
    assert_eq!(fixture.calls("LIST"), 1);
    assert_eq!(fixture.calls("POST"), 0);
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/receipts/*")
            .is_empty()
    );
}

#[test]
fn claim_acquisition_consumes_the_delivery_deadline() {
    let fixture = Fixture::new("claim-deadline", true);
    let body = fixture.root.join("claim-deadline.txt");
    fs::write(&body, "claim deadline").unwrap();
    let output = fixture.command_with(
        &[
            "comment",
            "post",
            &fixture.task_id,
            "--kind",
            "status",
            "--body-file",
            body.to_str().unwrap(),
            "--operation-id",
            "claim-deadline-operation",
        ],
        "claim-delay",
        "100",
        "100",
    );
    assert!(!output.status.success());
    assert_eq!(
        fixture.calls("LIST") + fixture.calls("POST") + fixture.calls("GET"),
        0
    );
}

#[test]
fn reconciliation_is_oldest_first_bounded_and_excludes_receipts_and_young_intents() {
    let fixture = Fixture::new("reconcile-order", true);
    for (operation, created) in [("oldest", "90"), ("middle", "95"), ("young", "495")] {
        let output = fixture.post_at(operation, operation, "permanent-list", created);
        assert!(!output.status.success());
    }
    let intents: Vec<(String, String)> = fixture
        .refs("refs/heads/tasks/comments/intents/*")
        .into_iter()
        .map(|line| {
            let (oid, _) = line.split_once('\t').unwrap();
            let value: Value =
                serde_json::from_str(&ok(&fixture.work, &["show", "-s", "--format=%B", oid]))
                    .unwrap();
            (
                value["operationId"].as_str().unwrap().to_owned(),
                oid.to_owned(),
            )
        })
        .collect();
    let oid = |operation: &str| {
        intents
            .iter()
            .find(|(candidate, _)| candidate == operation)
            .unwrap()
            .1
            .clone()
    };
    let receipt_ref = |intent_oid: &str| {
        format!(
            "refs/heads/tasks/comments/receipts/{}",
            framed("github-comment-intent-key", &[intent_oid])
        )
    };

    for expected in ["oldest", "middle"] {
        let output = fixture.command_with(
            &["comment", "reconcile", "--max", "1", "--older-than", "10s"],
            "normal",
            "500",
            "30000",
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["selected"], 1);
        assert_eq!(result["delivered"].as_array().unwrap().len(), 1);
        assert_eq!(
            fixture.refs(&receipt_ref(&oid(expected))).len(),
            1,
            "reconciliation did not select {expected}"
        );
    }
    assert!(fixture.refs(&receipt_ref(&oid("young"))).is_empty());
}
