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

    fn associate(&self, task_id: &str, operation: &str) -> Output {
        self.associate_with_mode(task_id, operation, "normal")
    }

    fn associate_with_mode(&self, task_id: &str, operation: &str, mode: &str) -> Output {
        self.command(
            &[
                "comment",
                "associate",
                task_id,
                "--repository",
                "owner/repository",
                "--issue-number",
                "7",
                "--operation-id",
                operation,
            ],
            mode,
        )
    }

    fn force_request(&self, operation: &str, body: &str) -> Output {
        let file = self.root.join(format!("{operation}-force.txt"));
        fs::write(&file, body).unwrap();
        self.command(
            &[
                "comment",
                "force-request",
                &self.task_id,
                "--repository",
                "owner/repository",
                "--issue-number",
                "7",
                "--kind",
                "status",
                "--body-file",
                file.to_str().unwrap(),
                "--operation-id",
                operation,
                "--amp-thread-url",
                "https://ampcode.com/threads/T-019fba32-3836-77be-8a8b-f411627bcb67",
            ],
            "normal",
        )
    }

    fn force_decide(
        &self,
        request_oid: &str,
        token: &str,
        choice: &str,
        operation: &str,
    ) -> Output {
        let context = self.root.join(format!("{operation}-context.txt"));
        fs::write(&context, "operator approved exact target\n").unwrap();
        self.command(
            &[
                "comment",
                "force-decide",
                request_oid,
                "--choice",
                choice,
                "--decision-token",
                token,
                "--evidence-kind",
                "amp-thread",
                "--evidence",
                "https://ampcode.com/threads/T-019fba32-3836-77be-8a8b-f411627bcb67",
                "--context-file",
                context.to_str().unwrap(),
                "--operation-id",
                operation,
            ],
            "normal",
        )
    }

    fn force_send(&self, request_oid: &str, operation: &str, mode: &str) -> Output {
        self.command(
            &[
                "comment",
                "force-send",
                request_oid,
                "--operation-id",
                operation,
            ],
            mode,
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
  if [[ "$mode" == mixed-case ]]; then full_name=Owner/Repository; else full_name=owner/repository; fi
  jq -n --arg id "$id" --arg full_name "$full_name" '{id:$id,full_name:$full_name}'
elif [[ "$endpoint" == repos/owner/repository/issues/7 ]]; then
  echo TARGET_ISSUE >>"$state/calls"
  if [[ "$mode" == mixed-case ]]; then repository_url=https://api.github.com/repos/Owner/Repository; else repository_url=https://api.github.com/repos/owner/repository; fi
  jq -n --arg repository_url "$repository_url" '{id:"456",number:"7",title:"Comment projection issue",repository_url:$repository_url}'
elif [[ "$endpoint" == */issues/comments/* ]]; then
  echo GET >>"$state/calls"
  id=$(cat "$state/id")
  if [[ "$mode" == mixed-case ]]; then repository=Owner/Repository; else repository=owner/repository; fi
  jq -n --rawfile body "$state/body" --arg id "$id" --arg repository "$repository" '{id:$id,body:$body,html_url:("https://github.com/"+$repository+"/issues/7#issuecomment-"+$id),issue_url:("https://api.github.com/repos/"+$repository+"/issues/7")}'
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
fn associate_creates_paired_aliases_and_conflicting_target_fails_closed() {
    let fixture = Fixture::new("associate", false);
    let first = fixture.associate(&fixture.task_id, "associate-first");
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let result: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(fixture.refs(result["taskRef"].as_str().unwrap()).len(), 1);
    assert_eq!(fixture.refs(result["targetRef"].as_str().unwrap()).len(), 1);
    let task_alias = fixture.refs(result["taskRef"].as_str().unwrap());
    let target_alias = fixture.refs(result["targetRef"].as_str().unwrap());
    assert_eq!(
        task_alias[0].split_once('\t').unwrap().0,
        target_alias[0].split_once('\t').unwrap().0
    );

    let conflict_fixture = Fixture::new("associate-conflict", true);
    let created = conflict_fixture.run_ok(
        &[
            "create",
            "--operation-id",
            "create-conflicting-association",
            "--title",
            "Conflicting association",
            "--description",
            "Must not claim an occupied target",
        ],
        "normal",
    );
    let conflicting =
        conflict_fixture.associate(created["taskId"].as_str().unwrap(), "associate-conflict");
    assert!(!conflicting.status.success());
    assert!(
        String::from_utf8_lossy(&conflicting.stderr).contains("associated differently"),
        "{}",
        String::from_utf8_lossy(&conflicting.stderr)
    );
    assert!(
        conflict_fixture
            .refs(&format!(
                "refs/heads/tasks/comments/bindings/by-task/{}",
                created["taskId"].as_str().unwrap()
            ))
            .is_empty()
    );
}

#[test]
fn mixed_case_provider_repository_identity_is_canonicalized_end_to_end() {
    let fixture = Fixture::new("mixed-case", false);
    let associated =
        fixture.associate_with_mode(&fixture.task_id, "associate-mixed-case", "mixed-case");
    assert!(
        associated.status.success(),
        "{}",
        String::from_utf8_lossy(&associated.stderr)
    );

    let posted = fixture.post("post-mixed-case", "canonical repository", "mixed-case");
    assert!(
        posted.status.success(),
        "{}",
        String::from_utf8_lossy(&posted.stderr)
    );
    let result: Value = serde_json::from_slice(&posted.stdout).unwrap();
    assert_eq!(
        result["commentUrl"],
        "https://github.com/owner/repository/issues/7#issuecomment-9007199254740993"
    );
    assert_eq!(fixture.calls("POST"), 1);
    assert_eq!(
        fixture.refs("refs/heads/tasks/comments/receipts/*").len(),
        1
    );

    let replay = fixture.post("post-mixed-case", "canonical repository", "mixed-case");
    assert!(replay.status.success());
    assert_eq!(
        result,
        serde_json::from_slice::<Value>(&replay.stdout).unwrap()
    );
    assert_eq!(fixture.calls("POST"), 1);
}

#[test]
fn force_request_and_decision_are_canonical_replay_safe_and_token_bound() {
    let fixture = Fixture::new("force-decision", false);
    let requested = fixture.force_request("force-request", "exact forced body");
    assert!(
        requested.status.success(),
        "{}",
        String::from_utf8_lossy(&requested.stderr)
    );
    let packet: Value = serde_json::from_slice(&requested.stdout).unwrap();
    let request_oid = packet["requestOid"].as_str().unwrap();
    let token = packet["decisionToken"].as_str().unwrap();
    let markdown = packet["markdown"].as_str().unwrap();
    assert!(
        markdown.starts_with(
            "# Choose how to post this GitHub comment\n\n**Nothing has been posted.**"
        )
    );
    assert!(markdown.contains("Comment projection issue"));
    assert!(markdown.contains("**Comment fixture**"));
    assert!(markdown.contains("\n    exact forced body\n"));
    assert!(markdown.contains("[Open the current Amp work thread](https://ampcode.com/threads/T-019fba32-3836-77be-8a8b-f411627bcb67)"));
    assert!(!markdown.contains(request_oid));
    assert!(!markdown.contains(token));
    assert!(!markdown.contains(packet["requestId"].as_str().unwrap()));
    let canonical: Value = serde_json::from_str(&ok(
        &fixture.work,
        &["show", "-s", "--format=%B", request_oid],
    ))
    .unwrap();
    assert_eq!(canonical["body"], "exact forced body");
    assert_eq!(canonical["repositoryId"], "123");
    assert_eq!(canonical["issueId"], "456");
    assert!(canonical.get("decisionToken").is_none());

    let replay = fixture.force_request("force-request", "exact forced body");
    assert!(replay.status.success());
    let replay: Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["requestOid"], packet["requestOid"]);
    assert_eq!(replay["decisionTokenAvailable"], false);
    assert!(replay["decisionToken"].is_null());

    let wrong = fixture.force_decide(request_oid, "wrong-token", "force", "force-decision");
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("does not authorize"));
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/forced-target/decisions/*")
            .is_empty()
    );

    let decided = fixture.force_decide(request_oid, token, "force", "force-decision");
    assert!(
        decided.status.success(),
        "{}",
        String::from_utf8_lossy(&decided.stderr)
    );
    let decision: Value = serde_json::from_slice(&decided.stdout).unwrap();
    let exact_replay = fixture.force_decide(request_oid, token, "force", "force-decision");
    assert!(exact_replay.status.success());
    assert_eq!(
        decision,
        serde_json::from_slice::<Value>(&exact_replay.stdout).unwrap()
    );
    let conflict = fixture.force_decide(request_oid, token, "associate", "force-decision");
    assert!(!conflict.status.success());
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("different semantics"));
}

#[test]
fn force_request_rejects_a_target_already_authorized_normally() {
    let fixture = Fixture::new("force-already-bound", true);
    let requested = fixture.force_request("must-use-normal", "normal target body");
    assert!(!requested.status.success());
    assert!(
        String::from_utf8_lossy(&requested.stderr).contains("use comment post"),
        "{}",
        String::from_utf8_lossy(&requested.stderr)
    );
    assert!(
        fixture
            .refs("refs/heads/tasks/comments/forced-target/requests/*")
            .is_empty()
    );
    assert_eq!(fixture.calls("POST"), 0);
}

#[test]
fn force_send_requires_force_decision_and_posts_warning_once() {
    let fixture = Fixture::new("force-send", false);
    let requested = fixture.force_request("send-request", "forced payload");
    assert!(requested.status.success());
    let packet: Value = serde_json::from_slice(&requested.stdout).unwrap();
    let request_oid = packet["requestOid"].as_str().unwrap();
    let token = packet["decisionToken"].as_str().unwrap();

    let missing = fixture.force_send(request_oid, "missing-decision-send", "normal");
    assert!(!missing.status.success());
    assert_eq!(fixture.calls("POST"), 0);

    let associate = fixture.force_decide(request_oid, token, "associate", "associate-decision");
    assert!(associate.status.success());
    let rejected = fixture.force_send(request_oid, "associate-send", "normal");
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("decision chose associate"));
    assert_eq!(fixture.calls("POST"), 0);

    let force_fixture = Fixture::new("force-send-approved", false);
    let requested = force_fixture.force_request("approved-request", "forced payload");
    let packet: Value = serde_json::from_slice(&requested.stdout).unwrap();
    let request_oid = packet["requestOid"].as_str().unwrap();
    let decided = force_fixture.force_decide(
        request_oid,
        packet["decisionToken"].as_str().unwrap(),
        "force",
        "approved-decision",
    );
    assert!(decided.status.success());
    let sent = force_fixture.force_send(request_oid, "approved-send", "uncertain");
    assert!(
        sent.status.success(),
        "{}",
        String::from_utf8_lossy(&sent.stderr)
    );
    assert_eq!(force_fixture.calls("POST"), 1);
    let posted = fs::read_to_string(force_fixture.state.join("body")).unwrap();
    let warning = "> **Forced comment target:** Tooling sent this comment under one-comment operator authorization. The source task may not be canonically associated with this issue; assess their relationship before acting on it.";
    assert_eq!(posted.matches(warning).count(), 1);
    assert!(posted.ends_with(&format!("\n\nforced payload\n\n{warning}\n")));
    assert_eq!(
        force_fixture
            .refs("refs/heads/tasks/comments/receipts/*")
            .len(),
        1
    );
}

#[test]
fn reconciliation_rejects_forced_intent_without_canonical_authorization() {
    let fixture = Fixture::new("forced-authorization-lost", false);
    let requested = fixture.force_request("authorization-request", "pending forced body");
    let packet: Value = serde_json::from_slice(&requested.stdout).unwrap();
    let request_oid = packet["requestOid"].as_str().unwrap();
    let decided = fixture.force_decide(
        request_oid,
        packet["decisionToken"].as_str().unwrap(),
        "force",
        "authorization-decision",
    );
    assert!(decided.status.success());
    let decision: Value = serde_json::from_slice(&decided.stdout).unwrap();
    let failed = fixture.force_send(request_oid, "authorization-send", "permanent-list");
    assert!(!failed.status.success());
    assert_eq!(fixture.calls("POST"), 0);
    let prior_calls = fs::read_to_string(fixture.state.join("calls")).unwrap();

    let decision_oid = decision["decisionOid"].as_str().unwrap();
    let decision_ref = fixture
        .refs("refs/heads/tasks/comments/forced-target/decisions/*")
        .into_iter()
        .find(|line| line.starts_with(decision_oid))
        .unwrap()
        .split_once('\t')
        .unwrap()
        .1
        .to_owned();
    fixture.remote_update_ref(&decision_ref, None);
    let reconciled = fixture.command_with(
        &["comment", "reconcile", "--max", "1", "--older-than", "1s"],
        "normal",
        "500",
        "30000",
    );
    assert!(!reconciled.status.success());
    assert!(
        String::from_utf8_lossy(&reconciled.stderr).contains("canonical authorization"),
        "{}",
        String::from_utf8_lossy(&reconciled.stderr)
    );
    assert_eq!(
        fs::read_to_string(fixture.state.join("calls")).unwrap(),
        prior_calls
    );
}

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
