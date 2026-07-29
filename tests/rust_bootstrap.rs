use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn git(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
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
fn bare_origin_claims_breakdown_journal_and_ops_atomicity() {
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
    }
    ok(&a, &["fetch", source.to_str().unwrap(), runtime]);
    success(
        &a,
        &["runtime", "publish", "--commit", runtime],
        "unused-token-000",
        100,
    );

    uncertain(
        &a,
        &["init", "--trusted-floor", &floor],
        "unused-token-000",
        100,
    );
    success(
        &a,
        &["init", "--trusted-floor", &floor],
        "unused-token-000",
        100,
    );
    let activation_lease = success(&a, &["activation"], "unused-token-000", 100)["activationOid"]
        .as_str()
        .unwrap()
        .to_owned();
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
    let intervening_completion = ok(
        &a,
        &[
            "commit-tree",
            empty_tree,
            "-p",
            runtime,
            "-p",
            &floor,
            "-m",
            "intervening completion merge",
        ],
    );
    let candidate_one = ok(
        &a,
        &[
            "commit-tree",
            empty_tree,
            "-p",
            &intervening_completion,
            "-m",
            "runtime one",
        ],
    );
    success(
        &a,
        &["runtime", "publish", "--commit", &candidate_one],
        "unused-token-000",
        100,
    );
    let activation_one_args = [
        "activate-runtime",
        "--commit",
        &candidate_one,
        "--activation-lease",
        &activation_lease,
        "--operation-id",
        "activation-one",
    ];
    uncertain(&a, &activation_one_args, "unused-token-000", 100);
    let first_activation = success(&a, &activation_one_args, "unused-token-000", 100);
    let successor_lease = ok(
        &a,
        &["ls-remote", "origin", "refs/heads/tasks/v2/activation"],
    )
    .split_whitespace()
    .next()
    .unwrap()
    .to_owned();
    let candidate_two = ok(
        &a,
        &[
            "commit-tree",
            empty_tree,
            "-p",
            runtime,
            "-m",
            "runtime two",
        ],
    );
    success(
        &a,
        &["runtime", "publish", "--commit", &candidate_two],
        "unused-token-000",
        100,
    );
    success(
        &a,
        &[
            "activate-runtime",
            "--commit",
            &candidate_two,
            "--activation-lease",
            &successor_lease,
            "--operation-id",
            "activation-two",
        ],
        "unused-token-000",
        100,
    );
    let identity_lease = ok(
        &a,
        &["ls-remote", "origin", "refs/heads/tasks/v2/activation"],
    )
    .split_whitespace()
    .next()
    .unwrap()
    .to_owned();
    success(
        &a,
        &[
            "activate-runtime",
            "--commit",
            runtime,
            "--activation-lease",
            &identity_lease,
            "--operation-id",
            "activation-identity",
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
    let inherit_lease = identity["activationOid"].as_str().unwrap();
    let inherit_args = [
        "activate-runtime",
        "--commit",
        runtime,
        "--activation-lease",
        inherit_lease,
        "--operation-id",
        "activation-inherit-identity",
    ];
    uncertain(&a, &inherit_args, "unused-token-000", 100);
    success(&a, &inherit_args, "unused-token-000", 100);
    let inherited = success(&a, &["activation"], "unused-token-000", 100);
    assert_eq!(
        inherited["record"]["repositoryId"],
        identity["record"]["repositoryId"]
    );
    assert_eq!(
        inherited["record"]["fleetDigest"],
        identity["record"]["fleetDigest"]
    );
    let delegated_source = success(
        &a,
        &[
            "create",
            "--operation-id",
            "delegated-source",
            "--title",
            "Delegated source",
            "--description",
            "source task",
            "--claim",
        ],
        "delegated-source-token",
        100,
    );
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
        "target task",
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
    assert_eq!(
        success(
            &target,
            &["show", admitted["taskId"].as_str().unwrap()],
            "unused-token-000",
            100,
        )["state"],
        "frontier"
    );
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
    assert_eq!(
        success(
            &a,
            &[
                "activate-runtime",
                "--commit",
                &candidate_one,
                "--activation-lease",
                &activation_lease,
                "--operation-id",
                "activation-one"
            ],
            "unused-token-000",
            999
        ),
        first_activation
    );
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
        "Root task",
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
        "Root task",
        "--claim",
    ];
    assert_eq!(
        cli(&a, &canonical_create_args, "other-token-000", 100).stdout,
        created_raw.stdout
    );
    let id = created["taskId"].as_str().unwrap();
    assert_eq!(created["claimToken"], "parent-token-000");
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
    fs::write(&spec, r#"{"operationId":"split","children":[{"key":"a","title":"A","description":"A","requires":[],"claim":true},{"key":"b","title":"B","description":"B","requires":[],"claim":true},{"key":"c","title":"C","description":"C","requires":["a"],"claim":false}]}"#).unwrap();
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

    let master_before = ok(&a, &["ls-remote", "origin", "refs/heads/master"])
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    let child = children[0]["taskId"].as_str().unwrap();
    let complete_ops_args = [
        "complete-ops",
        child,
        "--description",
        "verified",
        "--authorization",
        "fixture",
        "--evidence",
        "evidence-1",
        "--claim-token",
        child_token,
    ];
    uncertain(&b, &complete_ops_args, "unused-token-000", 103);
    success(&b, &complete_ops_args, "unused-token-000", 103);
    let second = children[1]["taskId"].as_str().unwrap();
    let second_token = children[1]["claimToken"].as_str().unwrap();
    success(
        &a,
        &[
            "complete-ops",
            second,
            "--description",
            "second",
            "--authorization",
            "fixture",
            "--claim-token",
            second_token,
        ],
        "unused-token-000",
        104,
    );
    success(
        &b,
        &[
            "complete-ops",
            child,
            "--description",
            "verified",
            "--authorization",
            "fixture",
            "--evidence",
            "evidence-1",
            "--claim-token",
            child_token,
        ],
        "unused-token-000",
        105,
    );
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
    ok(&b, &["fetch", "origin", &journal]);
    let parents = ok(&b, &["show", "-s", "--format=%P", &journal]);
    assert!(
        parents.split_whitespace().count() >= 2,
        "journal predecessor must precede sorted semantic outputs"
    );
    let done = success(&a, &["show", child], "unused-token-000", 106);
    assert_eq!(done["state"], "done");
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
