use super::{checked_identity, claim_token, print_json, timestamp};
use crate::{
    Result, git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    receipts, repository,
};
use serde_json::{Value, json};

pub(crate) fn claim(id: &str, owner: &str, ttl: u64, operation: &str) -> Result<()> {
    model::valid_id(id)?;
    model::bounded("operation-id", operation, 256)?;
    if ttl == 0 || ttl > 168 {
        return Err("ttl-hours must be between 1 and 168".into());
    }
    let semantic =
        model::framed_digest("claim-semantics", &[id, owner, &ttl.to_string(), operation]);
    if let Some(outputs) = receipts::replay("claim", operation, &semantic)? {
        return print_json(&outputs);
    }
    let (host, session_id) = checked_identity(owner)?;
    let first = repository::task_snapshot(id, vec![])?;
    repository::materialize_lifecycle(&first, &[id.into()])?;
    let requirements = model::lifecycle(&first, id)
        .first()
        .map(|x| git::lifecycle_task(&x.2))
        .transpose()?
        .map(|task| git::object_json(&task))
        .transpose()?
        .and_then(|v| v["requirements"].as_array().cloned())
        .unwrap_or_default();
    let mut patterns = repository::lifecycle_patterns(id);
    for req in &requirements {
        if let Some(dep) = req["taskId"].as_str() {
            patterns.extend(repository::lifecycle_patterns(dep));
        }
    }
    let snap = repository::checked_snapshot(patterns)?;
    let active_ref = model::state_ref("active", id);
    if let Some(active) = snap.refs.get(&active_ref) {
        repository::materialize(std::slice::from_ref(active))?;
        let value = git::object_json(active)?;
        if value["semanticId"] == semantic {
            return print_json(
                &json!({"claimToken":value["claimToken"],"expiresAt":value["expiresAt"],"owner":owner,"stateOid":active,"taskId":id}),
            );
        }
    }
    repository::exclusive(&snap, id, "frontier")?;
    let old_ref = model::state_ref("frontier", id);
    let old = snap.refs[&old_ref].clone();
    repository::materialize(std::slice::from_ref(&old))?;
    let task = git::lifecycle_task(&old)?;
    let value = git::object_json(&task)?;
    let reqs = value
        .get("requirements")
        .and_then(Value::as_array)
        .ok_or("Task has no requirements array")?;
    model::readiness(&snap, reqs)?;
    let now = timestamp()?;
    let logical = model::framed_digest("claim-logical", &["claim", id, owner, operation]);
    let token = claim_token()?;
    let expires = now
        .checked_add(ttl.checked_mul(3600).ok_or("ttl overflow")?)
        .ok_or("ttl overflow")?;
    let record = json!({"attemptId":model::framed_digest("claim-attempt", &[&logical,&now.to_string(),&token]),"claimToken":token,"claimedAt":now,"expiresAt":expires,"formatVersion":2,"host":host,"logicalId":logical,"operationId":operation,"semanticId":semantic,"owner":owner,"sessionId":session_id,"taskId":id,"taskOid":task});
    let new = git::commit(&record, &[old.clone(), task])?;
    let result =
        json!({"claimToken":token,"expiresAt":expires,"owner":owner,"stateOid":new,"taskId":id});
    let (receipt_ref, receipt_oid) = receipts::create(
        "claim",
        operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&new),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: old_ref,
            old: Some(old),
            new: None,
        },
        Update {
            semantic_ref: active_ref.clone(),
            old: None,
            new: Some(new.clone()),
        },
        Update {
            semantic_ref: receipt_ref.clone(),
            old: None,
            new: Some(receipt_oid.clone()),
        },
    ]);
    let j = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        snap.refs.get(ACTIVATION).unwrap(),
        &logical,
        &updates,
        &[(active_ref, new), (receipt_ref, receipt_oid)],
    )?;
    repository::mutate(&snap, updates, &j)?;
    print_json(&result)
}
