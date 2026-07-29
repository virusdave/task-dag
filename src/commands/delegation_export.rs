use super::print_json;
use crate::{
    Result,
    cli::DelegateExport,
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::json;

fn matches_request(value: &serde_json::Value, args: &DelegateExport) -> bool {
    value["sourceRepositoryId"] == args.source_repository_id
        && value["operationId"] == args.operation_id
}

fn replay(oid: &str, reference: &str, args: &DelegateExport) -> Result<()> {
    repository::materialize(std::slice::from_ref(&oid.to_owned()))?;
    let value = crate::validators::export(oid)?;
    if !matches_request(&value, args) {
        return Err("delegation export ref contains a different operation".into());
    }
    print_json(&json!({"exportOid":oid,"exportRef":reference,"resultDigest":value["resultDigest"]}))
}

#[cfg(test)]
mod tests {
    use super::matches_request;
    use crate::cli::DelegateExport;

    #[test]
    fn replay_rejects_valid_object_for_another_semantic_key() {
        let args = DelegateExport {
            source_repository_id:
                "repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            operation_id: "expected".into(),
        };
        assert!(!matches_request(
            &serde_json::json!({"sourceRepositoryId":args.source_repository_id,"operationId":"other"}),
            &args,
        ));
    }
}

pub(crate) fn export(args: DelegateExport) -> Result<()> {
    model::repository_id(&args.source_repository_id)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    let admission_ref =
        model::delegation_admission_ref(&args.source_repository_id, &args.operation_id);
    let export_ref = model::delegation_export_ref(&args.source_repository_id, &args.operation_id);
    let first = repository::advertise(&[admission_ref.clone(), export_ref.clone()])?;
    if let Some(oid) = first.refs.get(&export_ref) {
        return replay(oid, &export_ref, &args);
    }
    let admission_oid = first
        .refs
        .get(&admission_ref)
        .ok_or("delegation admission is absent")?;
    repository::materialize(std::slice::from_ref(admission_oid))?;
    let admission = crate::validators::admission(admission_oid)?;
    let task_id = admission["targetTaskId"]
        .as_str()
        .ok_or("validated admission lacks target Task-ID")?;
    let mut patterns = repository::lifecycle_patterns(task_id);
    patterns.extend([
        admission_ref,
        export_ref.clone(),
        ACTIVATION.into(),
        JOURNAL.into(),
    ]);
    let snap = repository::advertise(&patterns)?;
    if let Some(oid) = snap.refs.get(&export_ref) {
        return replay(oid, &export_ref, &args);
    }
    repository::validate_snapshot(&snap)?;
    repository::exclusive(&snap, task_id, "done")?;
    let done_oid = snap
        .refs
        .get(&model::state_ref("done", task_id))
        .ok_or("done lifecycle disappeared from checked snapshot")?;
    let done = crate::validators::lifecycle("done", done_oid, task_id)?;
    if done["taskOid"] != admission["targetTaskOid"] {
        return Err("delegated done evidence names the wrong Task".into());
    }
    let local_activation_oid = snap
        .refs
        .get(ACTIVATION)
        .ok_or("checked snapshot lacks activation")?;
    let local_activation = crate::validators::activation(local_activation_oid)?;
    let (target_repository_id, fleet_digest, _) =
        crate::validators::activation_identity(&local_activation)?;
    if admission["targetRepositoryId"] != target_repository_id
        || admission["fleetDigest"] != fleet_digest
    {
        return Err("current target activation does not authorize delegation export".into());
    }
    let task_oid = admission["targetTaskOid"]
        .as_str()
        .ok_or("validated admission lacks target Task OID")?;
    let result_digest = model::framed_digest(
        "delegation-export-result",
        &[
            &args.operation_id,
            &args.source_repository_id,
            &target_repository_id,
            task_id,
            task_oid,
            admission_oid,
            done_oid,
        ],
    );
    let export = git::commit(
        &json!({"admissionOid":admission_oid,"doneOid":done_oid,"fleetDigest":fleet_digest,"formatVersion":2,"operationId":args.operation_id,"resultDigest":result_digest,"sourceRepositoryId":args.source_repository_id,"targetRepositoryId":target_repository_id,"targetTaskId":task_id,"targetTaskOid":task_oid}),
        &[],
    )?;
    crate::validators::export(&export)?;
    let updates = vec![Update {
        semantic_ref: export_ref.clone(),
        old: None,
        new: Some(export.clone()),
    }];
    let transition = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        local_activation_oid,
        &args.operation_id,
        &updates,
        &[(export_ref.clone(), export.clone())],
    )?;
    repository::mutate(&snap, updates, &transition)?;
    print_json(&json!({"exportOid":export,"exportRef":export_ref,"resultDigest":result_digest}))
}
