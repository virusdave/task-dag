use crate::{
    Result, git,
    model::{self, ACTIVATION, JOURNAL, Update},
    runtime,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
};

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
pub(crate) fn mutate(snap: &Snapshot, mut updates: Vec<Update>, journal: &str) -> Result<()> {
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
