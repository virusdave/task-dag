use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output},
};

fn framed_digest(domain: &str, parts: &[&str]) -> String {
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

fn git(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
        .env("GIT_AUTHOR_NAME", "task-dag test")
        .env("GIT_AUTHOR_EMAIL", "task-dag-test@localhost")
        .env("GIT_COMMITTER_NAME", "task-dag test")
        .env("GIT_COMMITTER_EMAIL", "task-dag-test@localhost")
        .output()
        .unwrap()
}
fn ok(cwd: &Path, args: &[&str]) -> String {
    let out = git(cwd, args);
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn cli(cwd: &Path, args: &[&str], token: &str, time: u64) -> Output {
    Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .current_dir(cwd)
        .args(args)
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
        .env("TASKDAG_TEST_TOKEN", token)
        .env("TASKDAG_TEST_TIME", time.to_string())
        .env("TASKDAG_TEST_LEGACY_ACTIVATION", "1")
        .env("TASKDAG_SESSION_ID", "integration-session")
        .env(
            "TASKDAG_TEST_RUNTIME_REMOTE",
            cwd.parent().unwrap().join("runtime-origin.git"),
        )
        .output()
        .unwrap()
}
fn success(cwd: &Path, args: &[&str], token: &str, time: u64) -> serde_json::Value {
    let out = cli(cwd, args, token, time);
    assert!(
        out.status.success(),
        "task-dag {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null)
}

fn uncertain(cwd: &Path, args: &[&str], token: &str, time: u64) {
    let out = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .current_dir(cwd)
        .args(args)
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
        .env("TASKDAG_TEST_TOKEN", token)
        .env("TASKDAG_TEST_TIME", time.to_string())
        .env("TASKDAG_TEST_LEGACY_ACTIVATION", "1")
        .env("TASKDAG_SESSION_ID", "integration-session")
        .env(
            "TASKDAG_TEST_RUNTIME_REMOTE",
            cwd.parent().unwrap().join("runtime-origin.git"),
        )
        .env("TASKDAG_TEST_FAIL_AFTER_PUSH", "1")
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "test seam must hide a successful push"
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("failure after push"),
        "unexpected failure: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn current_state_caches_the_runtime_parent_for_one_parent_genesis_activation() {
    let root = std::env::temp_dir().join(format!(
        "taskdag-current-state-genesis-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let origin = root.join("origin.git");
    let checkout = root.join("checkout");
    ok(&root, &["init", "--bare", origin.to_str().unwrap()]);
    ok(&root, &["init", "-b", "master", checkout.to_str().unwrap()]);
    ok(&checkout, &["config", "user.name", "test"]);
    ok(&checkout, &["config", "user.email", "test@localhost"]);
    ok(
        &checkout,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    let empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let floor = ok(&checkout, &["commit-tree", empty_tree, "-m", "floor"]);
    let runtime = ok(
        &checkout,
        &["commit-tree", empty_tree, "-p", &floor, "-m", "runtime"],
    );
    let record = serde_json::json!({
        "allowedRuntimeCommits": [&runtime],
        "epoch": 1,
        "formatVersion": 2,
        "state": "enabled",
        "trustedFloor": &floor,
    });
    let activation = ok(
        &checkout,
        &[
            "commit-tree",
            empty_tree,
            "-p",
            &runtime,
            "-m",
            &serde_json::to_string(&record).unwrap(),
        ],
    );
    ok(
        &checkout,
        &[
            "push",
            "origin",
            &format!("{floor}:refs/heads/master"),
            &format!("{activation}:refs/heads/tasks/v2/activation"),
        ],
    );

    let current = success(
        &checkout,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        100,
    );
    assert_eq!(current["activationOid"], activation);
    assert_eq!(current["formatVersion"], 3);
    assert_eq!(current["scope"], "open");
    assert_eq!(current["provenDone"], serde_json::json!([]));
    assert_eq!(current["rows"], serde_json::json!([]));

    let irrelevant_done = ok(
        &checkout,
        &[
            "commit-tree",
            empty_tree,
            "-m",
            "irrelevant historical done",
        ],
    );
    let mut push_args = vec!["push", "origin"];
    let refspecs: Vec<String> = (0..501)
        .map(|index| {
            let id = format!("v2-{index:064x}");
            format!("{irrelevant_done}:refs/heads/tasks/done/{id}")
        })
        .collect();
    push_args.extend(refspecs.iter().map(String::as_str));
    ok(&checkout, &push_args);
    let after_history_growth = success(
        &checkout,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        100,
    );
    assert_eq!(after_history_growth["rows"], serde_json::json!([]));
    assert_eq!(after_history_growth["provenDone"], serde_json::json!([]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bare_origin_claims_breakdown_and_ops_atomicity_ignore_historical_journal() {
    let root = std::env::temp_dir().join(format!("taskdag-rust-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let origin = root.join("origin.git");
    let runtime_origin = root.join("runtime-origin.git");
    ok(&root, &["init", "--bare", origin.to_str().unwrap()]);
    ok(&root, &["init", "--bare", runtime_origin.to_str().unwrap()]);
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let runtime = env!("TASKDAG_BUILD_COMMIT");
    let floor = ok(
        source,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-m",
            "unrelated peer floor",
        ],
    );
    ok(
        source,
        &[
            "push",
            origin.to_str().unwrap(),
            &format!("{floor}:refs/heads/master"),
        ],
    );
    let a = root.join("a");
    let b = root.join("b");
    ok(
        &root,
        &["clone", origin.to_str().unwrap(), a.to_str().unwrap()],
    );
    ok(
        &root,
        &["clone", origin.to_str().unwrap(), b.to_str().unwrap()],
    );
    for checkout in [&a, &b] {
        ok(checkout, &["config", "user.name", "test"]);
        ok(checkout, &["config", "user.email", "test@localhost"]);
        let hooks = checkout.join(".githooks");
        fs::create_dir(&hooks).unwrap();
        fs::copy(source.join(".githooks/pre-push"), hooks.join("pre-push")).unwrap();
        ok(checkout, &["config", "core.hooksPath", ".githooks"]);
    }
    ok(&a, &["fetch", source.to_str().unwrap(), runtime]);
    success(
        &a,
        &["runtime", "publish", "--commit", runtime],
        "unused-token-000",
        100,
    );
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!("{floor}:refs/heads/tasks/system/transitions"),
        ],
    );
    let historical_journal = floor.clone();

    uncertain(
        &a,
        &[
            "init",
            "--trusted-floor",
            &floor,
            "--repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
        "unused-token-000",
        100,
    );
    success(
        &a,
        &[
            "init",
            "--trusted-floor",
            &floor,
            "--repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
        "unused-token-000",
        100,
    );
    let activation_lease = success(&a, &["activation"], "unused-token-000", 100)["activationOid"]
        .as_str()
        .unwrap()
        .to_owned();
    let current = success(
        &a,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        100,
    );
    assert_eq!(current["formatVersion"], 3);
    assert_eq!(current["scope"], "open");
    assert_eq!(current["activationOid"], activation_lease);
    assert!(current.get("journalOid").is_none());
    assert!(current.get("activation").is_none());
    assert!(current.get("journal").is_none());
    assert_eq!(current["rows"], serde_json::json!([]));
    assert_eq!(current["fingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(
        current,
        success(
            &a,
            &["current-state", "--max-tasks", "500"],
            "unused-token-000",
            100,
        ),
        "unchanged current-state output must be deterministic"
    );
    let activation_record = success(&a, &["activation"], "unused-token-000", 100)["record"].clone();
    let operation = "current-state-rollover-regression";
    let repository_id = activation_record["repositoryId"].as_str().unwrap();
    let fleet_digest = activation_record["fleetDigest"].as_str().unwrap();
    let logical_id = framed_digest(
        "activate-runtime-logical-v3",
        &[
            runtime,
            &activation_lease,
            operation,
            repository_id,
            fleet_digest,
        ],
    );
    let rollover_record = serde_json::json!({
        "allowedRuntimeCommits": [runtime],
        "epoch": 2,
        "fleetDigest": fleet_digest,
        "fleetRepositoryIds": activation_record["fleetRepositoryIds"],
        "formatVersion": 3,
        "logicalId": logical_id,
        "operationId": operation,
        "repositoryId": repository_id,
        "state": "enabled",
        "trustedFloor": floor,
    });
    let rollover = ok(
        &a,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-p",
            &activation_lease,
            "-p",
            runtime,
            "-m",
            &serde_json::to_string(&rollover_record).unwrap(),
        ],
    );
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!("{rollover}:refs/heads/tasks/v2/activation"),
        ],
    );
    assert_eq!(
        success(
            &a,
            &["current-state", "--max-tasks", "500"],
            "unused-token-000",
            100,
        )["activationOid"],
        rollover,
        "current-state must cache the immediate activation predecessor before cache-only validation"
    );
    for invalid in ["0", "501"] {
        let rejected = cli(
            &a,
            &["current-state", "--max-tasks", invalid],
            "unused-token-000",
            100,
        );
        assert!(!rejected.status.success());
        assert!(String::from_utf8_lossy(&rejected.stderr).contains("between 1 and 500"));
    }
    let empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let legacy_frontier = ok(
        &a,
        &["commit-tree", empty_tree, "-m", "legacy v1 frontier task"],
    );
    let legacy_blocked = ok(
        &a,
        &["commit-tree", empty_tree, "-m", "legacy v1 blocked task"],
    );
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!("{legacy_frontier}:refs/heads/tasks/frontier/1234567"),
            &format!("{legacy_blocked}:refs/heads/tasks/blocked/1234567"),
        ],
    );
    assert_eq!(
        success(&a, &["frontier"], "unused-token-000", 100)["tasks"],
        serde_json::json!([])
    );
    assert_eq!(
        success(&a, &["blocked"], "unused-token-000", 100)["tasks"],
        serde_json::json!([])
    );
    let non_repo = root.join("not-a-repository");
    fs::create_dir(&non_repo).unwrap();
    for args in [["dep", "add", "ignored"], ["dep", "drop", "ignored"]] {
        let rejected = cli(&non_repo, &args, "unused-token-000", 100);
        assert!(!rejected.status.success());
        assert!(String::from_utf8_lossy(&rejected.stderr).contains("requirements are immutable"));
    }
    let legacy_compose = cli(
        &non_repo,
        &["epic-compose", "--source-checkout", "/tmp/source"],
        "unused-token-000",
        100,
    );
    assert!(!legacy_compose.status.success());
    assert!(String::from_utf8_lossy(&legacy_compose.stderr).contains("unexpected argument"));
    let malformed_id = format!("v2-{}", "f".repeat(64));
    let malformed = ok(
        &a,
        &[
            "commit-tree",
            empty_tree,
            "-m",
            "malformed v2 blocked record",
        ],
    );
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!("{malformed}:refs/heads/tasks/blocked/{malformed_id}"),
        ],
    );
    let malformed_read = cli(&a, &["blocked"], "unused-token-000", 100);
    assert!(!malformed_read.status.success());
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!(":refs/heads/tasks/blocked/{malformed_id}"),
        ],
    );
    let legacy_created = success(
        &a,
        &[
            "create",
            "--operation-id",
            "legacy-block-fixture",
            "--title",
            "Legacy blocked fixture",
            "--description",
            "Exercise bounded compatibility normalization",
            "--claim",
        ],
        "legacy-block-token",
        100,
    );
    let legacy_id = legacy_created["taskId"].as_str().unwrap();
    let legacy_active_ref = format!("refs/heads/tasks/active/{legacy_id}");
    let legacy_blocked_ref = format!("refs/heads/tasks/blocked/{legacy_id}");
    let legacy_active = ok(&a, &["ls-remote", "origin", &legacy_active_ref])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    ok(&a, &["fetch", "origin", &legacy_active]);
    let legacy_active_value: serde_json::Value =
        serde_json::from_str(&ok(&a, &["show", "-s", "--format=%B", &legacy_active])).unwrap();
    let legacy_task = legacy_active_value["taskOid"].as_str().unwrap();
    let legacy_body = root.join("legacy-blocked-v2.json");
    fs::write(
        &legacy_body,
        serde_json::to_vec(&serde_json::json!({
            "authorizationRequired": true,
            "condition": {"kind": "manual"},
            "evidence": ["fixture:evidence"],
            "formatVersion": 2,
            "logicalId": "1".repeat(64),
            "operationId": "legacy-block-operation",
            "question": "Keep this task paused?",
            "reason": "Legacy operator pause",
            "taskId": legacy_id,
            "taskOid": legacy_task,
        }))
        .unwrap(),
    )
    .unwrap();
    let legacy_blocked = ok(
        &a,
        &[
            "commit-tree",
            empty_tree,
            "-p",
            &legacy_active,
            "-p",
            legacy_task,
            "-F",
            legacy_body.to_str().unwrap(),
        ],
    );
    ok(
        &a,
        &[
            "push",
            "--atomic",
            "origin",
            &format!(":{legacy_active_ref}"),
            &format!("{legacy_blocked}:{legacy_blocked_ref}"),
        ],
    );
    assert_eq!(
        success(&a, &["show", legacy_id], "unused-token-000", 100)["state"],
        "blocked"
    );
    success(
        &a,
        &[
            "unblock",
            legacy_id,
            "--block-lease",
            &legacy_blocked,
            "--authorization",
            "fixture schema repair",
            "--operation-id",
            "legacy-block-unblock",
        ],
        "unused-token-000",
        100,
    );
    assert_eq!(
        success(&a, &["show", legacy_id], "unused-token-000", 100)["state"],
        "frontier"
    );
    let identity = success(&a, &["activation"], "unused-token-000", 100);
    assert_eq!(identity["record"]["formatVersion"], 3);
    assert_eq!(
        identity["record"]["repositoryId"],
        "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(
        identity["record"]["fleetRepositoryIds"],
        serde_json::json!([
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ])
    );
    assert_eq!(
        identity["record"]["allowedRuntimeCommits"],
        serde_json::json!([runtime])
    );
    let delegated_parent = success(
        &a,
        &[
            "create",
            "--operation-id",
            "delegated-parent",
            "--title",
            "Delegated parent",
            "--description",
            "parent task",
            "--claim",
        ],
        "delegated-parent-token",
        100,
    );
    let delegated_spec = root.join("delegated-spec.json");
    fs::write(
        &delegated_spec,
        r#"{"operationId":"delegated-split","children":[{"key":"source","title":"Delegated source","description":"source task","requires":[],"claim":true}]}"#,
    )
    .unwrap();
    let delegated_split = success(
        &a,
        &[
            "breakdown",
            delegated_parent["taskId"].as_str().unwrap(),
            "--spec",
            delegated_spec.to_str().unwrap(),
            "--claim-token",
            delegated_parent["claimToken"].as_str().unwrap(),
        ],
        "delegated-source-token",
        100,
    );
    let delegated_source = delegated_split["children"][0].clone();
    let delegate_args = [
        "delegate",
        "create",
        delegated_source["taskId"].as_str().unwrap(),
        "--target-repository-id",
        "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--operation-id",
        "delegation-fixture",
        "--title",
        "Delegated target",
        "--description",
        "Delegated target\n\nUnicode: naïve 🛰️\nQuotes: \"quoted\"\nTab:\tvalue",
        "--claim-token",
        delegated_source["claimToken"].as_str().unwrap(),
    ];
    uncertain(&a, &delegate_args, "unused-token-000", 100);
    let delegated = success(&a, &delegate_args, "unused-token-000", 100);
    assert!(delegated["intentOid"].as_str().is_some());
    assert_eq!(
        success(
            &a,
            &["show", delegated_source["taskId"].as_str().unwrap()],
            "unused-token-000",
            100,
        )["state"],
        "waiting"
    );
    for command in ["context", "dag"] {
        let neighborhood = success(
            &a,
            &[command, delegated_source["taskId"].as_str().unwrap()],
            "unused-token-000",
            100,
        );
        assert_eq!(neighborhood["state"], "waiting");
        assert_eq!(neighborhood["directChildren"], serde_json::json!([]));
    }
    let delegated_current = success(
        &a,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        100,
    );
    let delegated_row = delegated_current["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["taskId"] == delegated_source["taskId"])
        .unwrap();
    assert_eq!(
        delegated_row["context"]["directChildren"],
        serde_json::json!([])
    );
    let target_origin = root.join("target-origin.git");
    ok(&root, &["init", "--bare", target_origin.to_str().unwrap()]);
    let target_floor = ok(
        source,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-m",
            "delegation target floor",
        ],
    );
    ok(
        source,
        &[
            "push",
            target_origin.to_str().unwrap(),
            &format!("{target_floor}:refs/heads/master"),
        ],
    );
    let target = root.join("target");
    ok(
        &root,
        &[
            "clone",
            target_origin.to_str().unwrap(),
            target.to_str().unwrap(),
        ],
    );
    ok(&target, &["config", "user.name", "test"]);
    ok(&target, &["config", "user.email", "test@localhost"]);
    fs::create_dir(target.join(".githooks")).unwrap();
    fs::copy(
        source.join(".githooks/pre-push"),
        target.join(".githooks/pre-push"),
    )
    .unwrap();
    ok(&target, &["config", "core.hooksPath", ".githooks"]);
    ok(&target, &["fetch", source.to_str().unwrap(), runtime]);
    success(
        &target,
        &[
            "init",
            "--trusted-floor",
            &target_floor,
            "--repository-id",
            "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "--fleet-repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
        "unused-token-000",
        100,
    );
    let admit_args = [
        "delegate",
        "admit",
        "--source-remote",
        origin.to_str().unwrap(),
        "--operation-id",
        "delegation-fixture",
    ];
    uncertain(&target, &admit_args, "unused-token-000", 100);
    let admitted = success(&target, &admit_args, "unused-token-000", 100);
    assert_eq!(admitted["taskId"], delegated["targetTaskId"]);
    let admitted_task = success(
        &target,
        &["context", admitted["taskId"].as_str().unwrap()],
        "unused-token-000",
        100,
    );
    assert_eq!(
        admitted_task["task"]["description"],
        "Delegated target\n\nUnicode: naïve 🛰️\nQuotes: \"quoted\"\nTab:\tvalue"
    );
    assert_eq!(admitted_task["state"], "frontier");
    let target_claim = success(
        &target,
        &[
            "claim",
            admitted["taskId"].as_str().unwrap(),
            "--owner",
            "delegation-target-worker",
            "--operation-id",
            "delegation-target-claim",
        ],
        "delegation-target-token",
        101,
    );
    success(
        &target,
        &[
            "complete-ops",
            admitted["taskId"].as_str().unwrap(),
            "--description",
            "delegated target complete",
            "--authorization",
            "fixture",
            "--claim-token",
            target_claim["claimToken"].as_str().unwrap(),
        ],
        "unused-token-000",
        102,
    );
    let export_args = [
        "delegate",
        "export",
        "--source-repository-id",
        "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--operation-id",
        "delegation-fixture",
    ];
    uncertain(&target, &export_args, "unused-token-000", 103);
    let exported = success(&target, &export_args, "unused-token-000", 103);
    assert!(exported["exportOid"].as_str().is_some());
    let accept_args = [
        "delegate",
        "accept",
        "--target-remote",
        target_origin.to_str().unwrap(),
        "--operation-id",
        "delegation-fixture",
    ];
    uncertain(&a, &accept_args, "unused-token-000", 104);
    let accepted = success(&a, &accept_args, "unused-token-000", 104);
    assert_eq!(accepted["taskId"], delegated_source["taskId"]);
    assert_eq!(
        success(
            &a,
            &["show", delegated_source["taskId"].as_str().unwrap()],
            "unused-token-000",
            104,
        )["state"],
        "done"
    );
    let delegated_current = success(
        &a,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        104,
    );
    assert!(
        delegated_current["provenDone"]
            .as_array()
            .unwrap()
            .iter()
            .any(|proof| proof["taskId"] == delegated_source["taskId"])
    );
    let delegated_parent_id = delegated_parent["taskId"].as_str().unwrap();
    let delegated_parent_waiting_ref = format!("refs/heads/tasks/waiting/{delegated_parent_id}");
    let delegated_parent_marker = format!("refs/heads/tasks/reconcile/{delegated_parent_id}");
    let delegated_parent_waiting_oid =
        ok(&a, &["ls-remote", "origin", &delegated_parent_waiting_ref])
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
    assert_eq!(
        ok(&a, &["ls-remote", "origin", &delegated_parent_marker])
            .split_whitespace()
            .next(),
        Some(delegated_parent_waiting_oid.as_str())
    );
    ok(
        &a,
        &["push", "origin", &format!(":{delegated_parent_marker}")],
    );
    let missing_marker = cli(
        &a,
        &[
            "converge",
            delegated_parent_id,
            "--operation-id",
            "delegated-split",
        ],
        "unused-token-000",
        104,
    );
    assert!(!missing_marker.status.success());
    assert!(
        String::from_utf8_lossy(&missing_marker.stderr)
            .contains("exact reconciliation marker is absent")
    );
    success(&a, &accept_args, "unused-token-000", 104);
    assert_eq!(
        ok(&a, &["ls-remote", "origin", &delegated_parent_marker])
            .split_whitespace()
            .next(),
        Some(delegated_parent_waiting_oid.as_str())
    );
    success(
        &a,
        &[
            "converge",
            delegated_parent_id,
            "--operation-id",
            "delegated-split",
        ],
        "unused-token-000",
        104,
    );
    assert_eq!(
        success(
            &a,
            &["show", delegated_parent["taskId"].as_str().unwrap()],
            "unused-token-000",
            104,
        )["state"],
        "done"
    );
    ok(
        &a,
        &[
            "push",
            "origin",
            &format!("{delegated_parent_waiting_oid}:{delegated_parent_marker}"),
        ],
    );
    success(&a, &accept_args, "unused-token-000", 104);
    assert!(ok(&a, &["ls-remote", "origin", &delegated_parent_marker]).is_empty());
    let source_task_id = delegated_source["taskId"].as_str().unwrap();
    let done_ref = format!("refs/heads/tasks/done/{source_task_id}");
    let original_done = ok(&a, &["ls-remote", "origin", &done_ref])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    ok(&a, &["fetch", "origin", &original_done]);
    let original_done_value: serde_json::Value =
        serde_json::from_str(&ok(&a, &["show", "-s", "--format=%B", &original_done])).unwrap();
    let original_task_oid = original_done_value["taskOid"].as_str().unwrap();
    let task_body = root.join("same-id-task.json");
    fs::write(
        &task_body,
        ok(&a, &["show", "-s", "--format=%B", original_task_oid]),
    )
    .unwrap();
    let other_task_oid = ok(
        &a,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-F",
            task_body.to_str().unwrap(),
        ],
    );
    assert_ne!(other_task_oid, original_task_oid);
    let mut malformed_done_value = original_done_value;
    malformed_done_value["taskOid"] = serde_json::Value::String(other_task_oid.clone());
    let malformed_body = root.join("same-id-malformed-done.json");
    fs::write(
        &malformed_body,
        serde_json::to_vec(&malformed_done_value).unwrap(),
    )
    .unwrap();
    let parents = ok(&a, &["show", "-s", "--format=%P", &original_done]);
    let mut commit_tree_args = vec![
        "commit-tree".to_owned(),
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_owned(),
    ];
    for (index, parent) in parents.split_whitespace().enumerate() {
        commit_tree_args.extend([
            "-p".to_owned(),
            if index == 1 {
                other_task_oid.clone()
            } else {
                parent.to_owned()
            },
        ]);
    }
    commit_tree_args.extend([
        "-F".to_owned(),
        malformed_body.to_string_lossy().into_owned(),
    ]);
    let commit_tree_refs: Vec<&str> = commit_tree_args.iter().map(String::as_str).collect();
    let malformed_done = ok(&a, &commit_tree_refs);
    ok(
        &a,
        &[
            "push",
            "--force",
            "origin",
            &format!("{malformed_done}:{done_ref}"),
        ],
    );
    let malformed_show = cli(&a, &["show", source_task_id], "unused-token-000", 104);
    assert!(
        !malformed_show.status.success(),
        "delegated done must reject a different Task object sharing its Task-ID"
    );
    ok(
        &a,
        &[
            "push",
            "--force",
            "origin",
            &format!("{original_done}:{done_ref}"),
        ],
    );
    let delegation_status = success(
        &a,
        &["delegate", "status", "--operation-id", "delegation-fixture"],
        "unused-token-000",
        104,
    );
    assert!(delegation_status["intent"].as_str().is_some());
    assert!(delegation_status["accepted"].as_str().is_some());
    let late_create_args = [
        "create",
        "--operation-id",
        "late-create",
        "--title",
        "Late",
        "--description",
        "Retry after a successor",
    ];
    uncertain(&a, &late_create_args, "unused-token-000", 100);
    let late_original = success(&a, &late_create_args, "unused-token-000", 101);
    assert!(late_original["claimToken"].is_null());
    let late_id = late_original["taskId"].as_str().unwrap();
    let late_claim_args = [
        "claim",
        late_id,
        "--owner",
        "fixture",
        "--operation-id",
        "late-claim",
    ];
    uncertain(&a, &late_claim_args, "late-claim-token", 102);
    let late_claim = success(&a, &late_claim_args, "late-claim-token", 102);
    let renew_args = [
        "renew",
        late_id,
        "--claim-token",
        "late-claim-token",
        "--ttl-hours",
        "2",
        "--operation-id",
        "late-renew",
    ];
    uncertain(&a, &renew_args, "unused-token-000", 200);
    let renewed = success(&a, &renew_args, "unused-token-000", 200);
    assert_eq!(
        success(
            &b,
            &[
                "claim",
                late_id,
                "--owner",
                "fixture",
                "--operation-id",
                "late-claim"
            ],
            "other-token-0000",
            999
        ),
        late_claim
    );
    let release_args = [
        "release",
        late_id,
        "--claim-token",
        "late-claim-token",
        "--operation-id",
        "late-release",
    ];
    uncertain(&a, &release_args, "unused-token-000", 201);
    success(&a, &release_args, "unused-token-000", 201);
    assert_eq!(
        success(
            &a,
            &[
                "renew",
                late_id,
                "--claim-token",
                "late-claim-token",
                "--ttl-hours",
                "2",
                "--operation-id",
                "late-renew"
            ],
            "unused-token-000",
            999
        ),
        renewed
    );
    success(
        &a,
        &[
            "claim",
            late_id,
            "--owner",
            "fixture",
            "--ttl-hours",
            "1",
            "--operation-id",
            "reap-claim",
        ],
        "reap-token-00000",
        1_000,
    );
    let reap_args = ["reap", late_id, "--operation-id", "late-reap"];
    uncertain(&a, &reap_args, "unused-token-000", 4_600);
    let reaped = success(&a, &reap_args, "unused-token-000", 4_600);
    success(
        &a,
        &[
            "claim",
            late_id,
            "--owner",
            "fixture",
            "--operation-id",
            "after-reap",
        ],
        "after-reap-token",
        4_601,
    );
    assert_eq!(
        success(
            &a,
            &["reap", late_id, "--operation-id", "late-reap"],
            "unused-token-000",
            99_999
        ),
        reaped
    );
    assert_eq!(
        success(&a, &late_create_args, "different-token-0", 999),
        late_original,
        "create replay must retain its original no-token output after claim"
    );
    let changed_late = cli(
        &a,
        &[
            "create",
            "--operation-id",
            "late-create",
            "--title",
            "Different",
            "--description",
            "Retry after a successor",
        ],
        "unused-token-000",
        103,
    );
    assert!(!changed_late.status.success());
    let retry_args = [
        "create",
        "--operation-id",
        "retry-op",
        "--title",
        "Retry",
        "--description",
        "exact",
        "--claim",
    ];
    uncertain(&a, &retry_args, "retry-token-0000", 100);
    let retried = success(&a, &retry_args, "different-token-0", 999);
    assert_eq!(retried["claimToken"], "retry-token-0000");
    let changed = cli(
        &a,
        &[
            "create",
            "--operation-id",
            "retry-op",
            "--title",
            "Changed",
            "--description",
            "exact",
            "--claim",
        ],
        "unused-token-000",
        1000,
    );
    assert!(
        !changed.status.success(),
        "same operation with changed semantics must conflict"
    );
    let direct = success(
        &a,
        &[
            "create",
            "--operation-id",
            "direct-op",
            "--title",
            "Direct",
            "--description",
            "Direct completion",
            "--claim",
        ],
        "direct-token-000",
        100,
    );
    fs::write(a.join("direct.txt"), "published\n").unwrap();
    ok(&a, &["add", "direct.txt"]);
    ok(&a, &["commit", "-m", "Direct fixture publication"]);
    let publication = ok(&a, &["rev-parse", "HEAD"]);
    let complete_args = [
        "complete",
        direct["taskId"].as_str().unwrap(),
        "--commit",
        &publication,
        "--claim-token",
        "direct-token-000",
    ];
    uncertain(&a, &complete_args, "unused-token-000", 101);
    success(&a, &complete_args, "unused-token-000", 101);
    assert_eq!(
        ok(&a, &["ls-remote", "origin", "refs/heads/master"])
            .split_whitespace()
            .next(),
        Some(publication.as_str())
    );
    let create_alias_args = [
        "epic-create",
        "--operation-id",
        "root-op",
        "--title",
        "Root",
        "--description",
        "Root task\n\nUnicode: café 🚀\nQuotes: “hello”\nTab:\tvalue\nMarkdown: **bold**",
        "--claim",
    ];
    let created_raw = cli(&a, &create_alias_args, "parent-token-000", 100);
    assert!(created_raw.status.success());
    let created: serde_json::Value = serde_json::from_slice(&created_raw.stdout).unwrap();
    let canonical_create_args = [
        "create",
        "--operation-id",
        "root-op",
        "--title",
        "Root",
        "--description",
        "Root task\n\nUnicode: café 🚀\nQuotes: “hello”\nTab:\tvalue\nMarkdown: **bold**",
        "--claim",
    ];
    assert_eq!(
        cli(&a, &canonical_create_args, "other-token-000", 100).stdout,
        created_raw.stdout
    );
    let id = created["taskId"].as_str().unwrap();
    assert_eq!(created["claimToken"], "parent-token-000");
    assert_eq!(
        success(&a, &["context", id], "unused-token-000", 100)["task"]["description"],
        "Root task\n\nUnicode: café 🚀\nQuotes: “hello”\nTab:\tvalue\nMarkdown: **bold**"
    );
    let wrong = cli(
        &b,
        &[
            "complete-ops",
            id,
            "--description",
            "done",
            "--authorization",
            "test",
            "--claim-token",
            "wrong-token-000",
        ],
        "unused-token-000",
        101,
    );
    assert!(!wrong.status.success());
    let stale = cli(
        &b,
        &[
            "complete-ops",
            id,
            "--description",
            "done",
            "--authorization",
            "test",
            "--claim-token",
            "parent-token-000",
        ],
        "unused-token-000",
        100 + 12 * 3600,
    );
    assert!(!stale.status.success());

    let spec = root.join("breakdown.json");
    fs::write(&spec, r#"{"operationId":"split","children":[{"key":"a","title":"A","description":"Child A\n\n- Unicode: 你好\n- Tab:\tvalue\n- Markdown: `code`","requires":[],"claim":true},{"key":"b","title":"B","description":"B","requires":[],"claim":true},{"key":"c","title":"C","description":"C","requires":["a"],"claim":false}]}"#).unwrap();
    let breakdown_args = [
        "epic-compose",
        id,
        "--spec",
        spec.to_str().unwrap(),
        "--claim-token",
        "parent-token-000",
    ];
    uncertain(&a, &breakdown_args, "child-token-0000", 102);
    let split_raw = cli(&a, &breakdown_args, "child-token-0000", 102);
    assert!(split_raw.status.success());
    let split: serde_json::Value = serde_json::from_slice(&split_raw.stdout).unwrap();
    let canonical_breakdown_args = [
        "breakdown",
        id,
        "--spec",
        spec.to_str().unwrap(),
        "--claim-token",
        "parent-token-000",
    ];
    assert_eq!(
        cli(&a, &canonical_breakdown_args, "other-token-000", 102).stdout,
        split_raw.stdout
    );
    let children = split["children"].as_array().unwrap();
    let dag_raw = cli(&a, &["dag", id], "unused-token-000", 102);
    let context_raw = cli(&a, &["context", id], "unused-token-000", 102);
    assert!(dag_raw.status.success() && context_raw.status.success());
    assert_eq!(dag_raw.stdout, context_raw.stdout);
    let neighborhood: serde_json::Value = serde_json::from_slice(&dag_raw.stdout).unwrap();
    assert_eq!(neighborhood["state"], "waiting");
    assert_eq!(neighborhood["directChildren"].as_array().unwrap().len(), 3);
    assert_eq!(
        neighborhood["directChildren"],
        serde_json::Value::Array(
            children
                .iter()
                .map(
                    |child| serde_json::json!({"taskId":child["taskId"],"taskOid":child["taskOid"]})
                )
                .collect()
        )
    );
    assert_eq!(
        children
            .iter()
            .filter(|c| !c["claimToken"].is_null())
            .count(),
        2
    );
    assert_ne!(children[0]["claimToken"], children[1]["claimToken"]);
    let child_token = children[0]["claimToken"].as_str().unwrap();
    assert_eq!(
        success(
            &a,
            &["context", children[0]["taskId"].as_str().unwrap()],
            "unused-token-000",
            102,
        )["task"]["description"],
        "Child A\n\n- Unicode: 你好\n- Tab:\tvalue\n- Markdown: `code`"
    );

    let master_before = ok(&a, &["ls-remote", "origin", "refs/heads/master"])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    let child = children[0]["taskId"].as_str().unwrap();
    let multiline_prefix =
        "Agent Gate Record\n\n- exact production-compatible multiline evidence\n- tab:\tvalue";
    let multiline_evidence = format!(
        "{multiline_prefix}{}",
        "x".repeat(16_384 - multiline_prefix.len()),
    );
    assert_eq!(multiline_evidence.len(), 16_384);
    let mut near_limit_evidence = vec![multiline_evidence.clone()];
    near_limit_evidence.extend((1..15).map(|_| "x".repeat(16_384)));
    let mut complete_ops_args = vec![
        "complete-ops",
        child,
        "--description",
        "verified",
        "--authorization",
        "fixture",
    ];
    for value in &near_limit_evidence {
        complete_ops_args.extend(["--evidence", value]);
    }
    complete_ops_args.extend(["--claim-token", child_token]);
    uncertain(&b, &complete_ops_args, "unused-token-000", 103);
    success(&b, &complete_ops_args, "unused-token-000", 103);
    let completed = success(&a, &["show", child], "unused-token-000", 103);
    assert_eq!(
        completed["record"]["evidence"][0]["value"],
        multiline_evidence
    );
    assert_eq!(
        completed["record"]["evidence"].as_array().unwrap().len(),
        15
    );
    let current = success(
        &a,
        &["current-state", "--max-tasks", "500"],
        "unused-token-000",
        103,
    );
    assert!(
        current["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["taskId"] != child),
        "done tasks must not be returned as open rows"
    );
    assert!(
        current["provenDone"]
            .as_array()
            .unwrap()
            .iter()
            .any(|proof| proof["taskId"] == child
                && proof["taskOid"] == completed["record"]["taskOid"]),
        "an open parent's completed child must have exact done proof"
    );
    let completed_row = success(&a, &["show", child], "unused-token-000", 103);
    assert_eq!(
        completed_row["record"]["evidence"][0]["value"],
        multiline_evidence
    );
    assert_eq!(
        completed_row["record"]["evidence"]
            .as_array()
            .unwrap()
            .len(),
        15
    );

    let oversized = success(
        &a,
        &[
            "create",
            "--operation-id",
            "oversized-operations-evidence",
            "--title",
            "Oversized operations evidence",
            "--description",
            "Writer must preserve the current-state object bound",
            "--claim",
        ],
        "oversized-operations-token",
        103,
    );
    let oversized_id = oversized["taskId"].as_str().unwrap();
    let oversized_token = oversized["claimToken"].as_str().unwrap();
    let oversized_evidence = vec!["y".repeat(16_384); 17];
    let mut oversized_args = vec![
        "complete-ops",
        oversized_id,
        "--description",
        "must remain active",
        "--authorization",
        "fixture",
    ];
    for value in &oversized_evidence {
        oversized_args.extend(["--evidence", value]);
    }
    oversized_args.extend(["--claim-token", oversized_token]);
    let oversized_rejected = cli(&a, &oversized_args, "unused-token-000", 103);
    assert!(!oversized_rejected.status.success());
    assert!(
        String::from_utf8_lossy(&oversized_rejected.stderr)
            .contains("exceeds per-object byte limit")
    );
    assert_eq!(
        success(&a, &["show", oversized_id], "unused-token-000", 103)["state"],
        "active"
    );
    let second = children[1]["taskId"].as_str().unwrap();
    let second_token = children[1]["claimToken"].as_str().unwrap();
    let second_active_ref = format!("refs/heads/tasks/active/{second}");
    let second_active = ok(&a, &["ls-remote", "origin", &second_active_ref])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    ok(&a, &["fetch", "origin", &second_active]);
    let second_active_value: serde_json::Value =
        serde_json::from_str(&ok(&a, &["show", "-s", "--format=%B", &second_active])).unwrap();
    let second_task = second_active_value["taskOid"].as_str().unwrap();
    ok(&a, &["fetch", "origin", second_task]);
    let legacy_value = "legacy evidence";
    let legacy_values = vec![legacy_value.to_owned(); 65];
    let legacy_evidence: Vec<_> = legacy_values
        .iter()
        .map(|value| serde_json::json!({"digest":framed_digest("digest", &[value]),"value":value}))
        .collect();
    let legacy_description = "historical writer accepted 65 evidence entries";
    let legacy_authorization = "fixture";
    let legacy_logical = framed_digest(
        "complete-ops-logical",
        &[
            "complete-ops",
            second,
            legacy_description,
            legacy_authorization,
            &serde_json::to_string(&legacy_values).unwrap(),
            second_token,
        ],
    );
    let legacy_done_body = root.join("legacy-ops-done.json");
    fs::write(
        &legacy_done_body,
        serde_json::to_vec(&serde_json::json!({
            "attemptId": legacy_logical,
            "authorization": legacy_authorization,
            "description": legacy_description,
            "evidence": legacy_evidence,
            "formatVersion": 2,
            "logicalId": legacy_logical,
            "taskId": second,
            "taskOid": second_task,
        }))
        .unwrap(),
    )
    .unwrap();
    let legacy_done = ok(
        &a,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-p",
            &second_active,
            "-p",
            second_task,
            "-F",
            legacy_done_body.to_str().unwrap(),
        ],
    );
    let second_done_ref = format!("refs/heads/tasks/done/{second}");
    ok(
        &a,
        &[
            "push",
            "--atomic",
            "origin",
            &format!(":{second_active_ref}"),
            &format!("{legacy_done}:{second_done_ref}"),
        ],
    );
    let mut legacy_replay_args = vec![
        "complete-ops",
        second,
        "--description",
        legacy_description,
        "--authorization",
        legacy_authorization,
    ];
    for value in &legacy_values {
        legacy_replay_args.extend(["--evidence", value]);
    }
    legacy_replay_args.extend(["--claim-token", second_token]);
    success(&a, &legacy_replay_args, "unused-token-000", 104);
    let legacy_row = success(&a, &["show", second], "unused-token-000", 104);
    assert_eq!(
        legacy_row["record"]["evidence"].as_array().unwrap().len(),
        65
    );
    success(&b, &complete_ops_args, "unused-token-000", 105);
    let master_after = ok(&b, &["ls-remote", "origin", "refs/heads/master"])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(master_before, master_after);
    let converging = success(
        &a,
        &[
            "create",
            "--operation-id",
            "converging-root",
            "--title",
            "Converging",
            "--description",
            "Receipt after convergence",
            "--claim",
        ],
        "converge-parent-token",
        500,
    );
    let converging_id = converging["taskId"].as_str().unwrap();
    let converge_spec = root.join("converge-breakdown.json");
    fs::write(&converge_spec, r#"{"operationId":"converge-split","children":[{"key":"only","title":"Only","description":"Only","requires":[],"claim":true}]}"#).unwrap();
    let original_split = success(
        &a,
        &[
            "breakdown",
            converging_id,
            "--spec",
            converge_spec.to_str().unwrap(),
            "--claim-token",
            "converge-parent-token",
        ],
        "converge-child-token",
        501,
    );
    let only = &original_split["children"][0];
    let nested_spec = root.join("nested-breakdown.json");
    fs::write(&nested_spec, r#"{"operationId":"nested-split","children":[{"key":"grandchild","title":"Grandchild","description":"Two-level convergence fixture","requires":[],"claim":true}]}"#).unwrap();
    let nested = success(
        &a,
        &[
            "breakdown",
            only["taskId"].as_str().unwrap(),
            "--spec",
            nested_spec.to_str().unwrap(),
            "--claim-token",
            only["claimToken"].as_str().unwrap(),
        ],
        "nested-child-token",
        502,
    );
    let grandchild = &nested["children"][0];
    let direct = success(&a, &["dag", converging_id], "unused-token-000", 502);
    assert_eq!(direct["directChildren"].as_array().unwrap().len(), 1);
    assert_eq!(direct["directChildren"][0]["taskId"], only["taskId"]);
    assert_ne!(direct["directChildren"][0]["taskId"], grandchild["taskId"]);
    success(
        &a,
        &[
            "complete-ops",
            grandchild["taskId"].as_str().unwrap(),
            "--description",
            "done",
            "--authorization",
            "fixture",
            "--claim-token",
            grandchild["claimToken"].as_str().unwrap(),
        ],
        "unused-token-000",
        503,
    );
    let converge_child_args = [
        "converge",
        only["taskId"].as_str().unwrap(),
        "--operation-id",
        "converge-child",
    ];
    uncertain(&a, &converge_child_args, "unused-token-000", 504);
    success(&a, &converge_child_args, "unused-token-000", 504);
    success(
        &a,
        &[
            "converge",
            converging_id,
            "--operation-id",
            "converge-parent",
        ],
        "unused-token-000",
        505,
    );
    assert_eq!(
        success(
            &a,
            &[
                "breakdown",
                converging_id,
                "--spec",
                converge_spec.to_str().unwrap(),
                "--claim-token",
                "converge-parent-token"
            ],
            "other-token-0000",
            999
        ),
        original_split
    );
    let journal = ok(
        &b,
        &["ls-remote", "origin", "refs/heads/tasks/system/transitions"],
    )
    .split_whitespace()
    .next()
    .unwrap()
    .to_owned();
    assert_eq!(
        journal, historical_journal,
        "ordinary writes must not advance the historical journal ref"
    );
    let done = success(&a, &["show", child], "unused-token-000", 106);
    assert_eq!(done["state"], "done");
    let registry = a.join(".git/task-dag/native-claims");
    let entries: Vec<_> = fs::read_dir(&registry).unwrap().collect();
    assert!(
        !entries.is_empty(),
        "claiming commands must use the central registry"
    );
    for entry in entries {
        let metadata = entry.unwrap().metadata().unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(
        fs::metadata(&registry).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        ok(&b, &["config", "--get", "core.hooksPath"]),
        ".githooks",
        "native claims must retain the canonical hooksPath"
    );
    let staging = a.join(".git/task-dag/native-claim-staging");
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    assert_eq!(
        fs::metadata(staging).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for _ in 0..20 {
        if fs::remove_dir_all(&root).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!(
        "could not remove isolated integration fixture {}",
        root.display()
    );
}
