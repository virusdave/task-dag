use super::{digest, id_oid, object, task};
use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

// These exact records predate persisted requirement evidence. They were
// inventoried with the canonical current-state reader before activating the
// proof-bearing convergence format. No future proofless record is accepted.
const LEGACY_REQUIREMENT_CONVERGENCE: &[(&str, &str, &str, &str)] = &[
    (
        "c3bb5c99945caa951dce78ced8b7122b9623fba0",
        "v2-388b3e81a91fe8606537812be10e919e3dd8f8ac1a10a08119f7b780f7836091",
        "7fa3de9d85097c89737ff70b9385057cdb724695",
        "a8d44653516f38f0c4169a40fef54d307c1aad8f",
    ),
    (
        "0e9a605baf53580768de2e9d26efb755dee2766b",
        "v2-ae6e685ae6c020f7ba1689c691443cabd7ac1f7c373384247079ee12f4a2abdc",
        "10a6e9b34532f24e5272fea86a329f01cc432f1e",
        "44c67b2dcb6dfa71f350082bb987681b6e9949b0",
    ),
    (
        "5c01ceaf7ddc60af03272db8f7a84befbf506718",
        "v2-cb47be6f4390c1be6e01592d4fa24f5cc25cfe54f109d9db5d68464ddb29467a",
        "7dbc11f00a634838e67bb39cf8e43d97ca234edf",
        "0903bff4981ef122e965a8ba2016623a619e2fd5",
    ),
    (
        "22641a6ed4b0829ee2566582415f51af9f536796",
        "v2-eeee7db0b96253894ad9da2df30eb5b52d92c538316f8546c47274342c637717",
        "9846a237139716e7b622ba2f1d796a2f8986f9e0",
        "2624f4af9cf92286942da944fe886e10ff440766",
    ),
    (
        "63ca120799baca8f2e7824153f6c085771ad35ef",
        "v2-477e5c7edbd8101a3e975b8031f18b2dc2dbf0550282d0ee5ee05a8ed15230eb",
        "a1bd367b9f40844d5487118529e8a80ecf8eb2c8",
        "45c25defaaadc5ca7a767016856a3fc5140e25b7",
    ),
    (
        "4920a5fdb030e57839289fe3af164436feb8a0de",
        "v2-787e8b2354d255bb70d9f1b2dbc2957d3af49d8747b5fd24b2067ce844b21f2e",
        "255d3e98dd58eb9e3b142929582b22f67c19ece7",
        "1255382ff8869d034838b64e60dcf6591041e813",
    ),
    (
        "d926ab68b18d7eab6335158ab609df01d225f0d1",
        "v2-c2bb81e7c870d2305f4b618781dbbe47ac6f644c501e08c04ccd7aaec3a9b014",
        "3a397092adccdd5f0ccefa7b843cd51d9a049e84",
        "b37c820852f6d6b3f66d23f1d46b5035dd7fb8e6",
    ),
    (
        "a88d3e3716c73434752ae88f94a1382742efaf5e",
        "v2-c51cd4d4ed31d9f07e3a823791dd1f234bbc5151366784dcb02f12c92edf005f",
        "7c7af2af69f6621abe3a60955b99df4ebaed94be",
        "7271d7a5e5aebdd4ef1746d8b46a3b1c06c65467",
    ),
    (
        "7b187f5e019dd47e2405e65375d9c49bee443786",
        "v2-ec7304f9121b6343e5a2e5c980bb2c5b8cb9568139190a0416cc51c2357a8c9a",
        "ef39f7a7c36b988096324aecee4f1afa2fd7c50b",
        "cd53e223a5ac89254df83393e6001fb83a2eb5ce",
    ),
];

fn legacy_requirement_convergence(oid: &str, id: &str, task_oid: &str, manifest: &str) -> bool {
    LEGACY_REQUIREMENT_CONVERGENCE.contains(&(oid, id, task_oid, manifest))
}

#[tracing::instrument(skip_all, name = "validate.convergence-evidence")]
pub(crate) fn current_convergence_evidence(
    oid: &str,
    id: &str,
    value: &Value,
    task: &Value,
) -> Result<()> {
    let Some(manifest) = value.get("manifestOid").and_then(Value::as_str) else {
        return Ok(());
    };
    let task_oid = value["taskOid"].as_str().ok_or("done Task OID malformed")?;
    let task_requirements = task["requirements"]
        .as_array()
        .ok_or("Task requirements malformed")?;
    let Some(requirements) = value.get("requirements") else {
        if task_requirements.is_empty()
            || legacy_requirement_convergence(oid, id, task_oid, manifest)
        {
            return Ok(());
        }
        return Err(
            "requirement-bearing converged done lacks persisted requirement evidence".into(),
        );
    };
    let requirements = requirements
        .as_array()
        .filter(|requirements| !requirements.is_empty())
        .ok_or("converged requirements must be absent or non-empty")?;
    if task_requirements.is_empty() {
        return Err("requirement-free convergence must use the legacy shape".into());
    }
    if requirements.len() != task_requirements.len() {
        return Err("converged requirements do not exactly match parent Task".into());
    }
    let children = value["children"]
        .as_array()
        .ok_or("converged children malformed")?;
    let mut previous_ref = None;
    for child in children {
        let child_ref = child
            .as_array()
            .filter(|pair| pair.len() == 2)
            .and_then(|pair| pair[0].as_str())
            .ok_or("converged child done ref malformed")?;
        if previous_ref.is_some_and(|previous| previous >= child_ref) {
            return Err("converged children are not canonically sorted".into());
        }
        previous_ref = Some(child_ref);
    }
    let mut expected_ids = task_requirements
        .iter()
        .map(|requirement| {
            requirement["taskId"]
                .as_str()
                .ok_or_else(|| "Task requirement Task-ID malformed".to_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    expected_ids.sort();
    let mut previous_ref = None;
    for (requirement, expected_id) in requirements.iter().zip(expected_ids) {
        let pair = requirement
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or("converged requirement pair malformed")?;
        let done_ref = pair[0]
            .as_str()
            .ok_or("converged requirement done ref malformed")?;
        if previous_ref.is_some_and(|previous| previous >= done_ref) {
            return Err("converged requirements are not canonically sorted".into());
        }
        previous_ref = Some(done_ref);
        let requirement_id = model::parse_state_ref(done_ref, "done")
            .ok_or("converged requirement ref is not a done ref")?;
        if expected_id != requirement_id {
            return Err("converged requirements do not exactly match parent Task".into());
        }
    }
    let operation = value["operationId"]
        .as_str()
        .ok_or("converged operationId malformed")?;
    let expected_logical = model::framed_digest(
        "converge-requirements-logical",
        &[
            id,
            operation,
            manifest,
            &serde_json::to_string(children).map_err(|e| e.to_string())?,
            &serde_json::to_string(requirements).map_err(|e| e.to_string())?,
        ],
    );
    if value["logicalId"] != expected_logical {
        return Err("converged requirement logical identity mismatch".into());
    }
    Ok(())
}

fn delegated_task_matches(waiting: &Value, task_oid: &str) -> bool {
    waiting["parentTaskOid"].as_str() == Some(task_oid)
}

enum OperationsPayloadPolicy {
    LegacyRead,
    NewWrite,
}

fn new_operations_evidence_value(value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err("operations evidence value must not be empty".into());
    }
    if value.len() > 16_384 {
        return Err("operations evidence value exceeds 16384 bytes".into());
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err("operations evidence value contains an unsupported control character".into());
    }
    Ok(())
}

fn operations_done_payload(value: &Value, policy: OperationsPayloadPolicy) -> Result<()> {
    let authorization = value["authorization"]
        .as_str()
        .ok_or("done authorization malformed")?;
    let description = value["description"]
        .as_str()
        .ok_or("done description malformed")?;
    model::nonempty("done authorization", authorization)?;
    if description.trim().is_empty() {
        return Err("done description must not be empty".into());
    }
    let evidence = value["evidence"]
        .as_array()
        .ok_or("operations done evidence list malformed")?;
    if matches!(policy, OperationsPayloadPolicy::NewWrite) {
        model::bounded("done authorization", authorization, 4_096)?;
        model::description("done description", description)?;
        if evidence.len() > 64 {
            return Err("operations done evidence has too many entries".into());
        }
    }
    for item in evidence {
        if item.as_object().map(|map| map.len()) != Some(2) {
            return Err("operations evidence fields malformed".into());
        }
        let captured = item["value"]
            .as_str()
            .ok_or("operations evidence value malformed")?;
        if matches!(policy, OperationsPayloadPolicy::NewWrite) {
            new_operations_evidence_value(captured)?;
        }
        if item["digest"] != model::digest(captured) {
            return Err("operations evidence digest mismatch".into());
        }
    }
    Ok(())
}

#[tracing::instrument(skip_all, name = "validate.operations-done-payload")]
pub(crate) fn new_operations_done_payload(value: &Value) -> Result<()> {
    operations_done_payload(value, OperationsPayloadPolicy::NewWrite)
}

/// Validate only the current lifecycle record and its immediate parent
/// header. Historical child state objects are opaque; delegated and migrated
/// completion evidence has a fixed-size chain and retains its exact checks.
#[tracing::instrument(skip_all, name = "validate.current-lifecycle")]
pub(crate) fn current_lifecycle(state: &str, oid: &str, id: &str) -> Result<Value> {
    if state == "waiting" {
        return current_waiting(oid, id);
    }
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
                "formatVersion",
                "operationId",
                "reason",
                "taskId",
                "taskOid",
            ],
            &[
                &["authorization", "blockedAt", "claimTokenDigest"],
                &[
                    "authorizationRequired",
                    "condition",
                    "evidence",
                    "logicalId",
                    "question",
                ],
            ],
        )?,
        "done" => object(
            oid,
            "done",
            &["formatVersion", "logicalId", "taskId", "taskOid"],
            &[
                &["attemptId", "oldMaster", "publicationCommit"],
                &["attemptId", "authorization", "description", "evidence"],
                &["children", "manifestOid", "operationId"],
                &["children", "manifestOid", "operationId", "requirements"],
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
    if let Some(v) = value.get("semanticId") {
        digest("semanticId", v)?;
    }
    if let Some(v) = value.get("logicalId") {
        digest("logicalId", v)?;
    }
    match state {
        "frontier" if parents.len() != if task_position == 0 { 1 } else { 2 } => {
            return Err("frontier record has wrong parent count".into());
        }
        "active" => {
            if !matches!(parents.len(), 1 | 2) {
                return Err("active record has wrong immediate parent count".into());
            }
            model::validate_reap_claim(
                value.clone(),
                id,
                value["expiresAt"]
                    .as_u64()
                    .ok_or("active expiresAt malformed")?,
            )?;
        }
        "blocked" => {
            if parents.len() != 2 {
                return Err("blocked record must have exact parents [active, Task]".into());
            }
            model::bounded(
                "block reason",
                value["reason"].as_str().ok_or("block reason malformed")?,
                16_384,
            )?;
            model::bounded(
                "blocked operationId",
                value["operationId"]
                    .as_str()
                    .ok_or("blocked operationId malformed")?,
                256,
            )?;
            if value.get("authorizationRequired").is_some() {
                if value["authorizationRequired"] != true
                    || value["condition"] != serde_json::json!({"kind":"manual"})
                {
                    return Err("legacy blocked manual authorization is malformed".into());
                }
                digest("logicalId", &value["logicalId"])?;
                model::bounded(
                    "block question",
                    value["question"]
                        .as_str()
                        .ok_or("block question malformed")?,
                    4_096,
                )?;
                let evidence = value["evidence"]
                    .as_array()
                    .ok_or("block evidence malformed")?;
                if evidence.len() > 64 {
                    return Err("block evidence has too many entries".into());
                }
                for item in evidence {
                    model::bounded(
                        "block evidence",
                        item.as_str().ok_or("block evidence malformed")?,
                        4_096,
                    )?;
                }
            } else {
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
        }
        "done" => {
            for key in [
                "publicationCommit",
                "oldMaster",
                "manifestOid",
                "acceptedOid",
                "intentOid",
                "closeOid",
                "declarationOid",
            ] {
                if let Some(v) = value.get(key) {
                    model::oid(v.as_str().ok_or_else(|| format!("done {key} malformed"))?)?;
                }
            }
            if let Some(attempt) = value.get("attemptId") {
                digest("done attemptId", attempt)?;
            }
            if let Some(operation) = value.get("operationId") {
                model::bounded(
                    "done operationId",
                    operation.as_str().ok_or("done operationId malformed")?,
                    256,
                )?;
            }
            if value.get("evidence").is_some() {
                operations_done_payload(&value, OperationsPayloadPolicy::LegacyRead)?;
            }
            if value.get("manifestOid").is_some() {
                let mut child_ids = BTreeSet::new();
                for child in value["children"]
                    .as_array()
                    .ok_or("converged children malformed")?
                {
                    let child_id = child
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .and_then(|pair| pair[0].as_str())
                        .and_then(|child_ref| model::parse_state_ref(child_ref, "done"))
                        .ok_or("converged child ref is not a done ref")?;
                    model::valid_id(child_id)?;
                    if !child_ids.insert(child_id) {
                        return Err("converged done has duplicate child lifecycle".into());
                    }
                }
                let mut requirement_ids = BTreeSet::new();
                for requirement in value
                    .get("requirements")
                    .map(|requirements| {
                        requirements
                            .as_array()
                            .ok_or("converged requirements malformed")
                    })
                    .transpose()?
                    .into_iter()
                    .flatten()
                {
                    let requirement_id = requirement
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .and_then(|pair| pair[0].as_str())
                        .and_then(|done_ref| model::parse_state_ref(done_ref, "done"))
                        .ok_or("converged requirement ref is not a done ref")?;
                    model::valid_id(requirement_id)?;
                    if !requirement_ids.insert(requirement_id) {
                        return Err("converged done has duplicate requirement lifecycle".into());
                    }
                }
            }
            let valid_parents = if let Some(publication) = value["publicationCommit"].as_str() {
                parents.len() == 3 && parents[2] == publication
            } else if value.get("evidence").is_some() {
                parents.len() == 2
            } else if let Some(manifest) = value["manifestOid"].as_str() {
                let children = value["children"]
                    .as_array()
                    .ok_or("converged children malformed")?;
                let requirements = value
                    .get("requirements")
                    .map(|requirements| {
                        requirements
                            .as_array()
                            .ok_or("converged requirements malformed")
                    })
                    .transpose()?
                    .map_or(&[][..], Vec::as_slice);
                children.len() <= 500
                    && requirements.len() <= 500
                    && parents.len() == children.len() + requirements.len() + 2
                    && parents[0] == manifest
                    && children.iter().enumerate().all(|(index, child)| {
                        child
                            .as_array()
                            .filter(|pair| pair.len() == 2)
                            .is_some_and(|pair| {
                                pair[0]
                                    .as_str()
                                    .and_then(|child_ref| model::parse_state_ref(child_ref, "done"))
                                    .is_some_and(|child_id| model::valid_id(child_id).is_ok())
                                    && pair[1].as_str().is_some_and(|child_oid| {
                                        model::oid(child_oid).is_ok()
                                            && parents[index + 2] == child_oid
                                    })
                            })
                    })
                    && requirements.iter().enumerate().all(|(index, requirement)| {
                        requirement
                            .as_array()
                            .filter(|pair| pair.len() == 2)
                            .is_some_and(|pair| {
                                pair[0]
                                    .as_str()
                                    .and_then(|done_ref| model::parse_state_ref(done_ref, "done"))
                                    .is_some_and(|requirement_id| {
                                        model::valid_id(requirement_id).is_ok()
                                    })
                                    && pair[1].as_str().is_some_and(|done_oid| {
                                        model::oid(done_oid).is_ok()
                                            && parents[children.len() + index + 2] == done_oid
                                    })
                            })
                    })
            } else if let Some(accepted) = value["acceptedOid"].as_str() {
                parents.len() == 3 && parents[2] == accepted
            } else if let Some(close) = value["closeOid"].as_str() {
                parents.len() == 3 && parents[2] == close
            } else {
                false
            };
            if !valid_parents {
                return Err("done record immediate parent ordering is malformed".into());
            }
            if value.get("acceptedOid").is_some() || value.get("closeOid").is_some() {
                return lifecycle("done", oid, id);
            }
            for key in ["closeRef", "declarationRef"] {
                if let Some(reference) = value.get(key) {
                    model::bounded(
                        key,
                        reference
                            .as_str()
                            .ok_or_else(|| format!("done {key} malformed"))?,
                        512,
                    )?;
                }
            }
        }
        _ => {}
    }
    Ok(value)
}

fn current_waiting(oid: &str, id: &str) -> Result<Value> {
    let delegated = git::object_json(oid)?.get("intentOid").is_some();
    let value = if delegated {
        object(
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
        )?
    } else {
        object(
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
        )?
    };
    let task_oid = id_oid(&value, "parentTaskId", "parentTaskOid", id)?;
    digest("waiting semanticId", &value["semanticId"])?;
    model::bounded(
        "waiting operationId",
        value["operationId"]
            .as_str()
            .ok_or("waiting operationId malformed")?,
        256,
    )?;
    let parents = git::parents(oid)?;
    if delegated {
        model::valid_id(
            value["targetTaskId"]
                .as_str()
                .ok_or("delegated waiting target Task-ID malformed")?,
        )?;
        let intent = value["intentOid"]
            .as_str()
            .ok_or("delegated waiting intent OID malformed")?;
        model::oid(intent)?;
        model::bounded(
            "delegated waiting intent ref",
            value["intentRef"]
                .as_str()
                .ok_or("delegated waiting intent ref malformed")?,
            512,
        )?;
        if value["intentRef"]
            != model::delegation_intent_ref(
                value["operationId"]
                    .as_str()
                    .ok_or("delegated waiting operationId malformed")?,
            )
            || parents.len() != 3
            || parents[1] != task_oid
            || parents[2] != intent
        {
            return Err("delegated waiting immediate shape is malformed".into());
        }
    } else {
        let children = value["children"]
            .as_array()
            .ok_or("waiting children malformed")?;
        if children.is_empty()
            || children.len() > 500
            || parents.len() != children.len() + 2
            || parents[1] != task_oid
        {
            return Err("waiting manifest immediate parent ordering is malformed".into());
        }
        let mut ids = BTreeSet::new();
        for (index, child) in children.iter().enumerate() {
            if child.as_object().map(|m| m.len()) != Some(6) {
                return Err("waiting child has missing or unknown fields".into());
            }
            let child_id = child["taskId"]
                .as_str()
                .ok_or("waiting child Task-ID malformed")?;
            model::valid_id(child_id)?;
            if !ids.insert(child_id) {
                return Err("waiting manifest has duplicate child".into());
            }
            let child_task = child["taskOid"]
                .as_str()
                .ok_or("waiting child Task OID malformed")?;
            model::oid(child_task)?;
            model::oid(
                child["stateOid"]
                    .as_str()
                    .ok_or("waiting child state OID malformed")?,
            )?;
            let claimed = !child["claimToken"].is_null();
            if claimed == child["owner"].is_null() || parents[index + 2] != child_task {
                return Err("waiting child identity or immediate order is malformed".into());
            }
            if claimed {
                model::bounded(
                    "waiting child claim token",
                    child["claimToken"]
                        .as_str()
                        .ok_or("waiting child claim token malformed")?,
                    256,
                )?;
                model::bounded(
                    "waiting child owner",
                    child["owner"]
                        .as_str()
                        .ok_or("waiting child owner malformed")?,
                    256,
                )?;
            }
            let expected = if child["ref"] == model::state_ref("waiting", child_id) && !claimed {
                model::state_ref("waiting", child_id)
            } else if claimed {
                model::state_ref("active", child_id)
            } else {
                model::state_ref("frontier", child_id)
            };
            if child["ref"] != expected {
                return Err("waiting child ref shape is malformed".into());
            }
        }
    }
    Ok(value)
}

#[tracing::instrument(skip_all, name = "validate.lifecycle")]
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
                "formatVersion",
                "operationId",
                "reason",
                "taskId",
                "taskOid",
            ],
            &[
                &["authorization", "blockedAt", "claimTokenDigest"],
                &[
                    "authorizationRequired",
                    "condition",
                    "evidence",
                    "logicalId",
                    "question",
                ],
            ],
        )?,
        "done" => object(
            oid,
            "done",
            &["formatVersion", "logicalId", "taskId", "taskOid"],
            &[
                &["attemptId", "oldMaster", "publicationCommit"],
                &["attemptId", "authorization", "description", "evidence"],
                &["children", "manifestOid", "operationId"],
                &["children", "manifestOid", "operationId", "requirements"],
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
            if value.get("authorizationRequired").is_some() {
                if value["authorizationRequired"] != true
                    || value["condition"] != serde_json::json!({"kind":"manual"})
                {
                    return Err("legacy blocked manual authorization is malformed".into());
                }
                digest("logicalId", &value["logicalId"])?;
                model::bounded(
                    "block question",
                    value["question"]
                        .as_str()
                        .ok_or("block question malformed")?,
                    4_096,
                )?;
                let evidence = value["evidence"]
                    .as_array()
                    .ok_or("block evidence malformed")?;
                if evidence.len() > 64 {
                    return Err("block evidence has too many entries".into());
                }
                for item in evidence {
                    model::bounded(
                        "block evidence",
                        item.as_str().ok_or("block evidence malformed")?,
                        4_096,
                    )?;
                }
            } else {
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
            operations_done_payload(&value, OperationsPayloadPolicy::LegacyRead)?;
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
            let requirements = value
                .get("requirements")
                .map(|requirements| {
                    requirements
                        .as_array()
                        .ok_or("converged requirements malformed")
                })
                .transpose()?;
            if parents.len() != children.len() + requirements.map_or(0, Vec::len) + 2
                || parents[0] != manifest
            {
                return Err("converged done immediate parent ordering is malformed".into());
            }
            let waiting = waiting(manifest, id)?;
            if waiting["parentTaskOid"] != task_oid {
                return Err("converged manifest names wrong parent Task object".into());
            }
            let task_value = task(&task_oid, id)?;
            let task_requirements = task_value["requirements"]
                .as_array()
                .ok_or("Task requirements malformed")?;
            match requirements {
                None if task_requirements.is_empty() => {}
                None if legacy_requirement_convergence(oid, id, &task_oid, manifest) => {}
                None => {
                    return Err(
                        "requirement-bearing converged done lacks persisted requirement evidence"
                            .into(),
                    );
                }
                Some(requirements) if requirements.is_empty() => {
                    return Err("converged requirements must be absent or non-empty".into());
                }
                Some(_) if task_requirements.is_empty() => {
                    return Err("requirement-free convergence must use the legacy shape".into());
                }
                Some(_) => {}
            }
            let manifest_children = waiting["children"]
                .as_array()
                .ok_or("waiting children malformed")?;
            if manifest_children.len() != children.len() {
                return Err("converged children do not exactly match waiting manifest".into());
            }
            let mut ids = BTreeSet::new();
            let mut previous_ref = None;
            for (index, child) in children.iter().enumerate() {
                let pair = child
                    .as_array()
                    .filter(|p| p.len() == 2)
                    .ok_or("converged child pair malformed")?;
                let child_ref = pair[0]
                    .as_str()
                    .ok_or("converged child done ref malformed")?;
                if requirements.is_some()
                    && previous_ref.is_some_and(|previous| previous >= child_ref)
                {
                    return Err("converged children are not canonically sorted".into());
                }
                previous_ref = Some(child_ref);
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
            if let Some(requirements) = requirements {
                if requirements.len() != task_requirements.len() {
                    return Err("converged requirements do not exactly match parent Task".into());
                }
                let operation = value["operationId"]
                    .as_str()
                    .ok_or("converged operationId malformed")?;
                let expected_logical = model::framed_digest(
                    "converge-requirements-logical",
                    &[
                        id,
                        operation,
                        manifest,
                        &serde_json::to_string(children).map_err(|e| e.to_string())?,
                        &serde_json::to_string(requirements).map_err(|e| e.to_string())?,
                    ],
                );
                if value["logicalId"] != expected_logical {
                    return Err("converged requirement logical identity mismatch".into());
                }
                let mut ids = BTreeSet::new();
                let mut previous_ref = None;
                for (index, requirement) in requirements.iter().enumerate() {
                    let pair = requirement
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .ok_or("converged requirement pair malformed")?;
                    let done_ref = pair[0]
                        .as_str()
                        .ok_or("converged requirement done ref malformed")?;
                    if previous_ref.is_some_and(|previous| previous >= done_ref) {
                        return Err("converged requirements are not canonically sorted".into());
                    }
                    previous_ref = Some(done_ref);
                    let requirement_id = model::parse_state_ref(done_ref, "done")
                        .ok_or("converged requirement ref is not a done ref")?;
                    model::valid_id(requirement_id)?;
                    if !ids.insert(requirement_id) {
                        return Err("converged done has duplicate requirement lifecycle".into());
                    }
                    let done_oid = pair[1]
                        .as_str()
                        .ok_or("converged requirement done OID malformed")?;
                    model::oid(done_oid)?;
                    if parents[children.len() + index + 2] != done_oid {
                        return Err(
                            "converged requirement done parent ordering is malformed".into()
                        );
                    }
                    let expected = task_requirements
                        .iter()
                        .find(|candidate| candidate["taskId"] == requirement_id)
                        .ok_or("converged requirement is absent from parent Task")?;
                    let requirement_done = lifecycle("done", done_oid, requirement_id)?;
                    if requirement_done["taskOid"] != expected["taskOid"] {
                        return Err("converged requirement names wrong Task object".into());
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{
        LEGACY_REQUIREMENT_CONVERGENCE, OperationsPayloadPolicy, current_convergence_evidence,
        delegated_task_matches, legacy_requirement_convergence, operations_done_payload,
    };
    use crate::model;
    use proptest::prelude::*;

    fn operations_payload(values: &[String]) -> serde_json::Value {
        let evidence: Vec<_> = values
            .iter()
            .map(|value| serde_json::json!({"digest":model::digest(value),"value":value}))
            .collect();
        serde_json::json!({"authorization":"operator approved","description":"done","evidence":evidence})
    }

    #[test]
    fn new_operations_evidence_policy_is_bounded_and_multiline() {
        for accepted in [
            "line one\nline two".to_owned(),
            "column\tvalue".to_owned(),
            "x".repeat(16_384),
        ] {
            assert!(
                operations_done_payload(
                    &operations_payload(&[accepted]),
                    OperationsPayloadPolicy::NewWrite,
                )
                .is_ok()
            );
        }
        for rejected in [
            " \n\t ".to_owned(),
            "carriage\rreturn".to_owned(),
            "control\u{0001}".to_owned(),
            "x".repeat(16_385),
        ] {
            assert!(
                operations_done_payload(
                    &operations_payload(&[rejected]),
                    OperationsPayloadPolicy::NewWrite,
                )
                .is_err()
            );
        }
        assert!(
            operations_done_payload(
                &operations_payload(&vec!["evidence".to_owned(); 64]),
                OperationsPayloadPolicy::NewWrite,
            )
            .is_ok()
        );
        assert!(
            operations_done_payload(
                &operations_payload(&vec!["evidence".to_owned(); 65]),
                OperationsPayloadPolicy::NewWrite,
            )
            .is_err()
        );
    }

    #[test]
    fn legacy_operations_evidence_preserves_the_historical_writer_language() {
        let legacy = operations_payload(&vec!["carriage\rreturn".to_owned(); 65]);
        assert!(operations_done_payload(&legacy, OperationsPayloadPolicy::LegacyRead).is_ok());
        let mut bad_digest = legacy;
        bad_digest["evidence"][0]["digest"] = serde_json::json!("0".repeat(64));
        assert!(operations_done_payload(&bad_digest, OperationsPayloadPolicy::LegacyRead).is_err());
    }

    proptest! {
        #[test]
        fn every_tightened_writer_evidence_payload_is_accepted_by_legacy_readers(
            values in proptest::collection::vec("[ -~\\n\\t]{1,128}", 0..65),
        ) {
            let payload = operations_payload(&values);
            prop_assume!(operations_done_payload(
                &payload,
                OperationsPayloadPolicy::NewWrite,
            ).is_ok());
            prop_assert!(operations_done_payload(
                &payload,
                OperationsPayloadPolicy::LegacyRead,
            ).is_ok());
        }
    }

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

    #[test]
    fn legacy_requirement_convergence_allowlist_is_exact() {
        for &(done_oid, task_id, task_oid, manifest_oid) in LEGACY_REQUIREMENT_CONVERGENCE {
            assert!(legacy_requirement_convergence(
                done_oid,
                task_id,
                task_oid,
                manifest_oid,
            ));
        }

        let &(done_oid, task_id, task_oid, manifest_oid) = &LEGACY_REQUIREMENT_CONVERGENCE[0];
        assert!(!legacy_requirement_convergence(
            "0000000000000000000000000000000000000000",
            task_id,
            task_oid,
            manifest_oid,
        ));
        assert!(!legacy_requirement_convergence(
            done_oid,
            &format!("v2-{}", "0".repeat(64)),
            task_oid,
            manifest_oid,
        ));
        assert!(!legacy_requirement_convergence(
            done_oid,
            task_id,
            "0000000000000000000000000000000000000000",
            manifest_oid,
        ));
        assert!(!legacy_requirement_convergence(
            done_oid,
            task_id,
            task_oid,
            "0000000000000000000000000000000000000000",
        ));
    }

    #[test]
    fn current_convergence_rejects_future_proofless_and_noncanonical_evidence() {
        let id = format!("v2-{}", "a".repeat(64));
        let first = format!("v2-{}", "b".repeat(64));
        let second = format!("v2-{}", "c".repeat(64));
        let task_oid = "1111111111111111111111111111111111111111";
        let manifest = "2222222222222222222222222222222222222222";
        let task = serde_json::json!({
            "requirements": [
                {"taskId": second, "taskOid": "3333333333333333333333333333333333333333"},
                {"taskId": first, "taskOid": "4444444444444444444444444444444444444444"},
            ],
        });
        let mut value = serde_json::json!({
            "children": [],
            "logicalId": "0".repeat(64),
            "manifestOid": manifest,
            "operationId": "test-operation",
            "taskOid": task_oid,
        });
        assert!(
            current_convergence_evidence(
                "5555555555555555555555555555555555555555",
                &id,
                &value,
                &task,
            )
            .is_err()
        );

        value["requirements"] = serde_json::json!([
            [
                model::state_ref("done", &first),
                "6666666666666666666666666666666666666666"
            ],
            [
                model::state_ref("done", &second),
                "7777777777777777777777777777777777777777"
            ],
        ]);
        value["logicalId"] = serde_json::json!(model::framed_digest(
            "converge-requirements-logical",
            &[
                &id,
                "test-operation",
                manifest,
                "[]",
                &serde_json::to_string(&value["requirements"]).unwrap(),
            ],
        ));
        assert!(
            current_convergence_evidence(
                "5555555555555555555555555555555555555555",
                &id,
                &value,
                &task,
            )
            .is_ok()
        );

        value["requirements"].as_array_mut().unwrap().swap(0, 1);
        assert!(
            current_convergence_evidence(
                "5555555555555555555555555555555555555555",
                &id,
                &value,
                &task,
            )
            .is_err()
        );
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

#[tracing::instrument(skip_all, name = "validate.waiting")]
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
