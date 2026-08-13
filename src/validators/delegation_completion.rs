use super::{digest, object};
use crate::{Result, git, model};
use serde_json::Value;

#[tracing::instrument(skip_all, name = "validate.delegation-export")]
pub(crate) fn export(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "delegation export",
        &[
            "admissionOid",
            "doneOid",
            "fleetDigest",
            "formatVersion",
            "operationId",
            "resultDigest",
            "sourceRepositoryId",
            "targetRepositoryId",
            "targetTaskId",
            "targetTaskOid",
        ],
        &[&[]],
    )?;
    if !git::parents(oid)?.is_empty() {
        return Err("delegation export must be parentless".into());
    }
    let operation = value["operationId"]
        .as_str()
        .ok_or("delegation export operationId malformed")?;
    model::bounded("delegation export operationId", operation, 256)?;
    let source = value["sourceRepositoryId"]
        .as_str()
        .ok_or("delegation export source repository ID malformed")?;
    let target = value["targetRepositoryId"]
        .as_str()
        .ok_or("delegation export target repository ID malformed")?;
    let task_id = value["targetTaskId"]
        .as_str()
        .ok_or("delegation export Task-ID malformed")?;
    let task_oid = value["targetTaskOid"]
        .as_str()
        .ok_or("delegation export Task OID malformed")?;
    let admission_oid = value["admissionOid"]
        .as_str()
        .ok_or("delegation export admission OID malformed")?;
    let done_oid = value["doneOid"]
        .as_str()
        .ok_or("delegation export done OID malformed")?;
    model::repository_id(source)?;
    model::repository_id(target)?;
    model::valid_id(task_id)?;
    model::oid(task_oid)?;
    model::oid(admission_oid)?;
    model::oid(done_oid)?;
    digest("delegation export fleetDigest", &value["fleetDigest"])?;
    digest("delegation export resultDigest", &value["resultDigest"])?;
    let expected = model::framed_digest(
        "delegation-export-result",
        &[
            operation,
            source,
            target,
            task_id,
            task_oid,
            admission_oid,
            done_oid,
        ],
    );
    if value["resultDigest"] != expected {
        return Err("delegation export result digest is malformed".into());
    }
    Ok(value)
}

#[tracing::instrument(skip_all, name = "validate.delegation-accepted")]
pub(crate) fn accepted(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "accepted delegation export",
        &[
            "exportOid",
            "formatVersion",
            "intentOid",
            "operationId",
            "resultDigest",
            "sourceRepositoryId",
            "sourceTaskId",
            "targetRepositoryId",
            "targetTaskId",
            "targetTaskOid",
        ],
        &[&[]],
    )?;
    let intent_oid = value["intentOid"]
        .as_str()
        .ok_or("accepted intent OID malformed")?;
    let export_oid = value["exportOid"]
        .as_str()
        .ok_or("accepted export OID malformed")?;
    model::oid(intent_oid)?;
    model::oid(export_oid)?;
    if git::parents(oid)? != [intent_oid, export_oid] {
        return Err("accepted delegation parent ordering is malformed".into());
    }
    let intent = super::intent(intent_oid)?;
    let exported = export(export_oid)?;
    if value["operationId"] != intent["operationId"]
        || value["operationId"] != exported["operationId"]
        || value["sourceRepositoryId"] != intent["sourceRepositoryId"]
        || value["sourceRepositoryId"] != exported["sourceRepositoryId"]
        || value["sourceTaskId"] != intent["sourceTaskId"]
        || value["targetRepositoryId"] != intent["targetRepositoryId"]
        || value["targetRepositoryId"] != exported["targetRepositoryId"]
        || value["targetTaskId"] != intent["targetTaskId"]
        || value["targetTaskId"] != exported["targetTaskId"]
        || value["targetTaskOid"] != exported["targetTaskOid"]
        || value["resultDigest"] != exported["resultDigest"]
    {
        return Err("accepted delegation does not match intent and export".into());
    }
    Ok(value)
}
