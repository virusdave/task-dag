use crate::{
    Result, git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    receipts, repository,
};
use serde_json::json;

pub(crate) fn renew(id: &str, token: &str, ttl: u64, operation: &str) -> Result<()> {
    model::valid_id(id)?;
    model::bounded("operation-id", operation, 256)?;
    if ttl == 0 || ttl > 168 {
        return Err("ttl-hours must be between 1 and 168".into());
    }
    let semantic = model::framed_digest("renew-semantics", &[id, token, &ttl.to_string()]);
    if let Some(outputs) = receipts::replay("renew", operation, &semantic)? {
        return super::print_json(&outputs);
    }
    let snap = repository::task_snapshot(id, vec![])?;
    let logical = model::framed_digest("renew-logical", &[id, token, &ttl.to_string(), operation]);
    if let Some(active) = snap.refs.get(&model::state_ref("active", id)) {
        repository::materialize(std::slice::from_ref(active))?;
        let value = git::object_json(active)?;
        if value["logicalId"] == logical {
            return super::print_json(
                &json!({"claimToken":token,"expiresAt":value["expiresAt"],"taskId":id}),
            );
        }
    }
    repository::exclusive(&snap, id, "active")?;
    let r = model::state_ref("active", id);
    let old = snap.refs[&r].clone();
    repository::materialize(std::slice::from_ref(&old))?;
    let now = super::timestamp()?;
    let claim = model::validate_claim(git::object_json(&old)?, token, id, now)?;
    let expires = now
        .checked_add(ttl.checked_mul(3600).ok_or("ttl overflow")?)
        .ok_or("ttl overflow")?;
    let record = json!({"attemptId":logical,"claimToken":claim.claim_token,"claimedAt":claim.claimed_at,"expiresAt":expires,"formatVersion":2,"host":claim.host,"logicalId":logical,"operationId":logical,"owner":claim.owner,"sessionId":claim.session_id,"taskId":id,"taskOid":claim.task_oid});
    let new = git::commit(&record, &[old.clone(), claim.task_oid])?;
    let result = json!({"claimToken":token,"expiresAt":expires,"taskId":id});
    let (receipt_ref, receipt_oid) = receipts::create(
        "renew",
        operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&new),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: r.clone(),
            old: Some(old),
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
        &[(r, new), (receipt_ref, receipt_oid)],
    )?;
    repository::mutate(&snap, updates, &j)?;
    super::print_json(&result)
}

pub(crate) fn release(id: &str, token: Option<&str>, expired: bool, operation: &str) -> Result<()> {
    model::valid_id(id)?;
    model::bounded("operation-id", operation, 256)?;
    let domain = if expired { "reap" } else { "release" };
    let semantic = model::framed_digest(&format!("{domain}-semantics"), &[id, token.unwrap_or("")]);
    if let Some(outputs) = receipts::replay(domain, operation, &semantic)? {
        return super::print_json(&outputs);
    }
    let snap = repository::task_snapshot(id, vec![])?;
    let logical = model::framed_digest(
        if expired {
            "reap-logical"
        } else {
            "release-logical"
        },
        &[id, token.unwrap_or(""), operation],
    );
    if let Some(frontier) = snap.refs.get(&model::state_ref("frontier", id)) {
        repository::materialize(std::slice::from_ref(frontier))?;
        return if git::object_json(frontier)?["logicalId"] == logical {
            Ok(())
        } else {
            Err("task is frontier from a different operation".into())
        };
    }
    repository::exclusive(&snap, id, "active")?;
    let active_ref = model::state_ref("active", id);
    let active = snap.refs[&active_ref].clone();
    repository::materialize(std::slice::from_ref(&active))?;
    let now = super::timestamp()?;
    let value = git::object_json(&active)?;
    let claim: model::ClaimRecord = if expired {
        model::validate_reap_claim(value, id, now)?
    } else {
        serde_json::from_value(value).map_err(|e| format!("active claim malformed: {e}"))?
    };
    if !expired {
        model::validate_claim(
            serde_json::to_value(&claim).map_err(|e| e.to_string())?,
            token.ok_or("claim token is required")?,
            id,
            now,
        )?;
    }
    let frontier = model::state_ref("frontier", id);
    let record = json!({"formatVersion":2,"logicalId":logical,"operationId":logical,"releasedClaim":active,"taskId":id,"taskOid":claim.task_oid});
    let new = git::commit(&record, &[active.clone(), claim.task_oid])?;
    let result = json!({});
    let (receipt_ref, receipt_oid) = receipts::create(
        domain,
        operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&new),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: active_ref,
            old: Some(active),
            new: None,
        },
        Update {
            semantic_ref: frontier.clone(),
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
        &[(frontier, new), (receipt_ref, receipt_oid)],
    )?;
    repository::mutate(&snap, updates, &j)?;
    super::print_json(&result)
}
