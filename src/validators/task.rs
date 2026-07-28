use super::{digest, object};
use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) fn task(object_oid: &str, expected_id: &str) -> Result<Value> {
    let value = object(
        object_oid,
        "Task",
        &[
            "formatVersion",
            "operationId",
            "requirements",
            "structuralParent",
            "taskId",
            "title",
            "description",
        ],
        &[&[], &["createSemanticId"]],
    )?;
    let own_id = value["taskId"].as_str().ok_or("Task taskId malformed")?;
    model::valid_id(own_id)?;
    if own_id != expected_id {
        return Err("Task object's own taskId is wrong".into());
    }
    model::bounded(
        "Task operationId",
        value["operationId"]
            .as_str()
            .ok_or("Task operationId malformed")?,
        256,
    )?;
    model::bounded(
        "Task title",
        value["title"].as_str().ok_or("Task title malformed")?,
        512,
    )?;
    model::bounded(
        "Task description",
        value["description"]
            .as_str()
            .ok_or("Task description malformed")?,
        16_384,
    )?;
    if let Some(v) = value.get("createSemanticId") {
        digest("Task createSemanticId", v)?;
    }
    let requirements = value["requirements"]
        .as_array()
        .ok_or("Task requirements malformed")?;
    let structural = &value["structuralParent"];
    let mut expected = Vec::new();
    if !structural.is_null() {
        if structural.as_object().map(|m| m.len()) != Some(2) {
            return Err("Task structural parent has unknown fields".into());
        }
        let parent_id = structural["taskId"]
            .as_str()
            .ok_or("Task structural parent Task-ID malformed")?;
        model::valid_id(parent_id)?;
        let parent_oid = structural["taskOid"]
            .as_str()
            .ok_or("Task structural parent OID malformed")?;
        model::oid(parent_oid)?;
        expected.push(parent_oid.to_owned());
    }
    let mut seen = BTreeSet::new();
    for requirement in requirements {
        if requirement.as_object().map(|m| m.len()) != Some(2) {
            return Err("Task requirement has missing or unknown fields".into());
        }
        let id = requirement["taskId"]
            .as_str()
            .ok_or("Task requirement Task-ID malformed")?;
        model::valid_id(id)?;
        if !seen.insert(id) {
            return Err("Task has duplicate requirement".into());
        }
        let oid = requirement["taskOid"]
            .as_str()
            .ok_or("Task requirement OID malformed")?;
        model::oid(oid)?;
        expected.push(oid.into());
    }
    if git::parents(object_oid)? != expected {
        return Err("Task immediate parent ordering is malformed".into());
    }
    Ok(value)
}
