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
