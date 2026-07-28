use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn git(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
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
        .env("TASKDAG_SESSION_ID", "integration-session")
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
        .env("TASKDAG_SESSION_ID", "integration-session")
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
    ok(&root, &["init", "--bare", origin.to_str().unwrap()]);
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let runtime = env!("TASKDAG_BUILD_COMMIT");
    let floor = ok(source, &["rev-parse", &format!("{runtime}^")]);
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
    let activation_lease = ok(
        &a,
        &["ls-remote", "origin", "refs/heads/tasks/v2/activation"],
    )
    .split_whitespace()
    .next()
    .unwrap()
    .to_owned();
    let empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let candidate_one = ok(
        &a,
        &["commit-tree", empty_tree, "-p", &floor, "-m", "runtime one"],
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
        &["commit-tree", empty_tree, "-p", &floor, "-m", "runtime two"],
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
    let created = success(
        &a,
        &[
            "create",
            "--operation-id",
            "root-op",
            "--title",
            "Root",
            "--description",
            "Root task",
            "--claim",
        ],
        "parent-token-000",
        100,
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
        "breakdown",
        id,
        "--spec",
        spec.to_str().unwrap(),
        "--claim-token",
        "parent-token-000",
    ];
    uncertain(&a, &breakdown_args, "child-token-0000", 102);
    let split = success(&a, &breakdown_args, "child-token-0000", 102);
    let children = split["children"].as_array().unwrap();
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
