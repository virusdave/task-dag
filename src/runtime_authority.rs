use crate::{Result, model};
use std::{collections::BTreeMap, process::Command};

pub(crate) const PRODUCTION_REMOTE: &str = "git@github-task-dag:virusdave/task-dag.git";
pub(crate) const CANONICAL_IDENTITY: &str = "github.com/virusdave/task-dag";
const REF_PREFIX: &str = "refs/tags/task-dag-runtime-v2/";

fn remote() -> &'static str {
    #[cfg(feature = "test-seam")]
    if let Some(value) = std::env::var_os("TASKDAG_TEST_RUNTIME_REMOTE") {
        return Box::leak(
            value
                .into_string()
                .expect("runtime remote must be UTF-8")
                .into_boxed_str(),
        );
    }
    PRODUCTION_REMOTE
}

pub(crate) fn runtime_ref(commit: &str) -> Result<String> {
    model::oid(commit)?;
    Ok(format!("{REF_PREFIX}{commit}"))
}

pub(crate) fn identity() -> Result<()> {
    crate::commands::print_json(&serde_json::json!({
        "canonicalIdentity": CANONICAL_IDENTITY,
        "compiledCommit": crate::runtime()?,
    }))
}

fn advertise(reference: &str) -> Result<BTreeMap<String, String>> {
    let out = Command::new("git")
        .args(["ls-remote", "--refs", remote(), reference])
        .output()
        .map_err(|e| format!("run canonical runtime advertisement: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let mut refs = BTreeMap::new();
    for line in String::from_utf8(out.stdout)
        .map_err(|e| e.to_string())?
        .lines()
    {
        let (oid, found_ref) = line
            .split_once('\t')
            .ok_or_else(|| format!("malformed canonical runtime advertisement: {line}"))?;
        model::oid(oid)?;
        if found_ref != reference || refs.insert(found_ref.into(), oid.into()).is_some() {
            return Err("canonical runtime advertisement was not exactly the requested ref".into());
        }
    }
    Ok(refs)
}

pub(crate) fn validate(commit: &str) -> Result<()> {
    let reference = runtime_ref(commit)?;
    let refs = advertise(&reference)?;
    if refs.len() == 1 && refs.get(&reference).map(String::as_str) == Some(commit) {
        Ok(())
    } else {
        Err(format!(
            "canonical runtime publication for {CANONICAL_IDENTITY} at {reference} is absent or does not equal {commit}"
        ))
    }
}

pub(crate) fn publish(commit: &str) -> Result<()> {
    model::oid(commit)?;
    crate::git::output(["cat-file", "-e", &format!("{commit}^{{commit}}")])
        .map_err(|_| "runtime publication commit must exist locally as a commit")?;
    let reference = runtime_ref(commit)?;
    let before = advertise(&reference)?;
    if let Some(observed) = before.get(&reference) {
        return if observed == commit {
            Ok(())
        } else {
            Err("immutable canonical runtime ref has conflicting content".into())
        };
    }
    let push = Command::new("git")
        .args(["push", "--porcelain"])
        .arg(format!("--force-with-lease={reference}:"))
        .arg(remote())
        .arg(format!("{commit}:{reference}"))
        .output()
        .map_err(|e| format!("publish canonical runtime: {e}"))?;
    match validate(commit) {
        Ok(()) => Ok(()),
        Err(readback) if push.status.success() => Err(format!(
            "runtime publication reported success but readback failed: {readback}"
        )),
        Err(readback) => Err(format!(
            "runtime publication was rejected or indeterminate: {}; readback: {readback}",
            String::from_utf8_lossy(&push.stderr).trim()
        )),
    }
}
