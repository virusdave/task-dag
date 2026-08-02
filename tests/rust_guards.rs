use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

use serde_json::json;
use sha2::{Digest, Sha256};

static NEXT_REPO: AtomicUsize = AtomicUsize::new(0);

fn run(cwd: &Path, args: &[&str], input: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn git(cwd: &Path, args: &[&str], input: &str) -> String {
    let mut child = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    root: std::path::PathBuf,
    work: std::path::PathBuf,
    id: String,
    token: String,
    task_oid: String,
}

impl Fixture {
    fn new() -> Self {
        let serial = NEXT_REPO.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("taskdag-guard-{}-{serial}", std::process::id()));
        let work = root.join("work");
        let remote = root.join("remote.git");
        fs::create_dir_all(&root).unwrap();
        git(
            &root,
            &["init", "--bare", "-q", remote.to_str().unwrap()],
            "",
        );
        fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q"], "");
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
            "",
        );
        let tree = git(&work, &["mktree"], "");
        let task_oid = git(&work, &["commit-tree", &tree], "task\n");
        Self {
            root,
            work,
            id: format!("v2-{}", "a".repeat(64)),
            token: "claim-token".into(),
            task_oid,
        }
    }

    fn registry(&self, token: &str) -> std::path::PathBuf {
        let directory = self.work.join(".git/task-dag/native-claims");
        fs::create_dir_all(&directory).unwrap();
        let digest = format!("{:x}", Sha256::digest(token.as_bytes()));
        let path = directory.join(format!("{}.{}", self.id, digest));
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "taskId": self.id, "owner": "owner", "host": "host",
                "sessionId": "session", "claimToken": token
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    fn active(&self, token: &str, extra_body: usize) {
        let tree = git(&self.work, &["mktree"], "");
        let mut message = serde_json::to_string(&json!({
            "attemptId": "b".repeat(64), "claimToken": token, "claimedAt": 1,
            "expiresAt": 2, "formatVersion": 2, "host": "host",
            "logicalId": "c".repeat(64), "owner": "owner", "sessionId": "session",
            "taskId": self.id, "taskOid": self.task_oid
        }))
        .unwrap();
        message.push_str(&" ".repeat(extra_body));
        let commit = git(&self.work, &["commit-tree", &tree], &message);
        git(
            &self.work,
            &[
                "push",
                "-q",
                "origin",
                &format!("{commit}:refs/heads/tasks/active/{}", self.id),
            ],
            "",
        );
    }

    fn guard(&self) -> std::process::Output {
        let oid = "d".repeat(40);
        let zero = "0".repeat(40);
        let updates = format!("refs/heads/master {oid} refs/heads/master {zero}\n");
        run(
            &self.work,
            &["guard-pre-push", "origin", "unused"],
            &updates,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn commit_guard_enforces_canon_and_v2_boundaries() {
    let root = std::env::temp_dir().join(format!("taskdag-guards-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    assert!(
        run(
            &root,
            &["guard-commit-message", "--stdin"],
            "Add native guards\n\nPrevent unsafe pushes.\n"
        )
        .status
        .success()
    );
    git(&root, &["init", "-q"], "");
    git(&root, &["config", "core.commentChar", "ab"], "");
    assert!(
        !run(
            &root,
            &["guard-commit-message", "--stdin"],
            "\n# template\nfeat: rejected\n"
        )
        .status
        .success()
    );
    git(&root, &["config", "core.commentChar", ";"], "");
    assert!(
        !run(
            &root,
            &["guard-commit-message", "--stdin"],
            "\n; template\nfeat: rejected\n"
        )
        .status
        .success()
    );
    assert!(
        !run(
            &root,
            &["guard-commit-message", "--stdin"],
            "feat(cli): add guards\n"
        )
        .status
        .success()
    );
    assert!(
        !run(
            &root,
            &["guard-commit-message", "--stdin"],
            "{\"formatVersion\":2,\"taskId\":\"v2-x\"}\n"
        )
        .status
        .success()
    );
    assert!(
        !run(
            &root,
            &["guard-commit-message", "--stdin"],
            "Add a ref\n\nrefs/heads/tasks/active/v2-x\n"
        )
        .status
        .success()
    );
    assert!(
        run(&root, &["guard-commit-message", "--help"], "")
            .status
            .success()
    );
    assert!(
        run(&root, &["guard-pre-push", "--help"], "")
            .status
            .success()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn matching_registry_and_remote_active_reject_raw_master() {
    let fixture = Fixture::new();
    fixture.registry(&fixture.token);
    fixture.active(&fixture.token, 0);
    assert!(!fixture.guard().status.success());
}

#[test]
fn absent_or_stale_remote_active_removes_only_registry_entry() {
    let fixture = Fixture::new();
    let entry = fixture.registry(&fixture.token);
    let sentinel = fixture.work.join(".git/task-dag/sentinel");
    fs::write(&sentinel, "keep").unwrap();
    assert!(fixture.guard().status.success());
    assert!(!entry.exists());
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "keep");

    let entry = fixture.registry(&fixture.token);
    fixture.active("different-token", 0);
    assert!(fixture.guard().status.success());
    assert!(!entry.exists());
}

#[test]
fn malformed_registry_and_remote_objects_fail_closed() {
    let fixture = Fixture::new();
    let entry = fixture.registry(&fixture.token);
    fs::write(&entry, b"not json").unwrap();
    assert!(!fixture.guard().status.success());

    fs::remove_file(entry).unwrap();
    fixture.registry(&fixture.token);
    fixture.active(&fixture.token, 9_000);
    assert!(!fixture.guard().status.success());
}

#[test]
fn in_flight_registry_lock_fails_closed_without_removing_entry() {
    let fixture = Fixture::new();
    let entry = fixture.registry(&fixture.token);
    let lock_path = fixture.work.join(".git/task-dag/native-claims.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .unwrap();
    lock.lock().unwrap();
    assert!(!fixture.guard().status.success());
    assert!(entry.exists());
}

#[test]
fn oversized_message_file_and_registry_entry_fail_closed() {
    let fixture = Fixture::new();
    let message = fixture.root.join("message");
    fs::write(&message, vec![b'a'; 262_145]).unwrap();
    assert!(
        !run(
            &fixture.work,
            &["guard-commit-message", message.to_str().unwrap()],
            ""
        )
        .status
        .success()
    );

    let entry = fixture.registry(&fixture.token);
    let file = File::options().write(true).open(&entry).unwrap();
    file.set_len(4097).unwrap();
    assert!(!fixture.guard().status.success());
    assert!(entry.exists());
}

#[test]
fn pre_push_only_inspects_raw_origin_master_protocol() {
    let root = std::env::temp_dir().join(format!("taskdag-pre-push-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    assert!(
        Command::new("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success()
    );
    let oid = "a".repeat(40);
    let zero = "0".repeat(40);
    assert!(
        run(
            &root,
            &["guard-pre-push", "upstream", "unused"],
            &format!("refs/heads/master {oid} refs/heads/master {zero}\n")
        )
        .status
        .success()
    );
    assert!(
        run(
            &root,
            &["guard-pre-push", "origin", "unused"],
            &format!("refs/heads/topic {oid} refs/heads/topic {zero}\n")
        )
        .status
        .success()
    );
    assert!(
        run(
            &root,
            &["guard-pre-push", "origin", "unused"],
            &format!("HEAD {oid} refs/heads/master {zero}\n")
        )
        .status
        .success()
    );
    for malformed in [
        format!("(unknown) {zero} refs/heads/topic {oid}\n"),
        format!("(unknown) {oid} refs/heads/topic {zero}\n"),
        format!("{} {oid} refs/heads/topic {zero}\n", "b".repeat(40)),
        format!("(other) {oid} refs/heads/topic {zero}\n"),
        format!("head {oid} refs/heads/master {zero}\n"),
        format!("(delete) {oid} refs/heads/topic {zero}\n"),
    ] {
        assert!(
            !run(&root, &["guard-pre-push", "origin", "unused"], &malformed)
                .status
                .success()
        );
    }
    assert!(
        !run(
            &root,
            &["guard-pre-push", "origin", "unused"],
            "malformed\n"
        )
        .status
        .success()
    );
    assert!(
        !run(
            &root,
            &["guard-pre-push", "origin", "unused"],
            &format!("refs/heads/master {zero} refs/heads/master {oid}\n")
        )
        .status
        .success()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn canonical_hook_accepts_actual_symbolic_head_master_push() {
    let root =
        std::env::temp_dir().join(format!("taskdag-symbolic-head-push-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let work = root.join("work");
    let remote = root.join("remote.git");
    fs::create_dir_all(&work).unwrap();
    git(
        &root,
        &["init", "--bare", "--quiet", remote.to_str().unwrap()],
        "",
    );
    git(&work, &["init", "--quiet"], "");
    git(
        &work,
        &["remote", "add", "origin", remote.to_str().unwrap()],
        "",
    );
    git(&work, &["config", "user.name", "test"], "");
    git(&work, &["config", "user.email", "test@localhost"], "");
    git(
        &work,
        &["commit", "--allow-empty", "--quiet", "-m", "fixture"],
        "",
    );
    let hooks = work.join(".githooks");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-push");
    fs::write(&hook, include_bytes!("../.githooks/pre-push")).unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    git(&work, &["config", "core.hooksPath", ".githooks"], "");

    let output = Command::new("git")
        .current_dir(&work)
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
        .args(["push", "origin", "HEAD:master"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/master"], ""),
        git(&work, &["rev-parse", "HEAD"], "")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn guard_chains_repository_hook_with_identical_arguments_and_input() {
    let root = std::env::temp_dir().join(format!("taskdag-guard-chain-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir(&root).unwrap();
    fs::create_dir_all(root.join(".githooks")).unwrap();
    fs::write(
        root.join(".githooks/pre-push.repository"),
        "#!/bin/sh\nprintf '%s\\n%s\\n' \"$1\" \"$2\" > chained-args\ncat > chained-input\n",
    )
    .unwrap();
    fs::set_permissions(
        root.join(".githooks/pre-push.repository"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let oid = "a".repeat(40);
    let zero = "0".repeat(40);
    let input = format!("HEAD {oid} refs/heads/topic {zero}\n");
    let output = run(&root, &["guard-pre-push", "upstream", "remote-url"], &input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(root.join("chained-args")).unwrap(),
        "upstream\nremote-url\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("chained-input")).unwrap(),
        input
    );
    fs::write(
        root.join(".githooks/pre-push.repository"),
        "#!/bin/sh\nexit 9\n",
    )
    .unwrap();
    assert!(
        !run(&root, &["guard-pre-push", "upstream", "remote-url"], &input)
            .status
            .success()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn guard_accepts_successful_repository_hook_that_closes_stdin() {
    let root =
        std::env::temp_dir().join(format!("taskdag-guard-closed-stdin-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".githooks")).unwrap();
    let hook = root.join(".githooks/pre-push.repository");
    fs::write(&hook, "#!/bin/sh\nexec 0<&-\nexit 0\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let input = "x".repeat(262_144);
    let output = run(&root, &["guard-pre-push", "upstream", "unused"], &input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn canonical_wrapper_fallback_chains_and_validates_repository_hook() {
    let root =
        std::env::temp_dir().join(format!("taskdag-wrapper-fallback-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".githooks")).unwrap();
    fs::write(
        root.join(".githooks/pre-push"),
        include_bytes!("../.githooks/pre-push"),
    )
    .unwrap();
    fs::set_permissions(
        root.join(".githooks/pre-push"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let repository_hook = root.join(".githooks/pre-push.repository");
    fs::write(
        &repository_hook,
        "#!/bin/sh\nprintf '%s\\n%s\\n' \"$1\" \"$2\" > wrapper-args\ncat > wrapper-input\n",
    )
    .unwrap();
    fs::set_permissions(&repository_hook, fs::Permissions::from_mode(0o755)).unwrap();
    let input = b"refs/heads/topic deadbeef refs/heads/topic 00000000\n\xff";
    let fallback_path = root.join("fallback-bin");
    fs::create_dir(&fallback_path).unwrap();
    for tool in ["bash", "cat", "dirname", "stat"] {
        std::os::unix::fs::symlink(
            Path::new("/run/current-system/sw/bin").join(tool),
            fallback_path.join(tool),
        )
        .unwrap();
    }

    for old_cli in [false, true] {
        let mut command = Command::new(root.join(".githooks/pre-push"));
        command
            .current_dir(&root)
            .args(["remote name", "ssh://example/repo with space"])
            .env("PATH", &fallback_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let old = root.join("old-task-dag");
        if old_cli {
            fs::write(&old, "#!/bin/sh\nexit 2\n").unwrap();
            fs::set_permissions(&old, fs::Permissions::from_mode(0o755)).unwrap();
            command.env("TASK_DAG_BIN", &old);
        } else {
            command.env_remove("TASK_DAG_BIN");
        }
        let mut child = command.spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(root.join("wrapper-args")).unwrap(),
            b"remote name\nssh://example/repo with space\n"
        );
        assert_eq!(fs::read(root.join("wrapper-input")).unwrap(), input);
    }

    for kind in ["mode", "symlink", "directory"] {
        let _ = fs::remove_file(&repository_hook);
        let _ = fs::remove_dir_all(&repository_hook);
        match kind {
            "mode" => {
                fs::write(&repository_hook, "#!/bin/sh\nexit 0\n").unwrap();
                fs::set_permissions(&repository_hook, fs::Permissions::from_mode(0o775)).unwrap();
            }
            "symlink" => std::os::unix::fs::symlink("pre-push", &repository_hook).unwrap(),
            "directory" => fs::create_dir(&repository_hook).unwrap(),
            _ => unreachable!(),
        }
        let output = Command::new(root.join(".githooks/pre-push"))
            .current_dir(&root)
            .env_remove("TASK_DAG_BIN")
            .env("PATH", &fallback_path)
            .args(["origin", "url"])
            .output()
            .unwrap();
        assert!(!output.status.success(), "{kind} unexpectedly succeeded");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn guard_git_subprocess_output_is_bounded() {
    let root = std::env::temp_dir().join(format!("taskdag-fake-git-{}", std::process::id()));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let fake_git = bin.join("git");
    fs::write(
        &fake_git,
        "#!/bin/sh\nhead -c 300000 /dev/zero | tr '\\0' x\nhead -c 300000 /dev/zero | tr '\\0' y >&2\n",
    )
    .unwrap();
    fs::set_permissions(&fake_git, fs::Permissions::from_mode(0o755)).unwrap();
    let oid = "a".repeat(40);
    let zero = "0".repeat(40);
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .current_dir(&root)
        .env("PATH", path)
        .args(["guard-pre-push", "origin", "unused"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    write!(
        child.stdin.as_mut().unwrap(),
        "refs/heads/master {oid} refs/heads/master {zero}\n"
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.len() < 32_768);
    fs::remove_dir_all(root).unwrap();
}
