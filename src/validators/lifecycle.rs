use super::{digest, id_oid, object, task};
use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

fn delegated_task_matches(waiting: &Value, task_oid: &str) -> bool {
    waiting["parentTaskOid"].as_str() == Some(task_oid)
}

pub(crate) fn lifecycle(state: &str, oid: &str, id: &str) -> Result<Value> {
    let value = match state {
        "frontier" => object(
            oid,
            "frontier",
            &["formatVersion", "operationId", "taskId", "taskOid"],
            &[
                &[],
                &["semanticId"],
                &["logicalId", "releasedClaim"],
                &["logicalId", "releasedBlock"],
            ],
        )?,
        "active" => object(
            oid,
            "active",
            &[
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
            ],
            &[
                &[],
                &["operationId"],
                &["semanticId"],
                &["operationId", "semanticId"],
                &["operationId", "reclaimRequired"],
            ],
        )?,
        "blocked" => object(
            oid,
            "blocked",
            &[
                "authorization",
                "blockedAt",
                "claimTokenDigest",
                "formatVersion",
                "operationId",
                "reason",
                "taskId",
                "taskOid",
            ],
            &[&[]],
        )?,
        "done" => object(
            oid,
            "done",
            &["formatVersion", "logicalId", "taskId", "taskOid"],
            &[
                &["attemptId", "oldMaster", "publicationCommit"],
                &["attemptId", "authorization", "description", "evidence"],
                &["children", "manifestOid", "operationId"],
                &["acceptedOid", "intentOid", "operationId"],
                &[
                    "closeOid",
                    "closeRef",
                    "declarationOid",
                    "declarationRef",
                    "operationId",
                ],
            ],
        )?,
        _ => return Err(format!("unsupported lifecycle validator {state}")),
    };
    let task_oid = id_oid(&value, "taskId", "taskOid", id)?;
    let parents = git::parents(oid)?;
    let task_position = if (state == "frontier"
        && value.get("releasedClaim").is_none()
        && value.get("releasedBlock").is_none())
        || (state == "active" && parents.len() == 1)
    {
        0
    } else {
        1
    };
    if parents.get(task_position) != Some(&task_oid) {
        return Err(format!(
            "{state} record has wrong immediate Task parent ordering"
        ));
    }
    let task_value = task(&task_oid, id)?;
    if let Some(v) = value.get("semanticId") {
        digest("semanticId", v)?;
    }
    if let Some(v) = value.get("logicalId") {
        digest("logicalId", v)?;
    }
    match state {
        "active" => {
            model::validate_reap_claim(
                value.clone(),
                id,
                value["expiresAt"]
                    .as_u64()
                    .ok_or("active expiresAt malformed")?,
            )?;
            if !matches!(parents.len(), 1 | 2) {
                return Err("active record has wrong immediate parent count".into());
            }
        }
        "frontier" => {
            let expected =
                if value.get("releasedClaim").is_some() || value.get("releasedBlock").is_some() {
                    2
                } else {
                    1
                };
            if parents.len() != expected {
                return Err("frontier record has wrong parent count".into());
            }
        }
        "blocked" => {
            if parents.len() != 2 {
                return Err("blocked record must have exact parents [active, Task]".into());
            }
            let active = lifecycle("active", &parents[0], id)?;
            if active["taskOid"] != task_oid {
                return Err("blocked record active parent names wrong Task object".into());
            }
            model::bounded(
                "block reason",
                value["reason"].as_str().ok_or("block reason malformed")?,
                16_384,
            )?;
            model::bounded(
                "block authorization",
                value["authorization"]
                    .as_str()
                    .ok_or("block authorization malformed")?,
                4_096,
            )?;
            digest("claimTokenDigest", &value["claimTokenDigest"])?;
            value["blockedAt"].as_u64().ok_or("blockedAt malformed")?;
        }
        "done" if value.get("closeOid").is_some() => {
            let declaration = value["declarationOid"]
                .as_str()
                .ok_or("migration done declaration OID malformed")?;
            let close = value["closeOid"]
                .as_str()
                .ok_or("migration done close OID malformed")?;
            model::oid(declaration)?;
            model::oid(close)?;
            let declaration_ref = value["declarationRef"]
                .as_str()
                .ok_or("migration done declaration ref malformed")?;
            let close_ref = value["closeRef"]
                .as_str()
                .ok_or("migration done close ref malformed")?;
            if parents.len() != 3 || parents[1] != task_oid || parents[2] != close {
                return Err("migration done Task/declaration/close identity or parent ordering is malformed".into());
            }
            let (root, _, _, peer_repository, peer_issue) =
                crate::migration::scan::validate_declaration_close_binding(
                    declaration_ref,
                    declaration,
                    close_ref,
                    close,
                )?;
            let active = lifecycle("active", &parents[0], id)?;
            let expected_operation = model::framed_digest(
                "migrate-v1-delegation-operation",
                &[&root, declaration_ref, declaration],
            );
            let operation = value["operationId"]
                .as_str()
                .ok_or("migration done operation ID malformed")?;
            let expected_task_id = model::task_id(
                "legacy-v1-delegation-source",
                &[&root, declaration_ref, declaration],
            );
            let expected_semantic = model::framed_digest(
                "migrate-v1-delegation-semantic",
                &[&root, declaration_ref, declaration],
            );
            let expected_done_logical = model::framed_digest(
                "migration-delegation-done",
                &[&expected_operation, declaration, close],
            );
            let root_task_oid = crate::migration::scan::expected_imported_root_task(&root)?;
            let expected_task = serde_json::json!({
                "description": format!(
                    "Imported legacy delegation {declaration} at {declaration_ref} for {peer_repository}#{peer_issue}"
                ),
                "formatVersion": 2,
                "operationId": expected_operation,
                "requirements": [],
                "structuralParent": {
                    "taskId": model::task_id("legacy-v1-sha", &[&root]),
                    "taskOid": root_task_oid,
                },
                "taskId": expected_task_id,
                "title": format!("Delegated issue {peer_repository}#{peer_issue}"),
            });
            let expected_task_oid =
                git::migration_task_commit(&expected_task, std::slice::from_ref(&root_task_oid))?;
            if id != expected_task_id
                || operation != expected_operation
                || value["logicalId"] != expected_done_logical
                || task_value != expected_task
                || task_oid != expected_task_oid
                || active["taskId"] != expected_task_id
                || active["taskOid"] != task_oid
                || active["owner"] != "migration:v1-delegation"
                || active["host"] != "migration"
                || active["sessionId"] != "migration"
                || active["operationId"] != expected_operation
                || active["logicalId"] != expected_semantic
                || active["attemptId"]
                    != model::framed_digest("migration-delegation-active", &[&expected_operation])
                || active["claimToken"]
                    != model::framed_digest("migration-delegation-token", &[&expected_operation])
            {
                return Err("migration done historical active identity is malformed".into());
            }
        }
        "done" if value.get("publicationCommit").is_some() => {
            validate_done_active_parent(&parents, &task_oid, id)?;
            let publication = value["publicationCommit"]
                .as_str()
                .ok_or("done publication OID malformed")?;
            let old = value["oldMaster"]
                .as_str()
                .ok_or("done old master malformed")?;
            model::oid(publication)?;
            model::oid(old)?;
            if parents.len() != 3
                || parents[2] != publication
                || git::first_parent(publication)? != old
            {
                return Err("done publication relation is malformed".into());
            }
        }
        "done" if value.get("evidence").is_some() => {
            validate_done_active_parent(&parents, &task_oid, id)?;
            if parents.len() != 2 {
                return Err("operations done evidence parent ordering is malformed".into());
            }
            for item in value["evidence"]
                .as_array()
                .ok_or("operations done evidence list malformed")?
            {
                if item.as_object().map(|m| m.len()) != Some(2) {
                    return Err("operations evidence fields malformed".into());
                }
                let captured = item["value"]
                    .as_str()
                    .ok_or("operations evidence value malformed")?;
                if item["digest"] != model::digest(captured) {
                    return Err("operations evidence digest mismatch".into());
                }
            }
        }
        "done" if value.get("acceptedOid").is_some() => {
            let accepted_oid = value["acceptedOid"]
                .as_str()
                .ok_or("delegated done accepted OID malformed")?;
            let intent_oid = value["intentOid"]
                .as_str()
                .ok_or("delegated done intent OID malformed")?;
            model::oid(accepted_oid)?;
            model::oid(intent_oid)?;
            if parents.len() != 3 || parents[2] != accepted_oid {
                return Err("delegated done immediate parent ordering is malformed".into());
            }
            let waiting = waiting(&parents[0], id)?;
            let accepted = super::accepted(accepted_oid)?;
            if !delegated_task_matches(&waiting, &task_oid)
                || waiting["intentOid"] != intent_oid
                || waiting["operationId"] != value["operationId"]
                || accepted["intentOid"] != intent_oid
                || accepted["operationId"] != value["operationId"]
            {
                return Err("delegated done does not match waiting and accepted evidence".into());
            }
        }
        "done" => {
            let manifest = value["manifestOid"]
                .as_str()
                .ok_or("converged manifest OID malformed")?;
            model::oid(manifest)?;
            let children = value["children"]
                .as_array()
                .ok_or("converged children malformed")?;
            if parents.len() != children.len() + 2 || parents[0] != manifest {
                return Err("converged done immediate parent ordering is malformed".into());
            }
            let waiting = waiting(manifest, id)?;
            if waiting["parentTaskOid"] != task_oid {
                return Err("converged manifest names wrong parent Task object".into());
            }
            let manifest_children = waiting["children"]
                .as_array()
                .ok_or("waiting children malformed")?;
            if manifest_children.len() != children.len() {
                return Err("converged children do not exactly match waiting manifest".into());
            }
            let mut ids = BTreeSet::new();
            for (index, child) in children.iter().enumerate() {
                let pair = child
                    .as_array()
                    .filter(|p| p.len() == 2)
                    .ok_or("converged child pair malformed")?;
                let child_ref = pair[0]
                    .as_str()
                    .ok_or("converged child done ref malformed")?;
                let child_id = model::parse_state_ref(child_ref, "done")
                    .ok_or("converged child ref is not a done ref")?;
                model::valid_id(child_id)?;
                if !ids.insert(child_id) {
                    return Err("converged done has duplicate child lifecycle".into());
                }
                let child_oid = pair[1]
                    .as_str()
                    .ok_or("converged child done OID malformed")?;
                model::oid(child_oid)?;
                if parents[index + 2] != child_oid {
                    return Err("converged child done parent ordering is malformed".into());
                }
                let manifest_child = manifest_children
                    .iter()
                    .find(|candidate| candidate["taskId"] == child_id)
                    .ok_or("converged child is absent from waiting manifest")?;
                let child_done = lifecycle("done", child_oid, child_id)?;
                if child_done["taskOid"] != manifest_child["taskOid"] {
                    return Err("converged child done names wrong Task object".into());
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::delegated_task_matches;

    #[test]
    fn delegated_done_rejects_a_different_task_object_with_the_same_id() {
        let waiting = serde_json::json!({
            "parentTaskId": format!("v2-{}", "a".repeat(64)),
            "parentTaskOid": "1111111111111111111111111111111111111111",
        });
        assert!(!delegated_task_matches(
            &waiting,
            "2222222222222222222222222222222222222222",
        ));
    }
}

fn validate_done_active_parent(parents: &[String], task_oid: &str, id: &str) -> Result<()> {
    let active_oid = parents
        .first()
        .ok_or("done record lacks immediate active lifecycle parent")?;
    let active = lifecycle("active", active_oid, id)?;
    if active["taskOid"] != task_oid {
        return Err("done active parent names wrong Task object".into());
    }
    Ok(())
}

pub(crate) fn waiting(oid: &str, id: &str) -> Result<Value> {
    if git::object_json(oid)?.get("intentOid").is_some() {
        return delegated_waiting(oid, id);
    }
    let value = object(
        oid,
        "waiting",
        &[
            "children",
            "formatVersion",
            "operationId",
            "semanticId",
            "parentTaskId",
            "parentTaskOid",
        ],
        &[&[]],
    )?;
    let parent_task = id_oid(&value, "parentTaskId", "parentTaskOid", id)?;
    digest("waiting semanticId", &value["semanticId"])?;
    model::bounded(
        "waiting operationId",
        value["operationId"]
            .as_str()
            .ok_or("waiting operationId malformed")?,
        256,
    )?;
    let children = value["children"]
        .as_array()
        .ok_or("waiting children malformed")?;
    if children.is_empty() {
        return Err("waiting manifest has no children".into());
    }
    let parents = git::parents(oid)?;
    if parents.len() != children.len() + 2 || parents[1] != parent_task {
        return Err("waiting manifest immediate parent ordering is malformed".into());
    }
    let state_oids: Result<Vec<String>> = children
        .iter()
        .map(|child| {
            let state_oid = child["stateOid"]
                .as_str()
                .ok_or("waiting child state OID malformed")?;
            model::oid(state_oid)?;
            Ok(state_oid.to_owned())
        })
        .collect();
    crate::repository::materialize(&state_oids?)?;
    let mut ids = BTreeSet::new();
    for (index, child) in children.iter().enumerate() {
        let map = child.as_object().ok_or("waiting child malformed")?;
        let has_claim = !child["claimToken"].is_null();
        if map.len() != 6 || has_claim == child["owner"].is_null() {
            return Err("waiting child has missing, unknown, or mismatched claim fields".into());
        }
        let child_id = child["taskId"]
            .as_str()
            .ok_or("waiting child Task-ID malformed")?;
        model::valid_id(child_id)?;
        if !ids.insert(child_id) {
            return Err("waiting manifest has duplicate child".into());
        }
        let task_oid = child["taskOid"]
            .as_str()
            .ok_or("waiting child Task OID malformed")?;
        let state_oid = child["stateOid"]
            .as_str()
            .ok_or("waiting child state OID malformed")?;
        model::oid(task_oid)?;
        model::oid(state_oid)?;
        let state = if child["ref"] == model::state_ref("waiting", child_id) {
            if has_claim {
                return Err("delegated waiting child cannot carry an active claim".into());
            }
            "waiting"
        } else if has_claim {
            "active"
        } else {
            "frontier"
        };
        if parents[index + 2] != task_oid || child["ref"] != model::state_ref(state, child_id) {
            return Err("waiting child identity or immediate order is malformed".into());
        }
        task(task_oid, child_id)?;
        if state == "waiting" {
            waiting(state_oid, child_id)?;
        } else {
            lifecycle(state, state_oid, child_id)?;
        }
        let state_task_key = if state == "waiting" {
            "parentTaskOid"
        } else {
            "taskOid"
        };
        if git::object_json(state_oid)?[state_task_key] != task_oid {
            return Err("waiting child state names wrong Task object".into());
        }
    }
    Ok(value)
}

fn delegated_waiting(oid: &str, id: &str) -> Result<Value> {
    let value = object(
        oid,
        "delegated waiting",
        &[
            "formatVersion",
            "intentOid",
            "intentRef",
            "operationId",
            "parentTaskId",
            "parentTaskOid",
            "semanticId",
            "targetTaskId",
        ],
        &[&[]],
    )?;
    let parent_task = id_oid(&value, "parentTaskId", "parentTaskOid", id)?;
    digest("delegated waiting semanticId", &value["semanticId"])?;
    model::valid_id(
        value["targetTaskId"]
            .as_str()
            .ok_or("delegated waiting target Task-ID malformed")?,
    )?;
    let intent_oid = value["intentOid"]
        .as_str()
        .ok_or("delegated waiting intent OID malformed")?;
    model::oid(intent_oid)?;
    let intent_ref = value["intentRef"]
        .as_str()
        .ok_or("delegated waiting intent ref malformed")?;
    model::bounded("delegated waiting intent ref", intent_ref, 512)?;
    let operation = value["operationId"]
        .as_str()
        .ok_or("delegated waiting operationId malformed")?;
    if intent_ref != model::delegation_intent_ref(operation) {
        return Err("delegated waiting intent ref is not deterministic".into());
    }
    let parents = git::parents(oid)?;
    if parents.len() != 3 || parents[1] != parent_task || parents[2] != intent_oid {
        return Err("delegated waiting immediate parent ordering is malformed".into());
    }
    let active = lifecycle("active", &parents[0], id)?;
    if active["taskOid"] != parent_task {
        return Err("delegated waiting active parent names wrong Task".into());
    }
    let intent = super::intent(intent_oid)?;
    if intent["sourceTaskId"] != id
        || intent["sourceTaskOid"] != parent_task
        || intent["targetTaskId"] != value["targetTaskId"]
        || intent["operationId"] != value["operationId"]
        || intent["semanticId"] != value["semanticId"]
    {
        return Err("delegated waiting does not match its intent".into());
    }
    Ok(value)
}
