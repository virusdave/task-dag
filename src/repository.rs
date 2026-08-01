use crate::{
    Result, git,
    model::{self, ACTIVATION, JOURNAL, Update},
    runtime,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    io::{BufRead, BufReader},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Command,
    process::Stdio,
};

const CURRENT_ADVERTISEMENT_LINES: usize = 502;
const CURRENT_ADVERTISEMENT_BYTES: usize = 512 * 1024;
const MAX_INSPECTION_OBJECT_BYTES: usize = 256 * 1024;
const MAX_INSPECTION_TOTAL_BYTES: usize = 64 * 1024 * 1024;

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

/// Advertise only the five native-v2 lifecycle namespaces and the two system
/// refs. This parser deliberately does not call `git check-ref-format`: the
/// accepted grammar below is finite and stricter.
pub(crate) fn advertise_current_state() -> Result<Snapshot> {
    let patterns = [
        "refs/heads/tasks/frontier/v2-*",
        "refs/heads/tasks/active/v2-*",
        "refs/heads/tasks/blocked/v2-*",
        "refs/heads/tasks/waiting/v2-*",
        "refs/heads/tasks/done/v2-*",
        ACTIVATION,
        JOURNAL,
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
            || reference == JOURNAL
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
    model::bounded("remote", remote, 4096)?;
    if patterns.is_empty() || patterns.iter().any(|pattern| !valid_scope(pattern)) {
        return Err("scoped advertisement requires non-global exact refs or prefixes".into());
    }
    let out = Command::new("git")
        .args(["ls-remote", "--refs", "--", remote])
        .args(patterns)
        .output()
        .map_err(|e| format!("run ls-remote: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let out = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
    let mut refs = BTreeMap::new();
    for line in out.lines() {
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
    Ok(Snapshot { refs })
}
pub(crate) fn checked_snapshot(mut patterns: Vec<String>) -> Result<Snapshot> {
    patterns.extend([ACTIVATION.into(), JOURNAL.into()]);
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
    let journal = snap
        .refs
        .get(JOURNAL)
        .ok_or("transition journal is absent; run init")?;
    materialize(&[activation.clone(), journal.clone()])?;
    let a = crate::validators::activation(activation)?;
    crate::validators::journal(journal, activation)?;
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
    let out = Command::new("git")
        .args(["rev-parse", "--git-path", path])
        .output()
        .map_err(|e| format!("resolve Git path {path}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "resolve Git path {path}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let value = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
    Ok(PathBuf::from(value.trim_end()))
}

fn ensure_pre_push_hook() -> Result<()> {
    let configured = Command::new("git")
        .args(["config", "--get", "core.hooksPath"])
        .output()
        .map_err(|e| format!("read core.hooksPath: {e}"))?;
    if configured.status.success() {
        return Ok(());
    }
    if configured.status.code() != Some(1) {
        return Err("could not determine effective core.hooksPath".into());
    }
    let root = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("resolve worktree root: {e}"))?;
    if !root.status.success() {
        return Err("native claim requires a worktree root".into());
    }
    let root = PathBuf::from(
        String::from_utf8(root.stdout)
            .map_err(|e| e.to_string())?
            .trim_end(),
    );
    let hooks = root.join(".githooks");
    let hook = hooks.join("pre-push");
    let metadata = fs::metadata(&hook)
        .map_err(|e| format!("native claim requires executable .githooks/pre-push: {e}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err("native claim requires executable .githooks/pre-push".into());
    }
    let set = Command::new("git")
        .args(["config", "--local", "core.hooksPath"])
        .arg(&hooks)
        .output()
        .map_err(|e| format!("set core.hooksPath: {e}"))?;
    if !set.status.success() {
        return Err(format!(
            "set core.hooksPath: {}",
            String::from_utf8_lossy(&set.stderr).trim()
        ));
    }
    let verify = Command::new("git")
        .args(["config", "--local", "--get", "core.hooksPath"])
        .output()
        .map_err(|e| format!("verify core.hooksPath: {e}"))?;
    if !verify.status.success()
        || PathBuf::from(String::from_utf8_lossy(&verify.stdout).trim_end()) != hooks
    {
        return Err("core.hooksPath verification failed".into());
    }
    Ok(())
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
    ensure_pre_push_hook()?;
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

pub(crate) fn mutate(snap: &Snapshot, mut updates: Vec<Update>, journal: &str) -> Result<()> {
    // Stage protection before adding the journal or performing any remote operation.
    // A rejected push may leave a harmless candidate that the hook reconciles.
    stage_native_claims(&updates)?;
    updates.push(Update {
        semantic_ref: JOURNAL.into(),
        old: snap.refs.get(JOURNAL).cloned(),
        new: Some(journal.into()),
    });
    let mut cmd = Command::new("git");
    cmd.args(["push", "--porcelain", "--atomic", "origin"]);
    for u in &updates {
        let old = u.old.as_deref().unwrap_or("");
        cmd.arg(format!("--force-with-lease={}:{}", u.semantic_ref, old));
        cmd.arg(match &u.new {
            Some(n) => format!("{n}:{}", u.semantic_ref),
            None => format!(":{}", u.semantic_ref),
        });
    }
    let push = cmd.output().map_err(|e| format!("run git push: {e}"))?;
    let mut touched: Vec<String> = updates.iter().map(|u| u.semantic_ref.clone()).collect();
    touched.extend([ACTIVATION.into(), JOURNAL.into()]);
    let readback = advertise(&touched)?;
    let all_new = updates
        .iter()
        .filter(|u| u.semantic_ref != JOURNAL)
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
        .filter(|u| u.semantic_ref != JOURNAL)
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
pub(crate) fn absent(s: &Snapshot, r: &str) -> Result<()> {
    if s.refs.contains_key(r) {
        Err(format!("ref {r} must be absent"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{valid_exact_ref, valid_scope};

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
}
