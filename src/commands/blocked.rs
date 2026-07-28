use crate::{
    Result, git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    receipts, repository,
};
use serde_json::{Value, json};

pub(crate) fn block(
    id: &str,
    token: &str,
    reason: &str,
    authorization: &str,
    operation: &str,
) -> Result<()> {
    model::valid_id(id)?;
    model::bounded("block reason", reason, 16_384)?;
    model::bounded("block authorization", authorization, 4_096)?;
    model::bounded("operation-id", operation, 256)?;
    let semantic = model::framed_digest("block-semantics", &[id, token, reason, authorization]);
    if let Some(output) = receipts::replay("block", operation, &semantic)? {
        return super::print_json(&output);
    }
    let snap = repository::task_snapshot(id, vec![])?;
    repository::exclusive(&snap, id, "active")?;
    let active_ref = model::state_ref("active", id);
    let active = snap.refs[&active_ref].clone();
    let claim = model::validate_claim(git::object_json(&active)?, token, id, super::timestamp()?)?;
    let record = json!({"authorization":authorization,"blockedAt":super::timestamp()?,"claimTokenDigest":model::digest(token),"formatVersion":2,"operationId":operation,"reason":reason,"taskId":id,"taskOid":claim.task_oid});
    let blocked = git::commit(&record, &[active.clone(), claim.task_oid])?;
    transition(
        &snap,
        "block",
        operation,
        &semantic,
        (active_ref, active),
        (model::state_ref("blocked", id), blocked.clone()),
        json!({"blockLease":blocked,"taskId":id}),
    )
}

pub(crate) fn unblock(id: &str, lease: &str, authorization: &str, operation: &str) -> Result<()> {
    model::valid_id(id)?;
    model::oid(lease)?;
    model::bounded("unblock authorization", authorization, 4_096)?;
    model::bounded("operation-id", operation, 256)?;
    let semantic = model::framed_digest("unblock-semantics", &[id, lease, authorization]);
    if let Some(output) = receipts::replay("unblock", operation, &semantic)? {
        return super::print_json(&output);
    }
    let first = repository::task_snapshot(id, vec![])?;
    repository::exclusive(&first, id, "blocked")?;
    let blocked_ref = model::state_ref("blocked", id);
    if first.refs[&blocked_ref] != lease {
        return Err("block lease does not match authoritative blocked ref".into());
    }
    let blocked_value = git::object_json(lease)?;
    let task = blocked_value["taskOid"]
        .as_str()
        .ok_or("blocked taskOid malformed")?
        .to_owned();
    let task_value = crate::validators::task(&task, id)?;
    let reqs = task_value["requirements"]
        .as_array()
        .ok_or("Task requirements malformed")?;
    let mut patterns = repository::lifecycle_patterns(id);
    for req in reqs {
        patterns.extend(repository::lifecycle_patterns(
            req["taskId"]
                .as_str()
                .ok_or("requirement taskId malformed")?,
        ));
    }
    let snap = repository::checked_snapshot(patterns)?;
    repository::exclusive(&snap, id, "blocked")?;
    if snap.refs[&blocked_ref] != lease {
        return Err("block lease changed during readiness check".into());
    }
    model::readiness(&snap, reqs)?;
    let record = json!({"formatVersion":2,"logicalId":model::framed_digest("unblock-logical", &[id,lease,authorization,operation]),"operationId":operation,"releasedBlock":lease,"taskId":id,"taskOid":task});
    let frontier = git::commit(&record, &[lease.into(), task])?;
    transition(
        &snap,
        "unblock",
        operation,
        &semantic,
        (blocked_ref, lease.into()),
        (model::state_ref("frontier", id), frontier),
        json!({"taskId":id}),
    )
}

fn transition(
    snap: &repository::Snapshot,
    domain: &str,
    operation: &str,
    semantic: &str,
    old_state: (String, String),
    new_state: (String, String),
    output: Value,
) -> Result<()> {
    let (old_ref, old) = old_state;
    let (new_ref, new) = new_state;
    let (receipt_ref, receipt_oid) = receipts::create(
        domain,
        operation,
        semantic,
        output.clone(),
        std::slice::from_ref(&new),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: old_ref,
            old: Some(old),
            new: None,
        },
        Update {
            semantic_ref: new_ref.clone(),
            old: None,
            new: Some(new.clone()),
        },
        Update {
            semantic_ref: receipt_ref.clone(),
            old: None,
            new: Some(receipt_oid.clone()),
        },
    ]);
    let journal = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        snap.refs.get(ACTIVATION).unwrap(),
        operation,
        &updates,
        &[(new_ref, new), (receipt_ref, receipt_oid)],
    )?;
    repository::mutate(snap, updates, &journal)?;
    super::print_json(&output)
}
