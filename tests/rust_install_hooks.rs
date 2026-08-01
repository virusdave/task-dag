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

fn legacy() -> &'static [u8] {
    include_bytes!("../assets/pre-push-v1-legacy")
}

fn assert_no_migration_temps(hooks: &Path) {
    assert!(
        fs::read_dir(hooks)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".pre-push.migrate."))
    );
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
fn explicit_migration_preserves_custom_hook_and_is_idempotent() {
    let root = fixture();
    let hooks = root.join(".githooks");
    fs::create_dir(&hooks).unwrap();
    let custom = b"#!/bin/sh\ncat > repository-input\ntest \"$1\" = origin && test \"$2\" = url\n";
    fs::write(hooks.join("pre-push"), custom).unwrap();
    fs::set_permissions(hooks.join("pre-push"), fs::Permissions::from_mode(0o755)).unwrap();

    let default = run(&root, &["install-hooks"]);
    assert!(!default.status.success());
    let migrated = run(&root, &["install-hooks", "--migrate-existing-pre-push"]);
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    assert_eq!(fs::read(hooks.join("pre-push")).unwrap(), canonical());
    assert_eq!(fs::read(hooks.join("pre-push.repository")).unwrap(), custom);
    assert!(
        run(&root, &["install-hooks", "--migrate-existing-pre-push"])
            .status
            .success()
    );
    assert_eq!(fs::read(hooks.join("pre-push.repository")).unwrap(), custom);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn migration_rejects_bad_mode_and_legacy_primary() {
    for (contents, mode) in [
        (b"#!/bin/sh\nexit 0\n".as_slice(), 0o744),
        (
            include_bytes!("../assets/pre-push-v1-legacy").as_slice(),
            0o755,
        ),
    ] {
        let root = fixture();
        fs::create_dir(root.join(".githooks")).unwrap();
        fs::write(root.join(".githooks/pre-push"), contents).unwrap();
        fs::set_permissions(
            root.join(".githooks/pre-push"),
            fs::Permissions::from_mode(mode),
        )
        .unwrap();
        assert!(
            !run(&root, &["install-hooks", "--migrate-existing-pre-push"])
                .status
                .success()
        );
        assert!(!root.join(".githooks/pre-push.repository").exists());
        assert_no_migration_temps(&root.join(".githooks"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn verification_accepts_only_pinned_legacy_without_secondary() {
    for (primary, secondary, accepted) in [
        (legacy(), None, true),
        (legacy(), Some(b"#!/bin/sh\nexit 0\n".as_slice()), false),
        (b"#!/bin/sh\nexit 0\n".as_slice(), None, false),
    ] {
        let root = fixture();
        let hooks = root.join(".githooks");
        fs::create_dir(&hooks).unwrap();
        fs::write(hooks.join("pre-push"), primary).unwrap();
        fs::set_permissions(hooks.join("pre-push"), fs::Permissions::from_mode(0o755)).unwrap();
        if let Some(contents) = secondary {
            fs::write(hooks.join("pre-push.repository"), contents).unwrap();
            fs::set_permissions(
                hooks.join("pre-push.repository"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let output = run(&root, &["install-hooks"]);
        assert_eq!(
            output.status.success(),
            accepted,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(hooks.join("pre-push")).unwrap(), primary);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn migration_refuses_different_secondary_but_completes_same_inode_retry() {
    for same_inode in [false, true] {
        let root = fixture();
        let hooks = root.join(".githooks");
        fs::create_dir(&hooks).unwrap();
        let primary = hooks.join("pre-push");
        let secondary = hooks.join("pre-push.repository");
        let custom = b"#!/bin/sh\nexit 0\n";
        fs::write(&primary, custom).unwrap();
        fs::set_permissions(&primary, fs::Permissions::from_mode(0o755)).unwrap();
        if same_inode {
            fs::hard_link(&primary, &secondary).unwrap();
        } else {
            fs::write(&secondary, b"#!/bin/sh\nexit 3\n").unwrap();
            fs::set_permissions(&secondary, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let secondary_before = fs::read(&secondary).unwrap();
        let output = run(&root, &["install-hooks", "--migrate-existing-pre-push"]);
        assert_eq!(
            output.status.success(),
            same_inode,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&secondary).unwrap(), secondary_before);
        assert_eq!(
            fs::read(&primary).unwrap(),
            if same_inode { canonical() } else { custom }
        );
        assert_no_migration_temps(&hooks);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn migration_fails_closed_for_unsafe_secondary_types_and_modes() {
    for kind in ["mode", "symlink", "directory"] {
        let root = fixture();
        let hooks = root.join(".githooks");
        fs::create_dir(&hooks).unwrap();
        fs::write(hooks.join("pre-push"), b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(hooks.join("pre-push"), fs::Permissions::from_mode(0o755)).unwrap();
        let secondary = hooks.join("pre-push.repository");
        match kind {
            "mode" => {
                fs::write(&secondary, b"#!/bin/sh\nexit 0\n").unwrap();
                fs::set_permissions(&secondary, fs::Permissions::from_mode(0o775)).unwrap();
            }
            "symlink" => symlink("pre-push", &secondary).unwrap(),
            "directory" => fs::create_dir(&secondary).unwrap(),
            _ => unreachable!(),
        }
        assert!(
            !run(&root, &["install-hooks", "--migrate-existing-pre-push"])
                .status
                .success()
        );
        assert_eq!(
            fs::read(hooks.join("pre-push")).unwrap(),
            b"#!/bin/sh\nexit 0\n"
        );
        assert_no_migration_temps(&hooks);
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
