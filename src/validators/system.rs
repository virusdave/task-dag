use super::digest;
use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

fn activation_record(oid: &str, inspect_floor_parent: bool) -> Result<(Value, Vec<String>)> {
    model::oid(oid)?;
    let value = git::object_json(oid)?;
    let map = value
        .as_object()
        .ok_or("activation record is not an object")?;
    let format = value["formatVersion"]
        .as_u64()
        .ok_or("activation formatVersion malformed")?;
    let mut expected: BTreeSet<&str> = [
        "allowedRuntimeCommits",
        "epoch",
        "formatVersion",
        "state",
        "trustedFloor",
    ]
    .into_iter()
    .collect();
    if format == 3 {
        expected.extend(["fleetDigest", "fleetRepositoryIds", "repositoryId"]);
    } else if format != 2 {
        return Err("activation formatVersion is not 2 or 3".into());
    }
    if value.get("logicalId").is_some() {
        expected.extend(["logicalId", "operationId"]);
    }
    if map.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        return Err("activation record has missing or unknown fields".into());
    }
    if value["state"] != "enabled" {
        return Err("activation state malformed".into());
    }
    model::oid(
        value["trustedFloor"]
            .as_str()
            .ok_or("activation trustedFloor malformed")?,
    )?;
    let runtimes = value["allowedRuntimeCommits"]
        .as_array()
        .ok_or("activation runtimes malformed")?;
    let parents = git::parents(oid)?;
    for runtime in runtimes {
        model::oid(runtime.as_str().ok_or("activation runtime malformed")?)?;
    }
    if format == 3 {
        digest("activation fleetDigest", &value["fleetDigest"])?;
        let repository_id = value["repositoryId"]
            .as_str()
            .ok_or("activation repositoryId malformed")?;
        model::repository_id(repository_id)?;
        let fleet = value["fleetRepositoryIds"]
            .as_array()
            .ok_or("activation fleetRepositoryIds malformed")?;
        if fleet.is_empty() || fleet.len() > 256 {
            return Err("activation fleet size malformed".into());
        }
        let mut ids = Vec::with_capacity(fleet.len());
        for id in fleet {
            let id = id
                .as_str()
                .ok_or("activation fleet repository ID malformed")?;
            model::repository_id(id)?;
            ids.push(id);
        }
        if !ids.windows(2).all(|pair| pair[0] < pair[1])
            || !ids.contains(&repository_id)
            || value["fleetDigest"] != model::framed_digest("fleet-repository-ids-v1", &ids)
        {
            return Err("activation fleet identity is not canonical".into());
        }
    }
    match value.get("logicalId") {
        None => {
            if value["epoch"] != 1
                || runtimes.len() != 1
                || !matches!(parents.len(), 1 | 2)
                || parents[0] != runtimes[0].as_str().ok_or("activation runtime malformed")?
            {
                return Err("activation genesis shape is malformed".into());
            }
            let floor = value["trustedFloor"].as_str().unwrap();
            if (parents.len() == 2 && parents[1] != floor)
                || (inspect_floor_parent
                    && parents.len() == 1
                    && git::first_parent(&parents[0])? != floor)
            {
                return Err("activation genesis trusted-floor relation is malformed".into());
            }
        }
        Some(logical) => {
            digest("activation logicalId", logical)?;
            model::bounded(
                "activation operationId",
                value["operationId"]
                    .as_str()
                    .ok_or("activation operationId malformed")?,
                256,
            )?;
            if value["epoch"].as_u64().filter(|e| *e >= 2).is_none()
                || !(runtimes.len() == 2 || (format == 3 && runtimes.len() == 1))
                || parents.len() != 2
            {
                return Err("activation rollover shape is malformed".into());
            }
            if parents[1]
                != runtimes
                    .last()
                    .ok_or("activation runtimes malformed")?
                    .as_str()
                    .ok_or("activation candidate malformed")?
            {
                return Err("activation rollover candidate relation is malformed".into());
            }
        }
    }
    Ok((value, parents))
}

#[tracing::instrument(skip_all, name = "validate.activation")]
pub(crate) fn activation(oid: &str) -> Result<Value> {
    let (value, parents) = activation_record(oid, true)?;
    if value.get("logicalId").is_some() {
        // The prior published activation is assumed valid. Validate only this
        // transition and its immediate predecessor; never replay activation
        // history on a normal command.
        let (prior, _) = activation_record(&parents[0], true)?;
        let runtimes = value["allowedRuntimeCommits"]
            .as_array()
            .ok_or("activation runtimes malformed")?;
        if value["epoch"].as_u64() != prior["epoch"].as_u64().and_then(|e| e.checked_add(1))
            || !prior["allowedRuntimeCommits"]
                .as_array()
                .ok_or("prior activation runtimes malformed")?
                .contains(&runtimes[0])
            || parents[0] == parents[1]
            || value["trustedFloor"] != prior["trustedFloor"]
        {
            return Err("activation rollover predecessor relation is malformed".into());
        }
        if prior["formatVersion"] == 3
            && (value["formatVersion"] != 3 || value["repositoryId"] != prior["repositoryId"])
        {
            return Err("activation v3 identity cannot be removed or changed".into());
        }
        if value["formatVersion"] == 3 {
            let candidate = parents[1].as_str();
            let repository_id = value["repositoryId"].as_str().unwrap();
            let fleet_digest = value["fleetDigest"].as_str().unwrap();
            if value["logicalId"]
                != model::framed_digest(
                    "activate-runtime-logical-v3",
                    &[
                        candidate,
                        &parents[0],
                        value["operationId"].as_str().unwrap(),
                        repository_id,
                        fleet_digest,
                    ],
                )
            {
                return Err("activation v3 logicalId is malformed".into());
            }
            let runtimes = value["allowedRuntimeCommits"].as_array().unwrap();
            if runtimes.len() == 2 && runtimes[0] == runtimes[1] {
                return Err("activation runtimes must be unique".into());
            }
        }
    }
    Ok(value)
}

#[tracing::instrument(skip_all, name = "validate.activation-identity")]
pub(crate) fn activation_identity(value: &Value) -> Result<(String, String, Vec<String>)> {
    if value["formatVersion"] != 3 {
        return Err("cross-repository operations require activation identity v3".into());
    }
    let repository_id = value["repositoryId"]
        .as_str()
        .ok_or("activation repositoryId malformed")?
        .to_owned();
    let fleet_digest = value["fleetDigest"]
        .as_str()
        .ok_or("activation fleetDigest malformed")?
        .to_owned();
    let fleet = value["fleetRepositoryIds"]
        .as_array()
        .ok_or("activation fleetRepositoryIds malformed")?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "activation fleet repository ID malformed".to_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((repository_id, fleet_digest, fleet))
}
