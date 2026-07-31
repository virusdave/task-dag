use serde_json::Value;
use std::process::{Command, Stdio};
use std::{cell::RefCell, collections::BTreeMap, io::Write};

use crate::{Result, model, model::oid};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

thread_local! {
    static OBJECTS: RefCell<BTreeMap<String, Vec<u8>>> = const { RefCell::new(BTreeMap::new()) };
}

fn batch(args: &[&str], objects: &[String]) -> Result<Vec<u8>> {
    let mut child = Command::new("git")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run git {}: {e}", args.join(" ")))?;
    {
        let stdin = child.stdin.as_mut().ok_or("open git batch stdin")?;
        for object in objects {
            oid(object)?;
            writeln!(stdin, "{object}").map_err(|e| format!("write git batch input: {e}"))?;
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("wait for git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    Ok(out.stdout)
}

/// Return the exact object type for each requested OID, or `None` when it is
/// absent. Git's batch protocol keeps this bounded operation to one process.
pub(crate) fn batch_object_types(objects: &[String]) -> Result<BTreeMap<String, Option<String>>> {
    let output = batch(&["cat-file", "--batch-check"], objects)?;
    let text = String::from_utf8(output).map_err(|e| e.to_string())?;
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != objects.len() {
        return Err("git batch-check response cardinality disagrees".into());
    }
    objects
        .iter()
        .zip(lines)
        .map(|(requested, line)| {
            let mut fields = line.split_ascii_whitespace();
            if fields.next() != Some(requested.as_str()) {
                return Err("git batch-check returned an unexpected object".into());
            }
            let kind = fields.next().ok_or("git batch-check response malformed")?;
            let value = if kind == "missing" {
                if fields.next().is_some() {
                    return Err("git batch-check missing response malformed".into());
                }
                None
            } else {
                model::bounded("Git object type", kind, 64)?;
                fields
                    .next()
                    .ok_or("git batch-check object size absent")?
                    .parse::<usize>()
                    .map_err(|_| "git batch-check object size malformed")?;
                if fields.next().is_some() {
                    return Err("git batch-check response has extra fields".into());
                }
                Some(kind.to_owned())
            };
            Ok((requested.clone(), value))
        })
        .collect()
}

/// Read and cache commit bytes using Git's length-delimited batch protocol.
pub(crate) fn cache_commit_objects(objects: &[String]) -> Result<()> {
    let missing: Vec<_> = OBJECTS.with(|cache| {
        let cache = cache.borrow();
        objects
            .iter()
            .filter(|object| !cache.contains_key(*object))
            .cloned()
            .collect()
    });
    if missing.is_empty() {
        return Ok(());
    }
    let output = batch(&["cat-file", "--batch"], &missing)?;
    let mut offset = 0;
    let mut loaded = Vec::with_capacity(missing.len());
    for requested in &missing {
        let relative_end = output[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or("git batch object header is unterminated")?;
        let header_end = offset + relative_end;
        let header = std::str::from_utf8(&output[offset..header_end]).map_err(|e| e.to_string())?;
        let mut fields = header.split_ascii_whitespace();
        if fields.next() != Some(requested.as_str()) || fields.next() != Some("commit") {
            return Err("git batch returned an unexpected or non-commit object".into());
        }
        let size = fields
            .next()
            .ok_or("git batch object size absent")?
            .parse::<usize>()
            .map_err(|_| "git batch object size malformed")?;
        if fields.next().is_some() {
            return Err("git batch object header has extra fields".into());
        }
        let content_start = header_end + 1;
        let content_end = content_start
            .checked_add(size)
            .ok_or("git batch object size overflow")?;
        if content_end >= output.len() || output[content_end] != b'\n' {
            return Err("git batch object payload length disagrees".into());
        }
        loaded.push((
            requested.clone(),
            output[content_start..content_end].to_vec(),
        ));
        offset = content_end + 1;
    }
    if offset != output.len() {
        return Err("git batch returned trailing data".into());
    }
    OBJECTS.with(|cache| cache.borrow_mut().extend(loaded));
    Ok(())
}

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
    oid(object)?;
    let cached = OBJECTS.with(|cache| cache.borrow().get(object).cloned());
    let message = if let Some(raw) = cached {
        let raw = String::from_utf8(raw).map_err(|e| e.to_string())?;
        raw.split_once("\n\n")
            .map(|(_, message)| message.to_owned())
            .ok_or_else(|| format!("commit object {object} has no message"))?
    } else {
        output(["show", "-s", "--format=%B", object])?
    };
    serde_json::from_str(message.trim())
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
    let cached = OBJECTS.with(|cache| cache.borrow().get(object).cloned());
    let raw = match cached {
        Some(raw) => String::from_utf8(raw).map_err(|e| e.to_string())?,
        None => output(["cat-file", "-p", object])?,
    };
    raw.lines()
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

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TrailerValues {
    pub(crate) occurrences: usize,
    pub(crate) values: Vec<String>,
}

pub(crate) fn trailer_values(object: &str, key: &str) -> Result<TrailerValues> {
    oid(object)?;
    model::bounded("trailer key", key, 256)?;
    let extract = |mode: &str| -> Result<Vec<u8>> {
        let format = format!("format:%(trailers:key={key},{mode},separator=%x00)");
        let out = Command::new("git")
            .args(["show", "-s", &format!("--format={format}"), object])
            .output()
            .map_err(|e| format!("run git trailer parser: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().into());
        }
        Ok(out.stdout)
    };
    // Count key-only records independently: value extraction alone cannot
    // distinguish an absent trailer from one trailer with an empty value.
    let keys = extract("keyonly")?;
    let occurrences = if keys.is_empty() {
        0
    } else {
        keys.split(|byte| *byte == 0).count()
    };
    let raw_values = extract("valueonly")?;
    let values = if occurrences == 0 {
        Vec::new()
    } else {
        let values = raw_values
            .split(|byte| *byte == 0)
            .map(|value| String::from_utf8(value.to_vec()).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>>>()?;
        if values.len() != occurrences {
            return Err("Git trailer key/value extraction cardinality disagrees".into());
        }
        values
    };
    Ok(TrailerValues {
        occurrences,
        values,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_object_protocol_distinguishes_commit_blob_and_missing() {
        let head = output(["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        let blob = {
            let mut child = Command::new("git")
                .args(["hash-object", "-w", "--stdin"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"batch-test")
                .unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .to_owned()
        };
        let absent = "0000000000000000000000000000000000000000".to_owned();
        let objects = vec![head.clone(), blob.clone(), absent.clone()];

        let types = batch_object_types(&objects).unwrap();
        assert_eq!(types[&head].as_deref(), Some("commit"));
        assert_eq!(types[&blob].as_deref(), Some("blob"));
        assert_eq!(types[&absent], None);

        let expected_parents: Vec<_> = output(["show", "-s", "--format=%P", &head])
            .unwrap()
            .split_ascii_whitespace()
            .map(str::to_owned)
            .collect();
        cache_commit_objects(&[head.clone()]).unwrap();
        assert_eq!(parents(&head).unwrap(), expected_parents);
        assert!(cache_commit_objects(&[blob]).is_err());
        assert!(cache_commit_objects(&[absent]).is_err());
    }
}
