use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    io::{self, Read},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::{Result, git, model};

const MAX_STREAM: usize = 262_144;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistryEntry {
    task_id: String,
    owner: String,
    host: String,
    session_id: String,
    claim_token: String,
}

struct SnapshotEntry {
    path: PathBuf,
    identity: (u64, u64),
    value: RegistryEntry,
}

pub(crate) fn commit_message(stdin: bool, path: Option<&Path>) -> Result<()> {
    let mut bytes = Vec::new();
    if stdin {
        io::stdin()
            .take((MAX_STREAM + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    } else {
        let path = path.ok_or("guard-commit-message requires MESSAGE_FILE or --stdin")?;
        File::open(path)
            .map_err(|e| format!("open commit message: {e}"))?
            .take((MAX_STREAM + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read commit message: {e}"))?;
    }
    if bytes.len() > MAX_STREAM {
        return Err("commit message exceeds 262144 bytes".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "commit message is not UTF-8")?;
    let comment = git::bounded_output(&["config", "--get", "core.commentChar"], 4096)
        .ok()
        .filter(|v| v.chars().count() == 1)
        .and_then(|v| v.chars().next())
        .unwrap_or('#');
    let clean = text
        .lines()
        .filter(|line| !line.starts_with(comment))
        .collect::<Vec<_>>()
        .join("\n");
    let subject = clean
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let generated = subject.starts_with("Merge ") || subject.starts_with("Revert \"");
    if !generated && let Some(colon) = subject.find(": ") {
        let prefix = &subject[..colon];
        if !prefix.contains(' ')
            && prefix
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"()-_!".contains(&b))
        {
            return Err("Conventional-Commits/type-prefixed subjects are forbidden".into());
        }
    }
    if clean
        .lines()
        .any(|line| line.contains("refs/heads/tasks/") || line.contains("refs/heads/gh/"))
    {
        return Err("hand-written task-dag control refs are forbidden".into());
    }
    if let Ok(value) = serde_json::from_str::<Value>(clean.trim())
        && value.as_object().is_some_and(|o| {
            o.get("formatVersion") == Some(&Value::from(2))
                || o.keys().any(|k| {
                    matches!(
                        k.as_str(),
                        "taskId" | "taskOid" | "claimToken" | "operationId"
                    )
                })
        })
    {
        return Err("hand-written task-dag v2 semantic JSON is forbidden".into());
    }
    Ok(())
}

pub(crate) fn pre_push(remote_name: Option<&str>, remote_url: Option<&str>) -> Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_STREAM + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > MAX_STREAM {
        return Err("pre-push update stream exceeds byte limit".into());
    }
    run_repository_hook(remote_name, remote_url, &input)?;
    if remote_name.is_some_and(|name| name != "origin") {
        return Ok(());
    }
    let text = String::from_utf8(input).map_err(|_| "pre-push update stream is not UTF-8")?;
    let lines: Vec<_> = text.lines().collect();
    if lines.len() > 256 {
        return Err("pre-push update stream exceeds line limit".into());
    }
    let mut raw_master = false;
    for line in lines {
        let fields: Vec<_> = line.split(' ').collect();
        let local_is_zero = fields
            .get(1)
            .is_some_and(|value| value.bytes().all(|b| b == b'0'));
        if fields.len() != 4
            || !oid(fields[1])
            || (local_is_zero != (fields[0] == "(delete)"))
            || (!local_is_zero
                && fields[0] != fields[1]
                && fields[0] != "HEAD"
                && !fields[0].starts_with("refs/"))
            || !fields[2].starts_with("refs/")
            || !oid(fields[3])
        {
            return Err("malformed pre-push update stream".into());
        }
        raw_master |= fields[2] == "refs/heads/master" && fields[1].bytes().any(|b| b != b'0');
    }
    if !raw_master || std::env::var_os("TASKDAG_NATIVE_MUTATION").is_some() {
        return Ok(());
    }
    native_claim_guard()
}

fn run_repository_hook(
    remote_name: Option<&str>,
    remote_url: Option<&str>,
    input: &[u8],
) -> Result<()> {
    let hook = Path::new(".githooks/pre-push.repository");
    let metadata = match fs::symlink_metadata(hook) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("inspect pre-push.repository: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o7777 != 0o755
    {
        return Err(
            "pre-push.repository must be a regular non-symlink file with exact mode 0755".into(),
        );
    }
    let mut child = Command::new(hook)
        .args(remote_name.into_iter().chain(remote_url))
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run pre-push.repository: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("open pre-push.repository stdin")?;
    let write_result = stdin.write_all(input);
    drop(stdin);
    let status = child
        .wait()
        .map_err(|e| format!("wait for pre-push.repository: {e}"))?;
    if !status.success() {
        return Err(format!("pre-push.repository rejected push with {status}"));
    }
    if let Err(error) = write_result
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        return Err(format!("write pre-push.repository stdin: {error}"));
    }
    Ok(())
}

fn native_claim_guard() -> Result<()> {
    let _registry_lock = crate::repository::native_claim_registry_lock(true)?;
    let registry = PathBuf::from(git::bounded_output(
        &["rev-parse", "--git-path", "task-dag/native-claims"],
        4096,
    )?);
    if !registry.exists() {
        return Ok(());
    }
    if !registry.is_dir() {
        return Err("native claim registry is not a directory (fail closed)".into());
    }
    let mut snapshots = Vec::new();
    let mut total = 0usize;
    for item in
        fs::read_dir(&registry).map_err(|e| format!("enumerate native claim registry: {e}"))?
    {
        if snapshots.len() >= 128 {
            return Err("native claim registry exceeds entry limit".into());
        }
        let item = item.map_err(|e| format!("enumerate native claim registry: {e}"))?;
        let path = item.path();
        let before = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !before.file_type().is_file() {
            return Err("native claim registry contains a non-regular entry".into());
        }
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "native claim filename is not UTF-8")?;
        let (id, digest) = parse_registry_name(&name)?;
        let size = usize::try_from(before.len()).map_err(|_| "native claim size overflow")?;
        total = total
            .checked_add(size)
            .ok_or("native claim byte count overflow")?;
        if size > 4096 || total > MAX_STREAM {
            return Err("native claim registry exceeds byte limit".into());
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .map_err(|e| format!("open native claim: {e}"))?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read native claim: {e}"))?;
        if bytes.len() > 4096 {
            return Err("native claim registry exceeds byte limit".into());
        }
        let after = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if (before.dev(), before.ino(), before.len()) != (after.dev(), after.ino(), after.len())
            || bytes.len() != size
        {
            return Err("native claim changed while snapshotting (fail closed)".into());
        }
        let value: RegistryEntry = serde_json::from_slice(&bytes)
            .map_err(|e| format!("malformed native claim registry entry: {e}"))?;
        validate_registry(&value, id)?;
        if format!("{:x}", Sha256::digest(value.claim_token.as_bytes())) != digest {
            return Err("native claim registry digest mismatch".into());
        }
        snapshots.push(SnapshotEntry {
            path,
            identity: (before.dev(), before.ino()),
            value,
        });
    }
    if snapshots.is_empty() {
        return Ok(());
    }
    let refs: Vec<_> = snapshots
        .iter()
        .map(|e| format!("refs/heads/tasks/active/{}", e.value.task_id))
        .collect();
    let args: Vec<_> = std::iter::once("ls-remote")
        .chain(["--refs", "--", "origin"])
        .chain(refs.iter().map(String::as_str))
        .collect();
    let advertised = git::bounded_output(&args, MAX_STREAM)?;
    if advertised.lines().count() > 128 {
        return Err("native claim advertisement exceeds line limit".into());
    }
    let wanted: BTreeSet<_> = refs.iter().cloned().collect();
    let mut remote = BTreeMap::new();
    for line in advertised.lines() {
        let (object, reference) = line
            .split_once('\t')
            .ok_or("malformed native claim advertisement")?;
        if !oid(object)
            || !wanted.contains(reference)
            || remote
                .insert(reference.to_owned(), object.to_owned())
                .is_some()
        {
            return Err("malformed native claim advertisement".into());
        }
    }
    let objects: Vec<_> = remote.values().cloned().collect();
    if !objects.is_empty() {
        let mut args = vec![
            "fetch",
            "--no-tags",
            "--quiet",
            "--no-write-fetch-head",
            "--filter=blob:limit=8192",
            "--",
            "origin",
        ];
        args.extend(objects.iter().map(String::as_str));
        git::bounded_output(&args, 4096)?;
    }
    let mut matched = false;
    for entry in snapshots {
        let reference = format!("refs/heads/tasks/active/{}", entry.value.task_id);
        let Some(object) = remote.get(&reference) else {
            safe_remove(&entry);
            continue;
        };
        let info = git::bounded_output(&["cat-file", "-t", object], 64)?;
        let size: usize = git::bounded_output(&["cat-file", "-s", object], 64)?
            .parse()
            .map_err(|_| "malformed native claim object size")?;
        if info != "commit" || size > 8192 {
            return Err("advertised native claim is invalid or oversized".into());
        }
        let message = git::bounded_output(&["show", "-s", "--format=%B", object], 8192)?;
        let active: Value = serde_json::from_str(&message)
            .map_err(|e| format!("matched remote active claim is malformed: {e}"))?;
        validate_active(&active, &entry.value.task_id)?;
        if active["taskId"] == entry.value.task_id
            && active["claimToken"] == entry.value.claim_token
            && active["owner"] == entry.value.owner
            && active["host"] == entry.value.host
            && active["sessionId"] == entry.value.session_id
        {
            matched = true;
        } else {
            safe_remove(&entry);
        }
    }
    if matched {
        Err("refusing raw origin/master push while a matching native-v2 claim is active; use the canonical task-dag transition".into())
    } else {
        Ok(())
    }
}

fn validate_registry(v: &RegistryEntry, id: &str) -> Result<()> {
    if v.task_id != id {
        return Err("native claim task ID disagrees with filename".into());
    }
    for (name, value) in [
        ("task ID", &v.task_id),
        ("owner", &v.owner),
        ("host", &v.host),
        ("session", &v.session_id),
        ("claim token", &v.claim_token),
    ] {
        strict_bounded(name, value)?;
    }
    Ok(())
}

fn validate_active(v: &Value, id: &str) -> Result<()> {
    let object = v.as_object().ok_or("active claim must be an object")?;
    let allowed = [
        "attemptId",
        "claimToken",
        "claimedAt",
        "expiresAt",
        "formatVersion",
        "host",
        "logicalId",
        "operationId",
        "owner",
        "reclaimRequired",
        "semanticId",
        "sessionId",
        "taskId",
        "taskOid",
    ];
    let required = [
        "attemptId",
        "claimToken",
        "claimedAt",
        "expiresAt",
        "formatVersion",
        "host",
        "logicalId",
        "owner",
        "sessionId",
        "taskId",
        "taskOid",
    ];
    let optional: BTreeSet<_> = object
        .keys()
        .filter(|k| !required.contains(&k.as_str()))
        .map(String::as_str)
        .collect();
    let valid_optional = optional.is_empty()
        || optional == BTreeSet::from(["operationId"])
        || optional == BTreeSet::from(["semanticId"])
        || optional == BTreeSet::from(["operationId", "semanticId"])
        || optional == BTreeSet::from(["operationId", "reclaimRequired"]);
    if object.keys().any(|k| !allowed.contains(&k.as_str()))
        || required.iter().any(|k| !object.contains_key(*k))
        || !valid_optional
        || v["formatVersion"] != 2
        || v["taskId"] != id
    {
        return Err("matched remote active claim has invalid schema".into());
    }
    for key in [
        "attemptId",
        "claimToken",
        "host",
        "logicalId",
        "owner",
        "sessionId",
        "taskId",
    ] {
        strict_bounded(
            key,
            v[key]
                .as_str()
                .ok_or("active claim string field malformed")?,
        )?;
    }
    if !hex(v["attemptId"].as_str().unwrap(), 64)
        || !hex(v["logicalId"].as_str().unwrap(), 64)
        || !oid(v["taskOid"].as_str().ok_or("active task OID malformed")?)
    {
        return Err("matched remote active claim digest malformed".into());
    }
    let claimed = v["claimedAt"]
        .as_u64()
        .ok_or("active claimedAt malformed")?;
    if v["expiresAt"]
        .as_u64()
        .is_none_or(|expires| expires < claimed)
    {
        return Err("active expiresAt malformed".into());
    }
    if object.get("operationId").is_some_and(|x| {
        x.as_str()
            .is_none_or(|s| strict_bounded("operation ID", s).is_err())
    }) || object
        .get("semanticId")
        .is_some_and(|x| x.as_str().is_none_or(|s| !hex(s, 64)))
        || object
            .get("reclaimRequired")
            .is_some_and(|x| !x.is_boolean())
    {
        return Err("matched remote active claim optional field malformed".into());
    }
    Ok(())
}

fn safe_remove(entry: &SnapshotEntry) {
    if fs::symlink_metadata(&entry.path)
        .ok()
        .is_some_and(|m| (m.dev(), m.ino()) == entry.identity)
    {
        let _ = fs::remove_file(&entry.path);
    }
}
fn strict_bounded(name: &str, value: &str) -> Result<()> {
    model::bounded(name, value, 256)?;
    if value.chars().any(char::is_control) {
        Err(format!("{name} contains a control character"))
    } else {
        Ok(())
    }
}
fn parse_registry_name(name: &str) -> Result<(&str, &str)> {
    let (id, digest) = name
        .split_once('.')
        .ok_or("malformed native claim registry filename")?;
    if !id.starts_with("v2-") || !hex(&id[3..], 64) || !hex(digest, 64) {
        return Err("malformed native claim registry filename".into());
    }
    Ok((id, digest))
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn oid(value: &str) -> bool {
    hex(value, 40)
}
