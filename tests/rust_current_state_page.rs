use serde_json::Value;
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};

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
    let output = git(cwd, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn cli(cwd: &Path, args: &[&str], token: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .current_dir(cwd)
        .args(args)
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
        .env("TASKDAG_TEST_TOKEN", token)
        .env("TASKDAG_TEST_TIME", "100")
        .env("TASKDAG_TEST_LEGACY_ACTIVATION", "1")
        .env("TASKDAG_SESSION_ID", "current-state-page-test")
        .env(
            "TASKDAG_TEST_RUNTIME_REMOTE",
            cwd.parent().unwrap().join("runtime-origin.git"),
        )
        .output()
        .unwrap()
}

fn success(cwd: &Path, args: &[&str], token: &str) -> Value {
    let output = cli(cwd, args, token);
    assert!(
        output.status.success(),
        "task-dag {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
}

fn create(work: &Path, index: usize, claim: bool) -> Value {
    let operation = format!("paged-state-{index}");
    let title = format!("Paged state {index}");
    let mut args = vec![
        "create",
        "--operation-id",
        operation.as_str(),
        "--title",
        title.as_str(),
        "--description",
        "Exercise bounded prefix traversal",
    ];
    if claim {
        args.push("--claim");
    }
    success(work, &args, &format!("page-token-value-{index:04}"))
}

#[test]
fn pages_are_complete_and_later_pages_ignore_all_prior_prefixes() {
    let root =
        std::env::temp_dir().join(format!("taskdag-current-state-page-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let origin = root.join("origin.git");
    let runtime_origin = root.join("runtime-origin.git");
    let work = root.join("work");
    let mirror = root.join("mirror.git");
    ok(&root, &["init", "--bare", origin.to_str().unwrap()]);
    ok(&root, &["init", "--bare", runtime_origin.to_str().unwrap()]);
    ok(&root, &["init", "-b", "master", work.to_str().unwrap()]);
    ok(&work, &["config", "user.name", "test"]);
    ok(&work, &["config", "user.email", "test@localhost"]);
    fs::create_dir(work.join(".githooks")).unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join(".githooks/pre-push"),
        work.join(".githooks/pre-push"),
    )
    .unwrap();
    ok(&work, &["config", "core.hooksPath", ".githooks"]);
    ok(
        &work,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let runtime = env!("TASKDAG_BUILD_COMMIT");
    let floor = ok(
        source,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-m",
            "paged reader floor",
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
    ok(&work, &["fetch", source.to_str().unwrap(), runtime]);
    success(
        &work,
        &["runtime", "publish", "--commit", runtime],
        "unused-token",
    );
    success(
        &work,
        &[
            "init",
            "--trusted-floor",
            &floor,
            "--repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--fleet-repository-id",
            "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        "unused-token",
    );

    let mut expected = BTreeSet::new();
    for index in 0..17 {
        expected.insert(
            create(&work, index, false)["taskId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let active = create(&work, 17, true);
    expected.insert(active["taskId"].as_str().unwrap().to_owned());
    let blocked = create(&work, 18, true);
    let blocked_id = blocked["taskId"].as_str().unwrap();
    success(
        &work,
        &[
            "block",
            blocked_id,
            "--claim-token",
            blocked["claimToken"].as_str().unwrap(),
            "--reason",
            "Page fixture",
            "--authorization",
            "Test fixture",
            "--operation-id",
            "paged-state-block",
        ],
        "unused-token",
    );
    expected.insert(blocked_id.to_owned());
    let waiting = create(&work, 19, true);
    let waiting_id = waiting["taskId"].as_str().unwrap();
    let spec = root.join("breakdown.json");
    fs::write(
        &spec,
        r#"{"operationId":"paged-state-split","children":[{"key":"child","title":"Paged child","description":"Child page fixture","requires":[],"claim":false}]}"#,
    )
    .unwrap();
    let split = success(
        &work,
        &[
            "breakdown",
            waiting_id,
            "--spec",
            spec.to_str().unwrap(),
            "--claim-token",
            waiting["claimToken"].as_str().unwrap(),
        ],
        "child-page-token",
    );
    expected.insert(waiting_id.to_owned());
    expected.insert(split["children"][0]["taskId"].as_str().unwrap().to_owned());

    ok(
        &root,
        &[
            "clone",
            "--mirror",
            origin.to_str().unwrap(),
            mirror.to_str().unwrap(),
        ],
    );
    let root_page = success(&mirror, &["current-state-page"], "unused-token");
    assert_eq!(root_page["kind"], "split");
    assert_eq!(root_page["children"].as_array().unwrap().len(), 16);

    let activation = root_page["activationOid"].clone();
    let mut prefixes = VecDeque::from([String::new()]);
    let mut observed = BTreeSet::new();
    while let Some(prefix) = prefixes.pop_front() {
        let page = success(
            &mirror,
            &["current-state-page", "--prefix", prefix.as_str()],
            "unused-token",
        );
        assert_eq!(page["activationOid"], activation);
        match page["kind"].as_str().unwrap() {
            "split" => prefixes.extend(
                page["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|child| child.as_str().unwrap().to_owned()),
            ),
            "leaf" => {
                assert!(page["rows"].as_array().unwrap().len() <= 16);
                observed.extend(
                    page["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| row["taskId"].as_str().unwrap().to_owned()),
                );
            }
            kind => panic!("unexpected page kind {kind}"),
        }
    }
    assert_eq!(observed, expected);

    let selected = expected
        .iter()
        .find(|id| id.as_bytes()[3] > b'0')
        .expect("fixture needs a task outside the zero prefix");
    let invalid = ok(
        &mirror,
        &[
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-m",
            "not a lifecycle record",
        ],
    );
    let mut update = Command::new("git")
        .current_dir(&mirror)
        .args(["update-ref", "--stdin"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let stdin = update.stdin.as_mut().unwrap();
        for index in 0..1_000 {
            writeln!(
                stdin,
                "create refs/heads/tasks/frontier/v2-0{index:063x} {invalid}"
            )
            .unwrap();
        }
    }
    assert!(update.wait().unwrap().success());
    let loose = cli(
        &mirror,
        &["current-state-page", "--prefix", &selected[3..]],
        "unused-token",
    );
    assert!(!loose.status.success());
    assert!(String::from_utf8_lossy(&loose.stderr).contains("requires a packed mirror"));
    ok(&mirror, &["pack-refs", "--all", "--prune"]);
    let isolated = success(
        &mirror,
        &["current-state-page", "--prefix", &selected[3..]],
        "unused-token",
    );
    assert_eq!(isolated["kind"], "leaf");
    assert_eq!(isolated["rows"].as_array().unwrap().len(), 1);
    assert_eq!(isolated["rows"][0]["taskId"], selected.as_str());

    let duplicate_done = format!("refs/heads/tasks/done/{selected}");
    ok(&mirror, &["update-ref", &duplicate_done, &invalid]);
    ok(&mirror, &["pack-refs", "--all", "--prune"]);
    let duplicate = cli(
        &mirror,
        &["current-state-page", "--prefix", &selected[3..]],
        "unused-token",
    );
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("multiple lifecycle states"));

    fs::remove_dir_all(root).unwrap();
}
