use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

use crate::{Result, model::oid};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub(crate) fn commit(value: &Value, parents: &[String]) -> Result<String> {
    let message = serde_json::to_string(value).map_err(|e| e.to_string())?;
    commit_with_tree(EMPTY_TREE, &message, parents)
}

/// Migration Tasks are content-addressed legacy identities, not invocation
/// records.  Pin their Git identity so a later root migration computes the
/// exact same object for a cross-root requirement.
pub(crate) fn migration_task_commit(value: &Value, parents: &[String]) -> Result<String> {
    let message = serde_json::to_string(value).map_err(|e| e.to_string())?;
    commit_tree(
        EMPTY_TREE,
        &message,
        parents,
        Some("Thu, 01 Jan 1970 00:00:00 +0000"),
    )
}

pub(crate) fn commit_with_tree(tree: &str, message: &str, parents: &[String]) -> Result<String> {
    commit_tree(tree, message, parents, None)
}

fn commit_tree(
    tree: &str,
    message: &str,
    parents: &[String],
    fixed_date: Option<&str>,
) -> Result<String> {
    oid(tree)?;
    let mut cmd = Command::new("git");
    cmd.args(["commit-tree", tree]);
    for p in parents {
        oid(p)?;
        cmd.args(["-p", p]);
    }
    cmd.env("GIT_AUTHOR_NAME", "task-dag")
        .env("GIT_AUTHOR_EMAIL", "task-dag@localhost")
        .env("GIT_COMMITTER_NAME", "task-dag")
        .env("GIT_COMMITTER_EMAIL", "task-dag@localhost")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(date) = fixed_date {
        cmd.env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .env("GIT_AUTHOR_NAME", "task-dag v1 migration")
            .env("GIT_AUTHOR_EMAIL", "task-dag-v1-migration@localhost")
            .env("GIT_COMMITTER_NAME", "task-dag v1 migration")
            .env("GIT_COMMITTER_EMAIL", "task-dag-v1-migration@localhost");
    }
    let mut child = cmd.spawn().map_err(|e| format!("run commit-tree: {e}"))?;
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(message.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let result = String::from_utf8(out.stdout)
        .map_err(|e| e.to_string())?
        .trim()
        .to_owned();
    oid(&result)?;
    Ok(result)
}
pub(crate) fn object_json(object: &str) -> Result<Value> {
    serde_json::from_str(output(["show", "-s", "--format=%B", object])?.trim())
        .map_err(|e| format!("object {object} is not canonical JSON: {e}"))
}
pub(crate) fn first_parent(object: &str) -> Result<String> {
    parents(object)?
        .into_iter()
        .next()
        .ok_or_else(|| format!("object {object} has no first parent"))
}
pub(crate) fn parents(object: &str) -> Result<Vec<String>> {
    oid(object)?;
    output(["cat-file", "-p", object])?
        .lines()
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.strip_prefix("parent ").map(str::to_owned))
        .collect::<Vec<_>>()
        .into_iter()
        .map(|parent| {
            oid(&parent)?;
            Ok(parent)
        })
        .collect()
}
pub(crate) fn lifecycle_task(state: &str) -> Result<String> {
    object_json(state)?["taskOid"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("lifecycle object {state} has no taskOid"))
}
pub(crate) fn output<const N: usize>(args: [&str; N]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}
