use super::{digest, object};
use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

fn activation_record(oid: &str) -> Result<(Value, Vec<String>)> {
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
                || (parents.len() == 1 && git::first_parent(&parents[0])? != floor)
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

pub(crate) fn activation(oid: &str) -> Result<Value> {
    let (value, parents) = activation_record(oid)?;
    if value.get("logicalId").is_some() {
        // The prior published activation is assumed valid. Validate only this
        // transition and its immediate predecessor; never replay activation
        // history on a normal command.
        let (prior, _) = activation_record(&parents[0])?;
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

struct JournalRecord {
    value: Value,
    updates: Vec<model::Update>,
    parents: Vec<String>,
    predecessor_count: usize,
}

fn shallow_journal(oid: &str) -> Result<JournalRecord> {
    let value = object(
        oid,
        "journal",
        &[
            "activation",
            "attemptId",
            "formatVersion",
            "logicalId",
            "operationId",
            "outputs",
            "resultDigest",
            "runtimeCommit",
            "updates",
        ],
        &[&[]],
    )?;
    let runtime = value["runtimeCommit"]
        .as_str()
        .ok_or("journal runtime malformed")?;
    model::oid(runtime)?;
    for key in ["attemptId", "logicalId", "resultDigest"] {
        digest(&format!("journal {key}"), &value[key])?;
    }
    let typed: Vec<model::Update> = serde_json::from_value(value["updates"].clone())
        .map_err(|e| format!("journal updates malformed: {e}"))?;
    let encoded = serde_json::to_string(&typed).map_err(|e| e.to_string())?;
    if value["resultDigest"] != model::digest(&encoded) {
        return Err("journal resultDigest does not match canonical updates".into());
    }
    if model::canonical_updates(typed.clone()) != typed {
        return Err("journal updates are not canonical".into());
    }
    for update in &typed {
        if update.old.is_none() && update.new.is_none() {
            return Err("journal update is a no-op".into());
        }
        if let Some(v) = update.old.as_deref() {
            model::oid(v)?;
        }
        if let Some(v) = update.new.as_deref() {
            model::oid(v)?;
        }
    }
    let outputs = value["outputs"]
        .as_array()
        .ok_or("journal outputs malformed")?;
    let mut expected = Vec::new();
    for output in outputs {
        if output.as_object().map(|m| m.len()) != Some(2) {
            return Err("journal output fields malformed".into());
        }
        model::nonempty(
            "journal output semanticRef",
            output["semanticRef"]
                .as_str()
                .ok_or("journal output ref malformed")?,
        )?;
        let output_oid = output["oid"]
            .as_str()
            .ok_or("journal output OID malformed")?;
        model::oid(output_oid)?;
        expected.push(output_oid.to_owned());
    }
    let mut sorted = outputs.clone();
    sorted.sort_by(|a, b| {
        a["semanticRef"]
            .as_str()
            .cmp(&b["semanticRef"].as_str())
            .then(a["oid"].as_str().cmp(&b["oid"].as_str()))
    });
    if *outputs != sorted {
        return Err("journal outputs are not canonical".into());
    }
    let parents = git::parents(oid)?;
    let predecessor_count = parents
        .len()
        .checked_sub(expected.len())
        .ok_or("journal output parent count malformed")?;
    if predecessor_count > 1 || parents[predecessor_count..] != expected {
        return Err("journal predecessor/output-parent ordering is malformed".into());
    }
    Ok(JournalRecord {
        value,
        updates: typed,
        parents,
        predecessor_count,
    })
}

pub(crate) fn journal(oid: &str, activation_oid: &str) -> Result<Value> {
    let record = shallow_journal(oid)?;
    if record.value["activation"] != activation_oid {
        return Err("journal activation does not equal advertised activation".into());
    }
    let activation = activation(activation_oid)?;
    let runtime = record.value["runtimeCommit"]
        .as_str()
        .ok_or("journal runtime malformed")?;
    if !activation["allowedRuntimeCommits"]
        .as_array()
        .ok_or("activation runtimes malformed")?
        .iter()
        .any(|r| r == runtime)
    {
        return Err("journal runtime is not authorized by activation".into());
    }
    if record.predecessor_count == 0 {
        let activation_updates: Vec<_> = record
            .updates
            .iter()
            .filter(|u| u.semantic_ref == model::ACTIVATION)
            .collect();
        let activation_outputs: Vec<_> = record.value["outputs"]
            .as_array()
            .ok_or("journal outputs malformed")?
            .iter()
            .filter(|o| o["semanticRef"] == model::ACTIVATION)
            .collect();
        let outputs = record.value["outputs"]
            .as_array()
            .ok_or("journal outputs malformed")?;
        if record.value["operationId"] != "init"
            || record.updates.len() != 2
            || outputs.len() != 2
            || record.updates.iter().any(|u| u.old.is_some())
            || activation_updates.len() != 1
            || activation_updates[0].new.as_deref() != Some(activation_oid)
            || activation_outputs.len() != 1
            || activation_outputs[0]["oid"] != activation_oid
            || record.updates.iter().any(|update| {
                update.new.as_ref().is_none_or(|oid| {
                    !outputs.iter().any(|output| {
                        output["semanticRef"] == update.semantic_ref
                            && output["oid"].as_str() == Some(oid.as_str())
                    })
                })
            })
        {
            return Err("journal genesis semantics are malformed".into());
        }
    } else {
        let predecessor = shallow_journal(&record.parents[0])?;
        if predecessor.value["activation"] != activation_oid {
            let activation_parents = git::parents(activation_oid)?;
            let rollover = record
                .updates
                .iter()
                .find(|u| u.semantic_ref == model::ACTIVATION);
            let output = record.value["outputs"]
                .as_array()
                .ok_or("journal outputs malformed")?
                .iter()
                .find(|o| o["semanticRef"] == model::ACTIVATION);
            if rollover.and_then(|u| u.old.as_deref())
                != activation_parents.first().map(String::as_str)
                || rollover.and_then(|u| u.new.as_deref()) != Some(activation_oid)
                || output.and_then(|o| o["oid"].as_str()) != Some(activation_oid)
            {
                return Err("activation rollover journal binding is malformed".into());
            }
        }
    }
    Ok(record.value)
}
