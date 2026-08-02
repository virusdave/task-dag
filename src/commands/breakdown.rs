use super::{checked_identity, claim_token, default_owner, print_json, timestamp};
use crate::{
    Result, git,
    model::{self, BreakdownSpec, Update},
    receipts, repository,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

pub(crate) fn breakdown(id: &str, path: &str, claim_token_arg: &str) -> Result<()> {
    model::valid_id(id)?;
    let text = fs::read_to_string(path).map_err(|e| format!("read breakdown spec: {e}"))?;
    let spec: BreakdownSpec =
        serde_json::from_str(&text).map_err(|e| format!("invalid breakdown spec: {e}"))?;
    model::validate_children(id, &spec)?;
    let semantic = model::framed_digest(
        "breakdown-semantics",
        &[
            id,
            claim_token_arg,
            &serde_json::to_string(&spec).map_err(|e| e.to_string())?,
        ],
    );
    if let Some(outputs) = receipts::replay("breakdown", &spec.operation_id, &semantic)? {
        return print_json(&outputs);
    }
    let mut patterns = repository::lifecycle_patterns(id);
    for child in &spec.children {
        let child_id = model::task_id("child", &[id, &spec.operation_id, &child.key]);
        patterns.extend(repository::lifecycle_patterns(&child_id));
        for req in &child.requires {
            if !spec.children.iter().any(|c| &c.key == req) {
                patterns.extend(repository::lifecycle_patterns(req));
            }
        }
    }
    let snap = repository::checked_snapshot(patterns)?;
    let waiting = model::state_ref("waiting", id);
    if let Some(manifest) = snap.refs.get(&waiting) {
        repository::materialize(std::slice::from_ref(manifest))?;
        let value = git::object_json(manifest)?;
        if value["semanticId"] == semantic && value["parentTaskId"] == id {
            return print_json(
                &json!({"children":value["children"],"manifestOid":manifest,"parentTaskId":id}),
            );
        }
        return Err("task was decomposed by a different operation".into());
    }
    repository::exclusive(&snap, id, "active")?;
    let active_ref = model::state_ref("active", id);
    let active = snap.refs[&active_ref].clone();
    repository::materialize(std::slice::from_ref(&active))?;
    let parent_claim = model::validate_claim(
        git::object_json(&active)?,
        claim_token_arg,
        id,
        timestamp()?,
    )?;
    let parent_task = parent_claim.task_oid;
    let ids: BTreeMap<_, _> = spec
        .children
        .iter()
        .map(|c| {
            (
                c.key.clone(),
                model::task_id("child", &[id, &spec.operation_id, &c.key]),
            )
        })
        .collect();
    let external: Vec<_> = spec
        .children
        .iter()
        .flat_map(|c| c.requires.iter())
        .filter(|r| !ids.contains_key(*r))
        .cloned()
        .collect();
    repository::materialize_lifecycle(&snap, &external)?;
    for child in ids.values() {
        repository::ensure_new(&snap, child)?;
    }
    let mut child_rows = Vec::new();
    let mut created = BTreeMap::new();
    let mut born_tokens = BTreeSet::new();
    let mut updates = vec![Update {
        semantic_ref: active_ref,
        old: Some(active.clone()),
        new: None,
    }];
    for child in &spec.children {
        let child_id = &ids[&child.key];
        let resolved = model::resolve_requirements(&child.requires, &ids)?;
        let reqs = model::breakdown_requirements(&snap, &resolved, &created)?;
        if child.claim {
            model::readiness(&snap, &reqs)?;
        }
        let mut parents = vec![parent_task.clone()];
        parents.extend(model::requirement_oids(&reqs));
        let task = git::commit(
            &json!({"description":child.description,"formatVersion":2,"operationId":format!("{}:{}",spec.operation_id,child.key),"requirements":reqs,"structuralParent":{"taskId":id,"taskOid":parent_task},"taskId":child_id,"title":child.title}),
            &parents,
        )?;
        created.insert(child_id.clone(), task.clone());
        let state = if child.claim { "active" } else { "frontier" };
        let token = if child.claim {
            let generated = claim_token()?;
            if !born_tokens.insert(generated.clone()) {
                return Err("born claim token collision".into());
            }
            Some(generated)
        } else {
            None
        };
        let owner = default_owner();
        let record = if child.claim {
            let now = timestamp()?;
            let (host, session_id) = checked_identity(&owner)?;
            json!({"attemptId":model::framed_digest("breakdown-claim-attempt", &["breakdown",&spec.operation_id,&child.key,token.as_ref().unwrap()]),"claimToken":token,"claimedAt":now,"expiresAt":now+12*3600,"formatVersion":2,"host":host,"logicalId":model::framed_digest("breakdown-claim-logical", &["breakdown",&spec.operation_id,&child.key]),"owner":owner,"sessionId":session_id,"taskId":child_id,"taskOid":task})
        } else {
            json!({"formatVersion":2,"operationId":spec.operation_id,"taskId":child_id,"taskOid":task})
        };
        let state_oid = git::commit(&record, std::slice::from_ref(&task))?;
        let r = model::state_ref(state, child_id);
        updates.push(Update {
            semantic_ref: r.clone(),
            old: None,
            new: Some(state_oid.clone()),
        });
        child_rows.push(json!({"claimToken":token,"owner":if child.claim {Some(owner)} else {None},"ref":r,"stateOid":state_oid,"taskId":child_id,"taskOid":task}));
    }
    let record = json!({"children":child_rows,"formatVersion":2,"operationId":spec.operation_id,"semanticId":semantic,"parentTaskId":id,"parentTaskOid":parent_task});
    let mut parents = vec![active.clone(), parent_task];
    for row in &child_rows {
        parents.push(row["taskOid"].as_str().unwrap().into());
    }
    let manifest = git::commit(&record, &parents)?;
    updates.push(Update {
        semantic_ref: waiting.clone(),
        old: None,
        new: Some(manifest.clone()),
    });
    let result = json!({"children":child_rows,"manifestOid":manifest,"parentTaskId":id});
    let (receipt_ref, receipt_oid) = receipts::create(
        "breakdown",
        &spec.operation_id,
        &semantic,
        result.clone(),
        std::slice::from_ref(&manifest),
    )?;
    updates.push(Update {
        semantic_ref: receipt_ref.clone(),
        old: None,
        new: Some(receipt_oid.clone()),
    });
    let updates = model::canonical_updates(updates);
    repository::mutate(updates)?;
    print_json(&result)
}
