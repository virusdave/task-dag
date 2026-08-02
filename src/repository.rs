use crate::{
    Result, git,
    model::{self, ACTIVATION, Update},
    runtime,
};
use rustix::fs::{AtFlags, Mode, OFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Command,
    process::Stdio,
    thread,
};

const CURRENT_ADVERTISEMENT_LINES: usize = 502;
const CURRENT_ADVERTISEMENT_BYTES: usize = 512 * 1024;
const MAX_INSPECTION_OBJECT_BYTES: usize = 256 * 1024;
const MAX_INSPECTION_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const CANONICAL_PRE_PUSH_HOOK: &[u8] = include_bytes!("../.githooks/pre-push");
// Remove after every cohort has migrated beyond the immediately preceding wrapper.
const LEGACY_PRE_PUSH_HOOK_V1: &[u8] = include_bytes!("../assets/pre-push-v1-legacy");

thread_local! {
    static INSPECTION: RefCell<(BTreeSet<String>, usize)> = const { RefCell::new((BTreeSet::new(), 0)) };
}

pub(crate) fn start_local_inspection() {
    INSPECTION.with(|inspection| *inspection.borrow_mut() = (BTreeSet::new(), 0));
}

#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) refs: BTreeMap<String, String>,
}

pub(crate) fn lifecycle_patterns(id: &str) -> Vec<String> {
    ["frontier", "active", "blocked", "waiting", "done"]
        .map(|state| model::state_ref(state, id))
        .into()
}

pub(crate) fn task_snapshot(id: &str, mut extras: Vec<String>) -> Result<Snapshot> {
    extras.extend(lifecycle_patterns(id));
    checked_snapshot(extras)
}

pub(crate) fn advertise(patterns: &[String]) -> Result<Snapshot> {
    advertise_remote("origin", patterns)
}

/// Advertise only the five native-v2 lifecycle namespaces and activation.
/// This parser deliberately does not call `git check-ref-format`: the
/// accepted grammar below is finite and stricter.
pub(crate) fn advertise_current_state() -> Result<Snapshot> {
    let patterns = [
        "refs/heads/tasks/frontier/v2-*",
        "refs/heads/tasks/active/v2-*",
        "refs/heads/tasks/blocked/v2-*",
        "refs/heads/tasks/waiting/v2-*",
        "refs/heads/tasks/done/v2-*",
        ACTIVATION,
    ];
    let mut child = Command::new("git")
        .args(["ls-remote", "--refs", "--", "origin"])
        .args(patterns)
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("run bounded current-state advertisement: {e}"))?;
    let stdout = child.stdout.take().ok_or("open advertisement stdout")?;
    let mut refs = BTreeMap::new();
    let mut bytes = 0usize;
    let mut lines = 0usize;
    for line in BufReader::new(stdout).split(b'\n') {
        let line = line.map_err(|e| format!("read advertisement: {e}"))?;
        if line.is_empty() {
            continue;
        }
        lines += 1;
        bytes = bytes
            .checked_add(line.len() + 1)
            .ok_or("advertisement byte overflow")?;
        if lines > CURRENT_ADVERTISEMENT_LINES || bytes > CURRENT_ADVERTISEMENT_BYTES {
            return Err("current-state advertisement exceeds hard limit".into());
        }
        let text = std::str::from_utf8(&line).map_err(|_| "advertisement is not UTF-8")?;
        let (oid, reference) = text
            .split_once('\t')
            .ok_or_else(|| format!("malformed current-state advertisement line: {text}"))?;
        model::oid(oid)?;
        let valid = reference == ACTIVATION
            || ["frontier", "active", "blocked", "waiting", "done"]
                .iter()
                .any(|state| {
                    model::parse_state_ref(reference, state)
                        .is_some_and(|id| model::valid_id(id).is_ok())
                });
        if !valid {
            return Err(format!(
                "current-state advertisement returned malformed or out-of-scope ref {reference}"
            ));
        }
        if refs.insert(reference.into(), oid.into()).is_some() {
            return Err(format!(
                "current-state advertisement returned duplicate ref {reference}"
            ));
        }
    }
    let status = child
        .wait()
        .map_err(|e| format!("wait for advertisement: {e}"))?;
    if !status.success() {
        return Err(format!("current-state advertisement exited with {status}"));
    }
    Ok(Snapshot { refs })
}

fn valid_exact_ref(reference: &str) -> bool {
    Command::new("git")
        .args(["check-ref-format", reference])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn valid_scope(pattern: &str) -> bool {
    if !pattern.starts_with("refs/") || matches!(pattern, "refs/*" | "refs/heads/*" | "refs/tags/*")
    {
        return false;
    }
    let metacharacters = pattern
        .bytes()
        .filter(|byte| matches!(byte, b'*' | b'?' | b'[' | b']'))
        .count();
    let shape = pattern == "refs/heads/tasks/frontier/v2-*"
        || metacharacters == 0
        || (metacharacters == 1
            && pattern.ends_with("/*")
            && (pattern
                .strip_prefix("refs/heads/tasks/")
                .and_then(|rest| rest.strip_suffix("/*"))
                .is_some_and(|scope| !scope.is_empty())
                || pattern == "refs/heads/gh/issues/*"));
    let check = if metacharacters == 0 {
        pattern.to_owned()
    } else {
        pattern.replace('*', "scope")
    };
    shape && valid_exact_ref(&check)
}

fn in_scope(reference: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        pattern
            .strip_suffix('*')
            .map_or(reference == pattern, |prefix| reference.starts_with(prefix))
    })
}

pub(crate) fn advertise_remote(remote: &str, patterns: &[String]) -> Result<Snapshot> {
    advertise_remote_bounded(remote, patterns, usize::MAX, usize::MAX)
}

pub(crate) fn advertise_bounded(
    patterns: &[String],
    line_limit: usize,
    byte_limit: usize,
) -> Result<Snapshot> {
    advertise_remote_bounded("origin", patterns, line_limit, byte_limit)
}

fn parse_advertisement<R: BufRead>(
    reader: R,
    patterns: &[String],
    line_limit: usize,
    byte_limit: usize,
) -> Result<BTreeMap<String, String>> {
    let mut refs = BTreeMap::new();
    let mut bytes = 0usize;
    let mut lines = 0usize;
    for raw in reader.split(b'\n') {
        let raw = raw.map_err(|e| format!("read ls-remote: {e}"))?;
        if raw.is_empty() {
            continue;
        }
        lines = lines.checked_add(1).ok_or("advertisement line overflow")?;
        bytes = bytes
            .checked_add(raw.len() + 1)
            .ok_or("advertisement byte overflow")?;
        if lines > line_limit || bytes > byte_limit {
            return Err("scoped advertisement exceeds hard limit".into());
        }
        let line = std::str::from_utf8(&raw).map_err(|_| "ls-remote output is not UTF-8")?;
        let (o, r) = line
            .split_once('\t')
            .ok_or_else(|| format!("malformed ls-remote line: {line}"))?;
        model::oid(o)?;
        if !valid_exact_ref(r) {
            return Err(format!("remote advertised malformed ref {r}"));
        }
        if !in_scope(r, patterns) {
            return Err(format!("remote advertised out-of-scope ref {r}"));
        }
        if refs.insert(r.into(), o.into()).is_some() {
            return Err(format!("remote advertised duplicate ref {r}"));
        }
    }
    Ok(refs)
}

fn advertise_remote_bounded(
    remote: &str,
    patterns: &[String],
    line_limit: usize,
    byte_limit: usize,
) -> Result<Snapshot> {
    model::bounded("remote", remote, 4096)?;
    if patterns.is_empty() || patterns.iter().any(|pattern| !valid_scope(pattern)) {
        return Err("scoped advertisement requires non-global exact refs or prefixes".into());
    }
    let mut child = Command::new("git")
        .args(["ls-remote", "--refs", "--", remote])
        .args(patterns)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run ls-remote: {e}"))?;
    let stdout = child.stdout.take().ok_or("open ls-remote stdout")?;
    let mut stderr = child.stderr.take().ok_or("open ls-remote stderr")?;
    let stderr_reader = thread::spawn(move || {
        let mut value = Vec::new();
        stderr
            .by_ref()
            .take(64 * 1024 + 1)
            .read_to_end(&mut value)
            .map(|_| value)
    });
    let parsed = parse_advertisement(BufReader::new(stdout), patterns, line_limit, byte_limit);
    if parsed.is_err() {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|e| format!("wait for ls-remote: {e}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "ls-remote stderr reader panicked")?
        .map_err(|e| format!("read ls-remote stderr: {e}"))?;
    if stderr.len() > 64 * 1024 {
        return Err("ls-remote stderr exceeds hard limit".into());
    }
    let refs = parsed?;
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().into());
    }
    Ok(Snapshot { refs })
}
pub(crate) fn checked_snapshot(mut patterns: Vec<String>) -> Result<Snapshot> {
    patterns.push(ACTIVATION.into());
    patterns.sort();
    patterns.dedup();
    let snap = advertise(&patterns)?;
    validate_snapshot(&snap)?;
    Ok(snap)
}

pub(crate) fn validate_snapshot(snap: &Snapshot) -> Result<()> {
    let activation = snap
        .refs
        .get(ACTIVATION)
        .ok_or("v2 activation is absent; run init")?;
    materialize(std::slice::from_ref(activation))?;
    let a = crate::validators::activation(activation)?;
    let allowed = a["allowedRuntimeCommits"]
        .as_array()
        .ok_or("activation allowedRuntimeCommits malformed")?;
    let runtime = runtime()?;
    if !allowed.iter().any(|v| v.as_str() == Some(&runtime)) {
        return Err(format!("runtime {runtime} is not authorized by activation"));
    }
    Ok(())
}
pub(crate) fn materialize(oids: &[String]) -> Result<()> {
    materialize_remote("origin", oids)
}

pub(crate) fn materialize_local(oids: &[String]) -> Result<()> {
    let unique: BTreeSet<_> = oids.iter().cloned().collect();
    let objects: Vec<_> = unique.into_iter().collect();
    if objects.is_empty() {
        return Ok(());
    }
    let info = git::batch_object_info(&objects)?;
    let mut charge = Vec::new();
    for oid in &objects {
        let item = info.get(oid).ok_or("git batch-check omitted object")?;
        if item.kind.as_deref() != Some("commit") {
            return Err(format!(
                "validator closure object {oid} is missing or is not a commit"
            ));
        }
        let size = item.size.ok_or("git batch-check object size absent")?;
        if size > MAX_INSPECTION_OBJECT_BYTES {
            return Err(format!("object {oid} exceeds per-object byte limit"));
        }
        charge.push((oid.clone(), size));
    }
    INSPECTION.with(|inspection| -> Result<()> {
        let mut inspection = inspection.borrow_mut();
        for (oid, size) in charge {
            if inspection.0.insert(oid) {
                inspection.1 = inspection
                    .1
                    .checked_add(size)
                    .ok_or("object byte total overflow")?;
                if inspection.1 > MAX_INSPECTION_TOTAL_BYTES {
                    return Err("objects exceed cumulative byte limit".into());
                }
            }
        }
        Ok(())
    })?;
    git::cache_commit_objects(&objects)
}

pub(crate) fn materialize_remote(remote: &str, oids: &[String]) -> Result<()> {
    model::bounded("remote", remote, 4096)?;
    let unique: BTreeSet<_> = oids.iter().cloned().collect();
    if unique.is_empty() {
        return Ok(());
    }
    for oid in &unique {
        model::oid(oid)?;
    }
    let objects: Vec<_> = unique.into_iter().collect();
    let initial = git::batch_object_types(&objects)?;
    if initial.values().flatten().any(|kind| kind != "commit") {
        return Err("fetched object did not equal captured advertisement OID".into());
    }
    let missing: Vec<_> = initial
        .into_iter()
        .filter_map(|(oid, kind)| kind.is_none().then_some(oid))
        .collect();
    if !missing.is_empty() {
        let mut fetch = Command::new("git");
        fetch.args([
            "fetch",
            "--no-tags",
            "--quiet",
            "--no-write-fetch-head",
            "--",
            remote,
        ]);
        fetch.args(&missing);
        fetch.env("GIT_NO_LAZY_FETCH", "1");
        let out = fetch
            .output()
            .map_err(|e| format!("run bounded fetch: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "bounded object fetch failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        if git::batch_object_types(&missing)?
            .values()
            .any(|kind| kind.as_deref() != Some("commit"))
        {
            return Err("fetched object did not equal captured advertisement OID".into());
        }
    }
    git::cache_commit_objects(&objects)?;
    Ok(())
}
pub(crate) fn materialize_lifecycle(snap: &Snapshot, ids: &[String]) -> Result<()> {
    let mut oids = Vec::new();
    for id in ids {
        let found = model::lifecycle(snap, id);
        if found.len() == 1 {
            oids.push(found[0].2.clone());
        }
    }
    materialize(&oids)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeClaimRegistryEntry {
    task_id: String,
    owner: String,
    host: String,
    session_id: String,
    claim_token: String,
}

fn git_path(path: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(git::bounded_output(
        &["rev-parse", "--git-path", path],
        4096,
    )?))
}

/// Serialize ownership of the native-claim registry across mutation staging,
/// push, readback, and guard reconciliation. File locks are released by the OS
/// if a process exits or crashes.
pub(crate) fn native_claim_registry_lock(nonblocking: bool) -> Result<File> {
    let path = git_path("task-dag/native-claims.lock")?;
    let parent = path.parent().ok_or("native claim lock has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("create native claim lock directory: {e}"))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("open native claim registry lock: {e}"))?;
    if nonblocking {
        file.try_lock().map_err(|e| {
            format!("native claim registry mutation is in flight (fail closed): {e}")
        })?;
    } else {
        file.lock()
            .map_err(|e| format!("lock native claim registry: {e}"))?;
    }
    Ok(file)
}

fn worktree_hooks() -> Result<(PathBuf, PathBuf)> {
    let root = PathBuf::from(git::bounded_output(
        &["rev-parse", "--show-toplevel"],
        4096,
    )?);
    if root.as_os_str().is_empty() || !root.is_absolute() {
        return Err("native hooks require a worktree root".into());
    }
    let hooks = root.join(".githooks");
    Ok((root, hooks))
}

fn effective_hooks() -> Result<PathBuf> {
    Ok(PathBuf::from(git::bounded_output(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        4096,
    )?))
}

fn config_value(local: bool) -> Result<Option<String>> {
    let args: &[&str] = if local {
        &["config", "--local", "--get", "core.hooksPath"]
    } else {
        &["config", "--get", "core.hooksPath"]
    };
    let output = git::bounded_output_status(args, 4096)?;
    match output.code {
        Some(0) => Ok(Some(output.stdout)),
        Some(1) => Ok(None),
        _ => Err(format!("could not read core.hooksPath: {}", output.stderr)),
    }
}

fn git_common_dir() -> Result<PathBuf> {
    Ok(PathBuf::from(git::bounded_output(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
    )?))
}

fn install_local_hooks_config(common: &std::path::Path) -> Result<()> {
    let config = common.join("config");
    let lock = common.join("config.lock");
    let mut transaction = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&lock)
        .map_err(|e| format!("lock local Git config: {e}"))?;
    let mut owned = match transaction.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&lock);
            return Err(format!("inspect local Git config lock: {error}"));
        }
    };
    let mut committed = false;
    let result = (|| {
        let mut source = File::open(&config).map_err(|e| format!("open local Git config: {e}"))?;
        let source_mode = source
            .metadata()
            .map_err(|e| format!("inspect local Git config: {e}"))?
            .permissions()
            .mode()
            & 0o777;
        transaction
            .set_permissions(fs::Permissions::from_mode(source_mode))
            .map_err(|e| format!("set staged local Git config mode: {e}"))?;
        std::io::copy(&mut source, &mut transaction)
            .and_then(|_| transaction.sync_all())
            .map_err(|e| format!("stage local Git config: {e}"))?;
        drop(transaction);
        let lock_text = lock.to_str().ok_or("local Git config path is not UTF-8")?;
        let existing = git::bounded_output_status(
            &["config", "--file", lock_text, "--get-all", "core.hooksPath"],
            4096,
        )?;
        match existing.code {
            Some(1) => {}
            Some(0) => {
                return Err("core.hooksPath changed concurrently; refusing to overwrite it".into());
            }
            _ => {
                return Err(format!(
                    "inspect staged local Git config: {}",
                    existing.stderr
                ));
            }
        }
        git::bounded_output(
            &[
                "config",
                "--file",
                lock_text,
                "--add",
                "core.hooksPath",
                ".githooks",
            ],
            4096,
        )?;
        owned = fs::symlink_metadata(&lock)
            .map_err(|e| format!("inspect updated local Git config lock: {e}"))?;
        File::open(&lock)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("sync staged local Git config: {e}"))?;
        fs::rename(&lock, &config).map_err(|e| format!("commit local Git config: {e}"))?;
        committed = true;
        File::open(common)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("sync Git common directory: {e}"))?;
        Ok(())
    })();
    if result.is_err() && !committed {
        if let Ok(current) = fs::symlink_metadata(&lock)
            && !current.file_type().is_symlink()
            && current.dev() == owned.dev()
            && current.ino() == owned.ino()
        {
            let _ = fs::remove_file(&lock);
        }
    }
    result
}

fn open_hooks_directory(path: &std::path::Path) -> Result<File> {
    let before = fs::symlink_metadata(path)
        .map_err(|e| format!("canonical .githooks is unavailable: {e}"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err(".githooks must be a regular non-symlink directory".into());
    }
    let descriptor = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| format!("open .githooks directory: {e}"))?;
    let directory = File::from(descriptor);
    let opened = directory
        .metadata()
        .map_err(|e| format!("inspect .githooks: {e}"))?;
    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err(".githooks changed during inspection".into());
    }
    Ok(directory)
}

fn verify_directory_path(path: &std::path::Path, directory: &File) -> Result<()> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|e| format!("reinspect .githooks directory: {e}"))?;
    let opened = directory
        .metadata()
        .map_err(|e| format!("inspect open .githooks directory: {e}"))?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_dir()
        || path_metadata.dev() != opened.dev()
        || path_metadata.ino() != opened.ino()
    {
        return Err(".githooks changed during operation".into());
    }
    Ok(())
}

fn verify_hook_file(hooks_path: &std::path::Path, hooks: &File) -> Result<u32> {
    verify_directory_path(hooks_path, hooks)?;
    let path = hooks_path.join("pre-push");
    let before = fs::symlink_metadata(&path)
        .map_err(|e| format!("canonical .githooks/pre-push is unavailable: {e}"))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err("canonical .githooks/pre-push must be a regular non-symlink file".into());
    }
    let descriptor = rustix::fs::openat(
        hooks,
        "pre-push",
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| format!("open canonical pre-push hook: {e}"))?;
    let mut file = File::from(descriptor);
    let opened = file
        .metadata()
        .map_err(|e| format!("inspect canonical pre-push hook: {e}"))?;
    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err("canonical pre-push hook changed during inspection".into());
    }
    let comparison_length = CANONICAL_PRE_PUSH_HOOK
        .len()
        .max(LEGACY_PRE_PUSH_HOOK_V1.len())
        + 1;
    let mut bytes = Vec::with_capacity(comparison_length);
    Read::by_ref(&mut file)
        .take(comparison_length as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read canonical pre-push hook: {e}"))?;
    let secondary = hooks_path.join("pre-push.repository");
    let has_secondary = match fs::symlink_metadata(&secondary) {
        Ok(metadata) => {
            let mode = metadata.mode() & 0o7777;
            if metadata.file_type().is_symlink() || !metadata.is_file() || mode != 0o755 {
                return Err(".githooks/pre-push.repository must be a regular non-symlink file with exact mode 0755".into());
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("inspect pre-push.repository: {error}")),
    };
    if bytes != CANONICAL_PRE_PUSH_HOOK && (bytes != LEGACY_PRE_PUSH_HOOK_V1 || has_secondary) {
        return Err(".githooks/pre-push conflicts with the canonical hook".into());
    }
    if has_secondary && bytes != CANONICAL_PRE_PUSH_HOOK {
        return Err("pre-push.repository requires the current canonical pre-push hook".into());
    }
    let after = fs::symlink_metadata(&path)
        .map_err(|e| format!("reinspect canonical pre-push hook: {e}"))?;
    if after.file_type().is_symlink()
        || !after.is_file()
        || after.dev() != opened.dev()
        || after.ino() != opened.ino()
    {
        return Err("canonical pre-push hook changed during inspection".into());
    }
    let mode = file
        .metadata()
        .map_err(|e| format!("final canonical pre-push metadata: {e}"))?
        .mode()
        & 0o7777;
    if mode != 0o755 {
        return Err(format!(
            "canonical .githooks/pre-push mode is {mode:04o}, expected 0755"
        ));
    }
    verify_directory_path(hooks_path, hooks)?;
    Ok(mode)
}

fn verify_hooks() -> Result<u32> {
    let (_, hooks) = worktree_hooks()?;
    if effective_hooks()? != hooks {
        return Err("effective core.hooksPath is not this worktree's .githooks".into());
    }
    let directory = open_hooks_directory(&hooks)?;
    verify_hook_file(&hooks, &directory)
}

fn migrate_existing_hook(hooks_path: &std::path::Path, directory: &File) -> Result<bool> {
    let primary = hooks_path.join("pre-push");
    let secondary = hooks_path.join("pre-push.repository");
    let descriptor = rustix::fs::openat(
        directory,
        "pre-push",
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| format!("open existing pre-push hook: {e}"))?;
    let mut old = File::from(descriptor);
    let identity = old
        .metadata()
        .map_err(|e| format!("inspect existing pre-push hook: {e}"))?;
    if !identity.is_file() || identity.mode() & 0o7777 != 0o755 {
        return Err(
            "migration requires a regular non-symlink pre-push hook with exact mode 0755".into(),
        );
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut old)
        .take(
            (CANONICAL_PRE_PUSH_HOOK
                .len()
                .max(LEGACY_PRE_PUSH_HOOK_V1.len())
                + 1) as u64,
        )
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read existing pre-push hook: {e}"))?;
    if bytes == CANONICAL_PRE_PUSH_HOOK {
        return Ok(false);
    }
    if bytes == LEGACY_PRE_PUSH_HOOK_V1 {
        return Err(
            "the exact legacy task-dag hook is not a repository hook and cannot be migrated".into(),
        );
    }
    old.sync_all()
        .map_err(|e| format!("sync existing pre-push hook: {e}"))?;

    let mut created_secondary = false;
    match fs::symlink_metadata(&secondary) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::hard_link(&primary, &secondary)
                .map_err(|e| format!("preserve pre-push as pre-push.repository: {e}"))?;
            created_secondary = true;
        }
        Ok(_) => {}
        Err(error) => return Err(format!("inspect pre-push.repository: {error}")),
    }
    let same_as_old = |path: &std::path::Path| {
        fs::symlink_metadata(path).is_ok_and(|m| {
            !m.file_type().is_symlink()
                && m.is_file()
                && m.dev() == identity.dev()
                && m.ino() == identity.ino()
        })
    };
    let result = (|| {
        if !same_as_old(&primary) || !same_as_old(&secondary) {
            return Err("pre-push hook identities changed during migration".into());
        }
        directory
            .sync_all()
            .map_err(|e| format!("sync .githooks after preserving hook: {e}"))?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("create migration nonce: {e}"))?
            .as_nanos();
        let temporary = hooks_path.join(format!(
            ".pre-push.migrate.{}.{nonce}.tmp",
            std::process::id()
        ));
        let mut replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&temporary)
            .map_err(|e| format!("create migration temporary hook: {e}"))?;
        let temporary_identity = replacement
            .metadata()
            .map_err(|e| format!("inspect migration temporary hook: {e}"))?;
        let cleanup_temporary = || {
            if fs::symlink_metadata(&temporary).is_ok_and(|metadata| {
                !metadata.file_type().is_symlink()
                    && metadata.is_file()
                    && metadata.dev() == temporary_identity.dev()
                    && metadata.ino() == temporary_identity.ino()
            }) {
                let _ = fs::remove_file(&temporary);
            }
        };
        let publish: Result<()> = (|| {
            replacement
                .write_all(CANONICAL_PRE_PUSH_HOOK)
                .map_err(|e| format!("write migration temporary hook: {e}"))?;
            replacement
                .set_permissions(fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("set migration hook mode: {e}"))?;
            replacement
                .sync_all()
                .map_err(|e| format!("sync migration hook: {e}"))?;
            if !same_as_old(&primary) || !same_as_old(&secondary) {
                return Err("pre-push hook identities changed before migration publish".into());
            }
            fs::rename(&temporary, &primary)
                .map_err(|e| format!("publish migrated pre-push hook: {e}"))?;
            Ok(())
        })();
        if publish.is_err() {
            cleanup_temporary();
        }
        publish?;
        directory
            .sync_all()
            .map_err(|e| format!("sync .githooks after migration: {e}"))?;
        Ok(true)
    })();
    if result.is_err() && created_secondary && same_as_old(&secondary) && same_as_old(&primary) {
        let _ = fs::remove_file(&secondary);
        let _ = directory.sync_all();
    }
    result
}

pub(crate) fn install_hooks(migrate_existing_pre_push: bool) -> Result<()> {
    let (root, hooks) = worktree_hooks()?;
    let common = git_common_dir()?;
    let lock_path = common.join("task-dag/install-hooks.lock");
    let lock_parent = lock_path
        .parent()
        .ok_or("install-hooks lock has no parent")?;
    fs::create_dir_all(lock_parent)
        .map_err(|e| format!("create install-hooks lock directory: {e}"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_path)
        .map_err(|e| format!("open install-hooks lock: {e}"))?;
    lock.lock()
        .map_err(|e| format!("lock install-hooks: {e}"))?;

    let local = config_value(true)?;
    let effective_config = config_value(false)?;
    if (local.is_some() || effective_config.is_some()) && effective_hooks()? != hooks {
        return Err("refusing to replace an existing custom core.hooksPath".into());
    }

    let mut directory_created = false;
    match fs::symlink_metadata(&hooks) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(".githooks must be a regular non-symlink directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&hooks) {
                Ok(()) => directory_created = true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("create .githooks: {error}")),
            }
        }
        Err(error) => return Err(format!("inspect .githooks: {error}")),
    }

    let directory = open_hooks_directory(&hooks)?;
    let hook = hooks.join("pre-push");
    let mut hook_changed = false;
    if migrate_existing_pre_push && hook.exists() {
        hook_changed = migrate_existing_hook(&hooks, &directory)?;
    }
    match fs::symlink_metadata(&hook) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(".githooks/pre-push must be a regular non-symlink file".into());
            }
            match verify_hook_file(&hooks, &directory) {
                Ok(_) => {}
                Err(error) if error.contains("mode is") => {
                    let descriptor = rustix::fs::openat(
                        &directory,
                        "pre-push",
                        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|e| format!("open canonical pre-push hook: {e}"))?;
                    let file = File::from(descriptor);
                    let opened = file.metadata().map_err(|e| e.to_string())?;
                    if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
                        return Err("canonical pre-push hook changed before chmod".into());
                    }
                    rustix::fs::fchmod(&file, Mode::from_raw_mode(0o755))
                        .map_err(|e| format!("make canonical pre-push hook executable: {e}"))?;
                    file.sync_all()
                        .map_err(|e| format!("sync pre-push hook: {e}"))?;
                    hook_changed = true;
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let temporary = format!(".pre-push.{}.{nonce}.tmp", std::process::id());
            let result = (|| {
                let descriptor = rustix::fs::openat(
                    &directory,
                    temporary.as_str(),
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_raw_mode(0o755),
                )
                .map_err(|e| format!("create temporary pre-push hook: {e}"))?;
                let mut file = File::from(descriptor);
                let owned = file.metadata().map_err(|e| e.to_string())?;
                file.write_all(CANONICAL_PRE_PUSH_HOOK)
                    .and_then(|()| file.sync_all())
                    .map_err(|e| format!("write canonical pre-push hook: {e}"))?;
                rustix::fs::fchmod(&file, Mode::from_raw_mode(0o755))
                    .map_err(|e| format!("set canonical pre-push hook mode: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("sync canonical pre-push hook: {e}"))?;
                match rustix::fs::linkat(
                    &directory,
                    temporary.as_str(),
                    &directory,
                    "pre-push",
                    AtFlags::empty(),
                ) {
                    Ok(()) => hook_changed = true,
                    Err(error) if error == rustix::io::Errno::EXIST => {}
                    Err(error) => return Err(format!("publish canonical pre-push hook: {error}")),
                }
                let current =
                    rustix::fs::statat(&directory, temporary.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                        .map_err(|e| format!("inspect temporary pre-push hook: {e}"))?;
                if current.st_dev != owned.dev() || current.st_ino != owned.ino() {
                    return Err("temporary pre-push hook changed before cleanup".into());
                }
                rustix::fs::unlinkat(&directory, temporary.as_str(), AtFlags::empty())
                    .map_err(|e| format!("remove temporary pre-push hook: {e}"))?;
                Ok(())
            })();
            result?;
            directory
                .sync_all()
                .map_err(|e| format!("sync .githooks: {e}"))?;
            if directory_created {
                File::open(&root)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|e| format!("sync worktree root: {e}"))?;
            }
        }
        Err(error) => return Err(format!("inspect pre-push hook: {error}")),
    }
    let _ = verify_hook_file(&hooks, &directory)?;

    let config_changed = local.is_none();
    if config_changed {
        install_local_hooks_config(&common)?;
    }
    let final_local = config_value(true)?;
    if (config_changed && final_local.as_deref() != Some(".githooks"))
        || (!config_changed && final_local != local)
        || effective_hooks()? != hooks
    {
        return Err("core.hooksPath verification failed".into());
    }
    let mode = verify_hooks()?;
    crate::commands::print_json(&serde_json::json!({
        "configChanged": config_changed,
        "hookChanged": hook_changed,
        "hooksPath": ".githooks",
        "mode": format!("{mode:04o}")
    }))
}

fn stage_native_claims(updates: &[Update]) -> Result<()> {
    let mut active = Vec::new();
    for update in updates {
        if let Some(id) = model::parse_state_ref(&update.semantic_ref, "active")
            && id.starts_with("v2-")
            && let Some(new) = &update.new
        {
            model::valid_id(id)?;
            active.push((id, new));
        }
    }
    if active.is_empty() {
        return Ok(());
    }
    verify_hooks()?;
    let directory = git_path("task-dag/native-claims")?;
    let staging = git_path("task-dag/native-claim-staging")?;
    fs::create_dir_all(&directory).map_err(|e| format!("create native claim registry: {e}"))?;
    fs::create_dir_all(&staging).map_err(|e| format!("create native claim staging: {e}"))?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("secure native claim registry: {e}"))?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("secure native claim staging: {e}"))?;
    for (id, oid) in active {
        let value = crate::validators::lifecycle("active", oid, id)?;
        let claim: model::ClaimRecord =
            serde_json::from_value(value).map_err(|e| format!("active claim malformed: {e}"))?;
        if claim.task_id != id {
            return Err("active claim task identity disagrees with its ref".into());
        }
        model::bounded("claim token", &claim.claim_token, 256)?;
        model::bounded("claim owner", &claim.owner, 256)?;
        model::bounded("claim host", &claim.host, 256)?;
        model::bounded("claim session", &claim.session_id, 256)?;
        let digest = format!("{:x}", Sha256::digest(claim.claim_token.as_bytes()));
        let path = directory.join(format!("{id}.{digest}"));
        let temporary = staging.join(format!("{id}.{digest}.{}.tmp", std::process::id()));
        let entry = NativeClaimRegistryEntry {
            task_id: claim.task_id,
            owner: claim.owner,
            host: claim.host,
            session_id: claim.session_id,
            claim_token: claim.claim_token,
        };
        let bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|e| format!("stage native claim registry: {e}"))?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| format!("write native claim registry: {e}"))?;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("secure staged native claim: {e}"))?;
            fs::rename(&temporary, &path)
                .map_err(|e| format!("publish native claim registry: {e}"))?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("secure published native claim: {e}"))?;
            let mode = fs::metadata(&path)
                .map_err(|e| format!("verify published native claim: {e}"))?
                .permissions()
                .mode()
                & 0o777;
            if mode != 0o600 {
                return Err(format!(
                    "published native claim mode is {mode:o}, expected 600"
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
    }
    Ok(())
}

pub(crate) fn mutate(updates: Vec<Update>) -> Result<()> {
    let _registry_lock = native_claim_registry_lock(false)?;
    // Stage protection before performing any remote operation.
    // A rejected push may leave a harmless candidate that the hook reconciles.
    stage_native_claims(&updates)?;
    let mut cmd = Command::new("git");
    cmd.args(["push", "--porcelain", "--atomic", "origin"])
        .env("TASKDAG_NATIVE_MUTATION", "1");
    for u in &updates {
        let old = u.old.as_deref().unwrap_or("");
        cmd.arg(format!("--force-with-lease={}:{}", u.semantic_ref, old));
        cmd.arg(match &u.new {
            Some(n) => format!("{n}:{}", u.semantic_ref),
            None => format!(":{}", u.semantic_ref),
        });
    }
    let push = cmd.output().map_err(|e| format!("run git push: {e}"))?;
    let touched: Vec<String> = updates.iter().map(|u| u.semantic_ref.clone()).collect();
    let readback = advertise(&touched)?;
    let all_new = updates
        .iter()
        .all(|u| readback.refs.get(&u.semantic_ref) == u.new.as_ref());
    if all_new {
        #[cfg(feature = "test-seam")]
        if std::env::var_os("TASKDAG_TEST_FAIL_AFTER_PUSH").is_some() {
            return Err("test seam: failure after push before output".into());
        }
        return Ok(());
    }
    let all_old = updates
        .iter()
        .all(|u| readback.refs.get(&u.semantic_ref) == u.old.as_ref());
    if push.status.success() {
        Err("push reported success but authoritative readback differs".into())
    } else if all_old {
        Err("atomic push rejected; semantic refs remain at their advertised old values".into())
    } else {
        Err("push outcome is conflicting or indeterminate; semantic refs are mixed".into())
    }
}
pub(crate) fn exclusive(s: &Snapshot, id: &str, expected: &str) -> Result<()> {
    let f = model::lifecycle(s, id);
    if f.len() == 1 && f[0].0 == expected {
        materialize(std::slice::from_ref(&f[0].2))?;
        if expected == "waiting" {
            crate::validators::waiting(&f[0].2, id)?;
        } else {
            crate::validators::lifecycle(expected, &f[0].2, id)?;
        }
        Ok(())
    } else {
        Err(format!(
            "task {id} must be exclusively {expected}; observed {f:?}"
        ))
    }
}
pub(crate) fn exclusive_done(s: &Snapshot, id: &str) -> Result<serde_json::Value> {
    exclusive(s, id, "done")?;
    crate::validators::lifecycle("done", &s.refs[&model::state_ref("done", id)], id)
}
pub(crate) fn ensure_new(s: &Snapshot, id: &str) -> Result<()> {
    if model::lifecycle(s, id).is_empty() {
        Ok(())
    } else {
        Err(format!(
            "task {id} already exists in a fixed lifecycle namespace"
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::{parse_advertisement, valid_exact_ref, valid_scope};
    use std::io::Cursor;

    #[test]
    fn remote_advertisement_scopes_are_bounded_and_well_formed() {
        assert!(valid_scope("refs/heads/master"));
        assert!(valid_scope("refs/heads/gh/issues/*"));
        assert!(valid_scope("refs/heads/tasks/frontier/*"));
        assert!(valid_scope("refs/heads/tasks/frontier/v2-*"));
        assert!(valid_scope("refs/heads/tasks/delegation/intent/*"));
        for invalid in [
            "refs/*",
            "refs/heads/*",
            "refs/tags/*",
            "refs/heads/tasks/*",
            "refs/heads/tasks/frontier/**",
            "refs/heads/tasks/frontier/v1-*",
            "refs/heads/tasks/active/v2-*",
            "refs/heads/tasks/frontier/?",
            "refs/heads/tasks/frontier/[a]",
            "refs/heads/tasks//frontier",
        ] {
            assert!(!valid_scope(invalid), "accepted invalid scope {invalid}");
        }
        assert!(!valid_exact_ref("refs/heads/tasks/frontier/a..b"));
        assert!(!valid_exact_ref("refs/heads/tasks/frontier/a\tb"));
    }

    #[test]
    fn scoped_advertisement_enforces_streaming_line_and_byte_limits() {
        let oid = "0".repeat(40);
        let input = format!(
            "{oid}\trefs/heads/tasks/comments/intents/a\n{oid}\trefs/heads/tasks/comments/intents/b\n"
        );
        let patterns = vec!["refs/heads/tasks/comments/intents/*".into()];
        assert!(
            parse_advertisement(Cursor::new(input.as_bytes()), &patterns, 1, usize::MAX).is_err()
        );
        assert!(
            parse_advertisement(Cursor::new(input.as_bytes()), &patterns, 2, input.len() - 1)
                .is_err()
        );
        assert_eq!(
            parse_advertisement(Cursor::new(input), &patterns, 2, usize::MAX)
                .unwrap()
                .len(),
            2
        );
    }
}
