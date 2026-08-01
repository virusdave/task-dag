use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    if Path::new(".git").exists() {
        emit_git_reruns();
    }
    for path in [
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
        "src",
        ".githooks/pre-push",
        "assets/pre-push-v1-legacy",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=TASKDAG_TEST_COMPILED_COMMIT");
    let test_seam = env::var_os("CARGO_FEATURE_TEST_SEAM").is_some();
    let commit = if test_seam {
        env::var("TASKDAG_TEST_COMPILED_COMMIT")
            .expect("test-seam requires TASKDAG_TEST_COMPILED_COMMIT at compile time")
    } else if Path::new(".git").exists() {
        let status = git(&[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            "Cargo.toml",
            "Cargo.lock",
            "build.rs",
            "src",
            ".githooks/pre-push",
            "assets/pre-push-v1-legacy",
        ]);
        assert!(
            status.trim().is_empty(),
            "default build refuses Rust/Cargo/build inputs that differ from embedded HEAD:\n{status}"
        );
        git(&["rev-parse", "HEAD"]).trim().to_owned()
    } else {
        fs::read_to_string(".taskdag-build-revision")
            .expect("Nix source build requires generated .taskdag-build-revision")
            .trim()
            .to_owned()
    };
    assert!(
        commit.len() == 40
            && commit
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "compiled identity must be a lowercase full Git OID"
    );
    println!("cargo:rustc-env=TASKDAG_BUILD_COMMIT={commit}");
}

fn emit_git_reruns() {
    let git_dir = git(&["rev-parse", "--absolute-git-dir"]);
    let git_dir = PathBuf::from(git_dir.trim());
    let head = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head.display());
    if let Ok(contents) = fs::read_to_string(&head)
        && let Some(symbolic) = contents.trim().strip_prefix("ref: ")
    {
        let branch = git(&["rev-parse", "--git-path", symbolic]);
        let branch = PathBuf::from(branch.trim());
        let branch = if branch.is_absolute() {
            branch
        } else {
            env::current_dir().unwrap().join(branch)
        };
        println!("cargo:rerun-if-changed={}", branch.display());
    }
    for relative in ["logs/HEAD", "packed-refs"] {
        let path = git_dir.join(relative);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn git(args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .output()
        .expect("git is required at build time");
    assert!(
        out.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("git output must be UTF-8")
}
