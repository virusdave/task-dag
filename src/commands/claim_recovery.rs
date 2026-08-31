use super::{checked_identity, claim_token, timestamp};
use crate::{
    Result, git,
    model::{self, ClaimRecord, Update},
    receipts, repository, validators,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Authorization {
    claim_token: String,
    prior_state_oid: String,
    prior_owner: String,
    prior_operation_id: String,
    task_oid: String,
}

fn fd_file(fd: i32, write: bool) -> Result<File> {
    if fd < 3 {
        return Err("authorization and receipt FDs must be at least 3".into());
    }
    let path = format!("/proc/self/fd/{fd}");
    let file = if write {
        OpenOptions::new().write(true).open(path)
    } else {
        File::open(path)
    }
    .map_err(|e| format!("cannot open private FD {fd}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("cannot inspect private FD {fd}: {e}"))?;
    if !meta.is_file() || meta.mode() & 0o077 != 0 {
        return Err(
            "authorization and receipt FDs must reference owner-private regular files".into(),
        );
    }
    Ok(file)
}

fn read_authorization(file: &mut File) -> Result<Authorization> {
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read authorization FD: {e}"))?;
    if bytes.len() > 16_384 {
        return Err("authorization exceeds 16384 bytes".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("authorization is malformed: {e}").into())
}

fn write_receipt(file: &mut File, value: &Value) -> Result<()> {
    file.set_len(0)
        .map_err(|e| format!("cannot truncate receipt FD: {e}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("cannot seek receipt FD: {e}"))?;
    serde_json::to_writer(&mut *file, value)
        .map_err(|e| format!("cannot write receipt FD: {e}"))?;
    file.write_all(b"\n")
        .map_err(|e| format!("cannot finish receipt FD: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("cannot sync receipt FD: {e}").into())
}

fn exact_prior(value: Value, auth: &Authorization, id: &str) -> Result<ClaimRecord> {
    if value["operationId"] != auth.prior_operation_id {
        return Err("authorization prior operation does not match the prior claim".into());
    }
    let claim: ClaimRecord =
        serde_json::from_value(value).map_err(|e| format!("prior active claim malformed: {e}"))?;
    if claim.claim_token != auth.claim_token
        || claim.owner != auth.prior_owner
        || claim.task_id != id
        || claim.task_oid != auth.task_oid
    {
        return Err("authorization does not identify the exact prior claim".into());
    }
    model::oid(&auth.prior_state_oid)?;
    model::oid(&auth.task_oid)?;
    Ok(claim)
}

pub(crate) fn recover(
    id: &str,
    owner: &str,
    ttl: u64,
    operation: &str,
    authorization_fd: i32,
    receipt_fd: i32,
) -> Result<()> {
    model::valid_id(id)?;
    model::bounded("operation-id", operation, 256)?;
    if ttl == 0 || ttl > 168 {
        return Err("ttl-hours must be between 1 and 168".into());
    }
    let mut auth_file = fd_file(authorization_fd, false)?;
    let mut receipt_file = fd_file(receipt_fd, true)?;
    let auth_meta = auth_file
        .metadata()
        .map_err(|e| format!("cannot inspect authorization FD: {e}"))?;
    let receipt_meta = receipt_file
        .metadata()
        .map_err(|e| format!("cannot inspect receipt FD: {e}"))?;
    if auth_meta.dev() == receipt_meta.dev() && auth_meta.ino() == receipt_meta.ino() {
        return Err("authorization and receipt FDs must reference different files".into());
    }
    let auth = read_authorization(&mut auth_file)?;
    model::bounded("prior operation-id", &auth.prior_operation_id, 256)?;
    let semantic = model::framed_digest(
        "recover-claim-semantics",
        &[
            id,
            owner,
            &ttl.to_string(),
            operation,
            &auth.prior_state_oid,
            &auth.prior_owner,
            &auth.prior_operation_id,
            &auth.task_oid,
            &model::digest(&auth.claim_token),
        ],
    );
    if let Some(outputs) = receipts::replay("recover-claim", operation, &semantic)? {
        write_receipt(&mut receipt_file, &outputs)?;
        return super::print_json(
            &json!({"owner":outputs["owner"],"recovered":true,"stateOid":outputs["stateOid"],"taskId":id}),
        );
    }
    let (host, session_id) = checked_identity(owner)?;
    let first = repository::task_snapshot(id, vec![])?;
    repository::materialize_lifecycle(&first, &[id.into()])?;
    let state_oid = model::lifecycle(&first, id)
        .first()
        .ok_or("task has no lifecycle state")?
        .2
        .clone();
    let task_oid = git::lifecycle_task(&state_oid)?;
    let task = git::object_json(&task_oid)?;
    let reqs = task["requirements"]
        .as_array()
        .ok_or("Task has no requirements array")?;
    let mut patterns = repository::lifecycle_patterns(id);
    for req in reqs {
        if let Some(dep) = req["taskId"].as_str() {
            patterns.extend(repository::lifecycle_patterns(dep));
        }
    }
    let snap = repository::checked_snapshot(patterns)?;
    let active_ref = model::state_ref("active", id);
    let frontier_ref = model::state_ref("frontier", id);
    let (old_ref, old, prior) = if let Some(active) = snap.refs.get(&active_ref) {
        repository::exclusive(&snap, id, "active")?;
        if active != &auth.prior_state_oid {
            return Err("active task is not the authorized prior generation".into());
        }
        repository::materialize(std::slice::from_ref(active))?;
        (
            active_ref.clone(),
            active.clone(),
            exact_prior(validators::lifecycle("active", active, id)?, &auth, id)?,
        )
    } else if let Some(frontier) = snap.refs.get(&frontier_ref) {
        repository::exclusive(&snap, id, "frontier")?;
        repository::materialize(std::slice::from_ref(frontier))?;
        let released = validators::lifecycle("frontier", frontier, id)?;
        if released["releaseKind"] != "reap" || released["releasedClaim"] != auth.prior_state_oid {
            return Err("frontier was not produced by reaping the authorized prior claim".into());
        }
        if git::parents(frontier)?.first() != Some(&auth.prior_state_oid) {
            return Err(
                "reaped frontier does not descend directly from the authorized prior claim".into(),
            );
        }
        repository::materialize(std::slice::from_ref(&auth.prior_state_oid))?;
        let prior = exact_prior(
            validators::lifecycle("active", &auth.prior_state_oid, id)?,
            &auth,
            id,
        )?;
        let task = git::object_json(&prior.task_oid)?;
        let reqs = task["requirements"]
            .as_array()
            .ok_or("Task has no requirements array")?;
        model::readiness(&snap, reqs)?;
        (frontier_ref.clone(), frontier.clone(), prior)
    } else {
        return Err("task is not the authorized active claim or its reaped frontier".into());
    };
    let now = timestamp()?;
    let expires = now
        .checked_add(ttl.checked_mul(3600).ok_or("ttl overflow")?)
        .ok_or("ttl overflow")?;
    let token = claim_token()?;
    let logical = model::framed_digest("recover-claim-logical", &[id, owner, operation]);
    let record = json!({"attemptId":model::framed_digest("recover-claim-attempt", &[&logical,&now.to_string(),&token]),
        "claimToken":token,"claimedAt":now,"expiresAt":expires,"formatVersion":2,"host":host,"logicalId":logical,
        "operationId":operation,"owner":owner,"sessionId":session_id,"taskId":id,"taskOid":prior.task_oid});
    let new = git::commit(&record, &[old.clone(), prior.task_oid])?;
    let result =
        json!({"claimToken":token,"expiresAt":expires,"owner":owner,"stateOid":new,"taskId":id});
    let (receipt_ref, receipt_oid) = receipts::create(
        "recover-claim",
        operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&new),
    )?;
    let mut updates = if old_ref == active_ref {
        vec![Update {
            semantic_ref: active_ref,
            old: Some(old),
            new: Some(new.clone()),
        }]
    } else {
        vec![
            Update {
                semantic_ref: old_ref,
                old: Some(old),
                new: None,
            },
            Update {
                semantic_ref: active_ref,
                old: None,
                new: Some(new.clone()),
            },
        ]
    };
    updates.push(Update {
        semantic_ref: receipt_ref,
        old: None,
        new: Some(receipt_oid),
    });
    repository::mutate(model::canonical_updates(updates))?;
    write_receipt(&mut receipt_file, &result)?;
    super::print_json(&json!({"owner":owner,"recovered":true,"stateOid":new,"taskId":id}))
}
