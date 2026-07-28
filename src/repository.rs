use crate::{
    Result, git,
    model::{self, ACTIVATION, JOURNAL, Update},
    runtime,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
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
    if patterns.is_empty()
        || patterns
            .iter()
            .any(|p| p == "*" || p == "refs/heads/*" || p == "refs/*")
    {
        return Err("scoped advertisement requires non-global exact refs or prefixes".into());
    }
    let out = Command::new("git")
        .args(["ls-remote", "--refs", "origin"])
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
        refs.insert(r.into(), o.into());
    }
    Ok(Snapshot { refs })
}
pub(crate) fn checked_snapshot(mut patterns: Vec<String>) -> Result<Snapshot> {
    patterns.extend([ACTIVATION.into(), JOURNAL.into()]);
    patterns.sort();
    patterns.dedup();
    let snap = advertise(&patterns)?;
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
    Ok(snap)
}
pub(crate) fn materialize(oids: &[String]) -> Result<()> {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let unique: BTreeSet<_> = oids.iter().cloned().collect();
    if unique.is_empty() {
        return Ok(());
    }
    let prefix = format!(
        "refs/taskdag-private/{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let mut fetch = Command::new("git");
    fetch.args(["fetch", "--no-tags", "--quiet", "origin"]);
    let refs: Vec<_> = unique
        .iter()
        .enumerate()
        .map(|(i, oid)| {
            let r = format!("{prefix}/{i}");
            fetch.arg(format!("+{oid}:{r}"));
            (r, oid)
        })
        .collect();
    let out = fetch
        .output()
        .map_err(|e| format!("run bounded fetch: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "bounded object fetch failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let verified = refs.iter().all(|(r, expected)| {
        git::output(["rev-parse", r])
            .map(|v| v.trim() == *expected)
            .unwrap_or(false)
    });
    let mut cleanup = Command::new("git");
    cleanup
        .args(["update-ref", "--stdin"])
        .stdin(Stdio::piped());
    let mut child = cleanup
        .spawn()
        .map_err(|e| format!("start private-ref cleanup: {e}"))?;
    use std::io::Write;
    for (r, _) in &refs {
        writeln!(child.stdin.as_mut().unwrap(), "delete {r}").map_err(|e| e.to_string())?;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("private-ref cleanup failed".into());
    }
    if !verified {
        return Err("fetched object did not equal captured advertisement OID".into());
    }
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
