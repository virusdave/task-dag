use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static FIXTURE: AtomicUsize = AtomicUsize::new(0);

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "taskdag-install-hooks-{}-{}",
        std::process::id(),
        FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir(&root).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    root
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .args(args)
        .current_dir(root)
        .output()
        .unwrap()
}

fn install(root: &Path) -> serde_json::Value {
    let output = run(root, &["install-hooks"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn canonical() -> &'static [u8] {
    include_bytes!("../.githooks/pre-push")
}

#[test]
fn install_hooks_is_idempotent_and_repairs_mode() {
    let root = fixture();
    let first = install(&root);
    assert_eq!(
        first,
        serde_json::json!({
            "configChanged": true,
            "hookChanged": true,
            "hooksPath": ".githooks",
            "mode": "0755"
        })
    );
    let hook = root.join(".githooks/pre-push");
    assert_eq!(fs::read(&hook).unwrap(), canonical());
    assert_eq!(
        fs::metadata(&hook).unwrap().permissions().mode() & 0o777,
        0o755
    );

    assert_eq!(
        install(&root),
        serde_json::json!({
            "configChanged": false,
            "hookChanged": false,
            "hooksPath": ".githooks",
            "mode": "0755"
        })
    );
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(install(&root)["hookChanged"], true);
    assert_eq!(
        fs::metadata(&hook).unwrap().permissions().mode() & 0o777,
        0o755
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn install_hooks_preserves_equivalent_absolute_config_and_serializes_installers() {
    let root = fixture();
    let absolute = root.join(".githooks");
    fs::create_dir(&absolute).unwrap();
    fs::write(absolute.join("pre-push"), canonical()).unwrap();
    fs::set_permissions(absolute.join("pre-push"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        Command::new("git")
            .args(["config", "core.hooksPath", absolute.to_str().unwrap()])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(install(&root)["configChanged"], false);
    let configured = Command::new("git")
        .args(["config", "--local", "--get", "core.hooksPath"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(configured.stdout).unwrap().trim(),
        absolute.to_str().unwrap()
    );

    fs::remove_dir_all(&absolute).unwrap();
    assert!(
        Command::new("git")
            .args(["config", "--unset", "core.hooksPath"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let first = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .arg("install-hooks")
        .current_dir(&root)
        .spawn()
        .unwrap();
    let second = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .arg("install-hooks")
        .current_dir(&root)
        .spawn()
        .unwrap();
    assert!(first.wait_with_output().unwrap().status.success());
    assert!(second.wait_with_output().unwrap().status.success());
    assert_eq!(
        fs::read(root.join(".githooks/pre-push")).unwrap(),
        canonical()
    );
    assert_eq!(
        fs::read_dir(root.join(".githooks"))
            .unwrap()
            .filter_map(Result::ok)
            .count(),
        1
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn linked_worktree_installers_share_one_config_transaction() {
    let root = fixture();
    assert!(
        Command::new("git")
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "--allow-empty",
                "--quiet",
                "-m",
                "fixture",
            ])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let linked = root.with_extension("linked");
    let _ = fs::remove_dir_all(&linked);
    assert!(
        Command::new("git")
            .args([
                "worktree",
                "add",
                "--quiet",
                "--detach",
                linked.to_str().unwrap()
            ])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let first = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .arg("install-hooks")
        .current_dir(&root)
        .spawn()
        .unwrap();
    let second = Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .arg("install-hooks")
        .current_dir(&linked)
        .spawn()
        .unwrap();
    assert!(first.wait_with_output().unwrap().status.success());
    assert!(second.wait_with_output().unwrap().status.success());
    let configured = Command::new("git")
        .args(["config", "--local", "--get-all", "core.hooksPath"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(configured.status.success());
    assert_eq!(String::from_utf8(configured.stdout).unwrap(), ".githooks\n");
    assert_eq!(
        fs::read(root.join(".githooks/pre-push")).unwrap(),
        canonical()
    );
    assert_eq!(
        fs::read(linked.join(".githooks/pre-push")).unwrap(),
        canonical()
    );
    assert!(
        Command::new("git")
            .args(["worktree", "remove", "--force", linked.to_str().unwrap()])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn install_hooks_refuses_conflicts_without_replacing_them() {
    for kind in [
        "content",
        "hook-symlink",
        "directory-symlink",
        "custom-config",
    ] {
        let root = fixture();
        match kind {
            "content" => {
                fs::create_dir(root.join(".githooks")).unwrap();
                fs::write(root.join(".githooks/pre-push"), b"operator hook\n").unwrap();
            }
            "hook-symlink" => {
                fs::create_dir(root.join(".githooks")).unwrap();
                fs::write(root.join("target"), canonical()).unwrap();
                symlink(root.join("target"), root.join(".githooks/pre-push")).unwrap();
            }
            "directory-symlink" => {
                fs::create_dir(root.join("target-hooks")).unwrap();
                symlink(root.join("target-hooks"), root.join(".githooks")).unwrap();
            }
            "custom-config" => {
                assert!(
                    Command::new("git")
                        .args(["config", "core.hooksPath", "custom-hooks"])
                        .current_dir(&root)
                        .status()
                        .unwrap()
                        .success()
                );
            }
            _ => unreachable!(),
        }
        let before = fs::read(root.join(".githooks/pre-push")).ok();
        let output = run(&root, &["install-hooks"]);
        assert!(!output.status.success(), "{kind} unexpectedly succeeded");
        assert_eq!(fs::read(root.join(".githooks/pre-push")).ok(), before);
        if kind == "custom-config" {
            assert!(!root.join(".githooks").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn install_hooks_help_and_bare_refusal_have_no_effects() {
    let outside = std::env::temp_dir().join(format!("taskdag-install-help-{}", std::process::id()));
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir(&outside).unwrap();
    let output = run(&outside, &["install-hooks", "--help"]);
    assert!(output.status.success());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);

    let bare = outside.join("bare.git");
    assert!(
        Command::new("git")
            .args(["init", "--bare", "--quiet", bare.to_str().unwrap()])
            .status()
            .unwrap()
            .success()
    );
    let output = run(&bare, &["install-hooks"]);
    assert!(!output.status.success());
    assert!(!bare.join(".githooks").exists());

    let missing_config = fixture();
    fs::remove_file(missing_config.join(".git/config")).unwrap();
    let output = run(&missing_config, &["install-hooks"]);
    assert!(!output.status.success());
    assert!(!missing_config.join(".git/config.lock").exists());
    fs::remove_dir_all(missing_config).unwrap();
    fs::remove_dir_all(outside).unwrap();
}
