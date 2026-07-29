use super::{digest, object};
use crate::{Result, git, model};
use serde_json::Value;

pub(crate) fn intent(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "delegation intent",
        &[
            "description",
            "fleetDigest",
            "formatVersion",
            "operationId",
            "repositoryPath",
            "semanticId",
            "sourceRepositoryId",
            "sourceTaskId",
            "sourceTaskOid",
            "targetRepositoryId",
            "targetTaskId",
            "title",
        ],
        &[&[]],
    )?;
    if !git::parents(oid)?.is_empty() {
        return Err("delegation intent must be parentless".into());
    }
    let source_repository_id = value["sourceRepositoryId"]
        .as_str()
        .ok_or("delegation source repository ID malformed")?;
    let target_repository_id = value["targetRepositoryId"]
        .as_str()
        .ok_or("delegation target repository ID malformed")?;
    model::repository_id(source_repository_id)?;
    model::repository_id(target_repository_id)?;
    for key in ["sourceTaskId", "targetTaskId"] {
        model::valid_id(value[key].as_str().ok_or("delegation Task-ID malformed")?)?;
    }
    let operation = value["operationId"]
        .as_str()
        .ok_or("delegation operationId malformed")?;
    model::bounded("delegation operationId", operation, 256)?;
    let expected_target = model::task_id(
        "delegated-task",
        &[source_repository_id, target_repository_id, operation],
    );
    if value["targetTaskId"] != expected_target {
        return Err("delegation target Task-ID is not deterministic".into());
    }
    model::oid(
        value["sourceTaskOid"]
            .as_str()
            .ok_or("delegation source Task OID malformed")?,
    )?;
    model::bounded(
        "delegation title",
        value["title"]
            .as_str()
            .ok_or("delegation title malformed")?,
        512,
    )?;
    model::bounded(
        "delegation description",
        value["description"]
            .as_str()
            .ok_or("delegation description malformed")?,
        16_384,
    )?;
    digest("delegation fleetDigest", &value["fleetDigest"])?;
    digest("delegation semanticId", &value["semanticId"])?;
    let path = value["repositoryPath"]
        .as_array()
        .ok_or("delegation repository path malformed")?;
    if path.len() < 2 || path.len() > 256 {
        return Err("delegation repository path length malformed".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for id in path {
        let id = id
            .as_str()
            .ok_or("delegation repository path entry malformed")?;
        model::repository_id(id)?;
        if !seen.insert(id) {
            return Err("delegation repository path contains a cycle".into());
        }
    }
    if path.first() != Some(&value["sourceRepositoryId"])
        || path.last() != Some(&value["targetRepositoryId"])
    {
        return Err("delegation repository path endpoints are malformed".into());
    }
    Ok(value)
}

pub(crate) fn admission(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "delegation admission",
        &[
            "fleetDigest",
            "formatVersion",
            "initialLifecycleOid",
            "intentOid",
            "operationId",
            "sourceRepositoryId",
            "targetRepositoryId",
            "targetTaskId",
            "targetTaskOid",
        ],
        &[&[]],
    )?;
    let intent_oid = value["intentOid"]
        .as_str()
        .ok_or("admission intent OID malformed")?;
    let task_id = value["targetTaskId"]
        .as_str()
        .ok_or("admission target Task-ID malformed")?;
    let task_oid = value["targetTaskOid"]
        .as_str()
        .ok_or("admission target Task OID malformed")?;
    let lifecycle_oid = value["initialLifecycleOid"]
        .as_str()
        .ok_or("admission initial lifecycle OID malformed")?;
    model::oid(intent_oid)?;
    model::valid_id(task_id)?;
    model::oid(task_oid)?;
    model::oid(lifecycle_oid)?;
    let parents = git::parents(oid)?;
    if parents != [intent_oid, task_oid, lifecycle_oid] {
        return Err("delegation admission parent ordering is malformed".into());
    }
    let intent = intent(intent_oid)?;
    let task = super::task(task_oid, task_id)?;
    let lifecycle = super::lifecycle("frontier", lifecycle_oid, task_id)?;
    if value["operationId"] != intent["operationId"]
        || value["sourceRepositoryId"] != intent["sourceRepositoryId"]
        || value["targetRepositoryId"] != intent["targetRepositoryId"]
        || value["fleetDigest"] != intent["fleetDigest"]
        || value["targetTaskId"] != intent["targetTaskId"]
        || task["operationId"] != intent["operationId"]
        || task["title"] != intent["title"]
        || task["description"] != intent["description"]
        || task["requirements"] != serde_json::json!([])
        || !task["structuralParent"].is_null()
        || lifecycle["taskOid"] != task_oid
        || lifecycle["operationId"] != intent["operationId"]
    {
        return Err("delegation admission does not match intent and Task".into());
    }
    Ok(value)
}
