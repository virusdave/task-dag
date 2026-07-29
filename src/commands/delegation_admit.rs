use super::print_json;
use crate::{
    Result,
    cli::DelegateAdmit,
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::json;

pub(crate) fn admit(args: DelegateAdmit) -> Result<()> {
    model::bounded("source remote", &args.source_remote, 4096)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    let intent_ref = model::delegation_intent_ref(&args.operation_id);
    let remote = repository::advertise_remote(
        &args.source_remote,
        &[intent_ref.clone(), ACTIVATION.into()],
    )?;
    let intent_oid = remote
        .refs
        .get(&intent_ref)
        .ok_or("source does not advertise delegation intent")?;
    let source_activation_oid = remote
        .refs
        .get(ACTIVATION)
        .ok_or("source does not advertise v2 activation")?;
    repository::materialize_remote(
        &args.source_remote,
        &[intent_oid.clone(), source_activation_oid.clone()],
    )?;
    let intent = crate::validators::intent(intent_oid)?;
    let source_repository_id = intent["sourceRepositoryId"]
        .as_str()
        .ok_or("validated intent lacks source repository ID")?;
    let admission_ref = model::delegation_admission_ref(source_repository_id, &args.operation_id);
    let replay = repository::advertise(std::slice::from_ref(&admission_ref))?;
    if let Some(oid) = replay.refs.get(&admission_ref) {
        repository::materialize(std::slice::from_ref(oid))?;
        let admission = crate::validators::admission(oid)?;
        return if admission["intentOid"].as_str() == Some(intent_oid.as_str()) {
            print_json(
                &json!({"admissionOid":oid,"admissionRef":admission_ref,"taskId":admission["targetTaskId"],"taskOid":admission["targetTaskOid"]}),
            )
        } else {
            Err("delegation admission operation already has different semantics".into())
        };
    }
    let source_activation = crate::validators::activation(source_activation_oid)?;
    let (activated_source_repository_id, source_fleet_digest, source_fleet) =
        crate::validators::activation_identity(&source_activation)?;
    if intent["operationId"] != args.operation_id
        || intent["sourceRepositoryId"] != activated_source_repository_id
        || intent["fleetDigest"] != source_fleet_digest
    {
        return Err("source activation does not authorize the advertised intent".into());
    }
    let target_task_id = intent["targetTaskId"]
        .as_str()
        .ok_or("validated intent lacks target Task-ID")?;
    let repository_path = intent["repositoryPath"]
        .as_array()
        .ok_or("validated intent lacks repository path")?;
    if repository_path.iter().any(|entry| {
        entry
            .as_str()
            .is_none_or(|id| !source_fleet.iter().any(|member| member == id))
    }) {
        return Err("delegation repository path contains a non-fleet repository".into());
    }
    let mut patterns = repository::lifecycle_patterns(target_task_id);
    patterns.extend([admission_ref.clone(), ACTIVATION.into(), JOURNAL.into()]);
    let snap = repository::advertise(&patterns)?;
    if let Some(oid) = snap.refs.get(&admission_ref) {
        repository::materialize(std::slice::from_ref(oid))?;
        let admission = crate::validators::admission(oid)?;
        return if admission["intentOid"].as_str() == Some(intent_oid.as_str()) {
            print_json(
                &json!({"admissionOid":oid,"admissionRef":admission_ref,"taskId":admission["targetTaskId"],"taskOid":admission["targetTaskOid"]}),
            )
        } else {
            Err("delegation admission operation already has different semantics".into())
        };
    }
    repository::validate_snapshot(&snap)?;
    let local_activation_oid = snap
        .refs
        .get(ACTIVATION)
        .ok_or("checked snapshot lacks activation")?;
    let local_activation = crate::validators::activation(local_activation_oid)?;
    let (target_repository_id, target_fleet_digest, _) =
        crate::validators::activation_identity(&local_activation)?;
    if intent["targetRepositoryId"] != target_repository_id
        || source_fleet_digest != target_fleet_digest
    {
        return Err("target activation identity does not match delegation intent".into());
    }
    repository::ensure_new(&snap, target_task_id)?;
    let task = git::commit(
        &json!({"description":intent["description"],"formatVersion":2,"operationId":args.operation_id,"requirements":[],"structuralParent":null,"taskId":target_task_id,"title":intent["title"]}),
        &[],
    )?;
    let frontier = git::commit(
        &json!({"formatVersion":2,"operationId":args.operation_id,"taskId":target_task_id,"taskOid":task}),
        std::slice::from_ref(&task),
    )?;
    let admission = git::commit(
        &json!({"fleetDigest":source_fleet_digest,"formatVersion":2,"initialLifecycleOid":frontier,"intentOid":intent_oid,"operationId":args.operation_id,"sourceRepositoryId":source_repository_id,"targetRepositoryId":target_repository_id,"targetTaskId":target_task_id,"targetTaskOid":task}),
        &[intent_oid.clone(), task.clone(), frontier.clone()],
    )?;
    crate::validators::admission(&admission)?;
    let frontier_ref = model::state_ref("frontier", target_task_id);
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: admission_ref.clone(),
            old: None,
            new: Some(admission.clone()),
        },
        Update {
            semantic_ref: frontier_ref.clone(),
            old: None,
            new: Some(frontier.clone()),
        },
    ]);
    let outputs = vec![
        (admission_ref.clone(), admission.clone()),
        (frontier_ref, frontier),
    ];
    let transition = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        local_activation_oid,
        &args.operation_id,
        &updates,
        &outputs,
    )?;
    repository::mutate(&snap, updates, &transition)?;
    print_json(
        &json!({"admissionOid":admission,"admissionRef":admission_ref,"taskId":target_task_id,"taskOid":task}),
    )
}
