use crate::{Result, git, model, repository};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    format_version: u64,
    domain: String,
    operation_id: String,
    semantic_digest: String,
    outputs: Value,
}

pub(crate) fn reference(domain: &str, operation: &str) -> String {
    format!(
        "refs/heads/tasks/operations/{domain}/{}",
        model::framed_digest("operation-receipt-key", &[domain, operation])
    )
}

/// Performs the required O(1), exact-ref replay lookup before any lifecycle discovery.
pub(crate) fn replay(domain: &str, operation: &str, semantic: &str) -> Result<Option<Value>> {
    model::bounded("operation-id", operation, 256)?;
    let reference = reference(domain, operation);
    let snap = repository::advertise(std::slice::from_ref(&reference))?;
    let Some(oid) = snap.refs.get(&reference) else {
        return Ok(None);
    };
    repository::materialize(std::slice::from_ref(oid))?;
    let receipt: Receipt = serde_json::from_value(git::object_json(oid)?)
        .map_err(|e| format!("operation receipt malformed: {e}"))?;
    if receipt.format_version != 2 || receipt.domain != domain || receipt.operation_id != operation
    {
        return Err("operation receipt identity is malformed".into());
    }
    if receipt.semantic_digest != semantic {
        return Err("operation ID was already used with different semantics".into());
    }
    let parents = git::parents(oid)?;
    if parents.is_empty() {
        return Err("operation receipt has no immediate output parent".into());
    }
    validate_outputs(domain, &receipt.outputs)?;
    let reconstructed = reconstruct_outputs(domain, &parents)?;
    if receipt.outputs != reconstructed {
        return Err(
            "operation receipt outputs do not exactly match validated output objects".into(),
        );
    }
    Ok(Some(receipt.outputs))
}

fn reconstruct_outputs(domain: &str, parents: &[String]) -> Result<Value> {
    let state = match domain {
        "create" => {
            if parents.len() != 2 {
                return Err("create receipt output parent ordering malformed".into());
            }
            let raw = git::object_json(&parents[0])?;
            let id = raw["taskId"]
                .as_str()
                .ok_or("receipt output Task-ID malformed")?;
            let state = if raw.get("claimToken").is_some() {
                "active"
            } else {
                "frontier"
            };
            let value = crate::validators::lifecycle(state, &parents[0], id)?;
            crate::validators::task(&parents[1], id)?;
            if value["taskOid"] != parents[1] {
                return Err("create receipt Task parent mismatch".into());
            }
            return Ok(
                json!({"claimToken":value.get("claimToken"),"owner":value.get("owner"),"ref":model::state_ref(state,id),"stateOid":parents[0],"taskId":id,"taskOid":parents[1]}),
            );
        }
        "claim" | "renew" => Some("active"),
        "release" | "reap" | "unblock" => Some("frontier"),
        "block" => Some("blocked"),
        _ => None,
    };
    if let Some(state) = state {
        if parents.len() != 1 {
            return Err("receipt state output parent ordering malformed".into());
        }
        let id = git::object_json(&parents[0])?["taskId"]
            .as_str()
            .ok_or("receipt state Task-ID malformed")?
            .to_owned();
        let value = crate::validators::lifecycle(state, &parents[0], &id)?;
        return Ok(match domain {
            "claim" => {
                json!({"claimToken":value["claimToken"],"expiresAt":value["expiresAt"],"owner":value["owner"],"stateOid":parents[0],"taskId":id})
            }
            "renew" => {
                json!({"claimToken":value["claimToken"],"expiresAt":value["expiresAt"],"taskId":id})
            }
            "block" => json!({"blockLease":parents[0],"taskId":id}),
            "unblock" => json!({"taskId":id}),
            _ => json!({}),
        });
    } else if domain == "breakdown" {
        if parents.len() != 1 {
            return Err("breakdown receipt output parent ordering malformed".into());
        }
        let raw = git::object_json(&parents[0])?;
        let id = raw["parentTaskId"]
            .as_str()
            .ok_or("receipt parent Task-ID malformed")?;
        let value = crate::validators::waiting(&parents[0], id)?;
        return Ok(
            json!({"children":value["children"],"manifestOid":parents[0],"parentTaskId":id}),
        );
    } else if matches!(domain, "init" | "activate-runtime") {
        if parents.len() != 1 {
            return Err("activation receipt output parent ordering malformed".into());
        }
        crate::validators::activation(&parents[0])?;
        return Ok(json!({}));
    }
    Err("operation receipt domain is unsupported".into())
}

fn validate_outputs(domain: &str, outputs: &Value) -> Result<()> {
    let map = outputs
        .as_object()
        .ok_or("operation receipt outputs are not an object")?;
    let required: &[&str] = match domain {
        "create" | "breakdown" | "claim" | "renew" => match domain {
            "create" => &[
                "claimToken",
                "owner",
                "ref",
                "stateOid",
                "taskId",
                "taskOid",
            ],
            "breakdown" => &["children", "manifestOid", "parentTaskId"],
            "claim" => &["claimToken", "expiresAt", "owner", "stateOid", "taskId"],
            _ => &["claimToken", "expiresAt", "taskId"],
        },
        "block" => &["blockLease", "taskId"],
        "unblock" => &["taskId"],
        "init" | "release" | "reap" | "activate-runtime" => &[],
        _ => return Err("operation receipt domain is unsupported".into()),
    };
    if map.len() != required.len() || !required.iter().all(|key| map.contains_key(*key)) {
        return Err("operation receipt output schema is malformed".into());
    }
    for key in ["stateOid", "taskOid", "manifestOid", "blockLease"] {
        if let Some(value) = map.get(key) {
            model::oid(value.as_str().ok_or("receipt output OID malformed")?)?;
        }
    }
    for key in ["taskId", "parentTaskId"] {
        if let Some(value) = map.get(key) {
            model::valid_id(value.as_str().ok_or("receipt output Task-ID malformed")?)?;
        }
    }
    Ok(())
}

pub(crate) fn create(
    domain: &str,
    operation: &str,
    semantic: &str,
    outputs: Value,
    output_oids: &[String],
) -> Result<(String, String)> {
    if output_oids.is_empty() {
        return Err("operation receipt requires at least one output object".into());
    }
    let oid = git::commit(
        &serde_json::to_value(Receipt {
            format_version: 2,
            domain: domain.into(),
            operation_id: operation.into(),
            semantic_digest: semantic.into(),
            outputs,
        })
        .map_err(|e| e.to_string())?,
        output_oids,
    )?;
    Ok((reference(domain, operation), oid))
}
