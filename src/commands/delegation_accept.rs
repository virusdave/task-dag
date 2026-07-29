use super::print_json;
use crate::{
    Result,
    cli::DelegateAccept,
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::json;

fn matches_intent(
    value: &serde_json::Value,
    intent_oid: &str,
    intent: &serde_json::Value,
    operation_id: &str,
) -> bool {
    value["intentOid"].as_str() == Some(intent_oid)
        && value["operationId"] == operation_id
        && intent["operationId"] == operation_id
        && value["sourceRepositoryId"] == intent["sourceRepositoryId"]
        && value["sourceTaskId"] == intent["sourceTaskId"]
        && value["operationId"] == intent["operationId"]
}

fn replay(
    oid: &str,
    reference: &str,
    intent_oid: &str,
    intent: &serde_json::Value,
    operation_id: &str,
) -> Result<()> {
    repository::materialize(std::slice::from_ref(&oid.to_owned()))?;
    let value = crate::validators::accepted(oid)?;
    if !matches_intent(&value, intent_oid, intent, operation_id) {
        return Err("accepted delegation ref contains a different operation".into());
    }
    print_json(
        &json!({"acceptedOid":oid,"acceptedRef":reference,"resultDigest":value["resultDigest"],"taskId":value["sourceTaskId"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::matches_intent;

    #[test]
    fn replay_rejects_valid_acceptance_for_another_requested_operation() {
        let intent = serde_json::json!({
            "operationId":"other",
            "sourceRepositoryId":"repo-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sourceTaskId":format!("v2-{}", "a".repeat(64)),
        });
        let accepted = serde_json::json!({
            "intentOid":"1111111111111111111111111111111111111111",
            "operationId":"other",
            "sourceRepositoryId":intent["sourceRepositoryId"],
            "sourceTaskId":intent["sourceTaskId"],
        });
        assert!(!matches_intent(
            &accepted,
            "1111111111111111111111111111111111111111",
            &intent,
            "expected",
        ));
    }
}

pub(crate) fn accept(args: DelegateAccept) -> Result<()> {
    model::bounded("target remote", &args.target_remote, 4096)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    let intent_ref = model::delegation_intent_ref(&args.operation_id);
    let initial = repository::advertise(std::slice::from_ref(&intent_ref))?;
    let intent_oid = initial
        .refs
        .get(&intent_ref)
        .ok_or("local delegation intent is absent")?;
    repository::materialize(std::slice::from_ref(intent_oid))?;
    let intent = crate::validators::intent(intent_oid)?;
    let source_repository_id = intent["sourceRepositoryId"]
        .as_str()
        .ok_or("validated intent lacks source repository ID")?;
    let accepted_ref = model::delegation_accepted_ref(source_repository_id, &args.operation_id);
    let local_replay = repository::advertise(std::slice::from_ref(&accepted_ref))?;
    if let Some(oid) = local_replay.refs.get(&accepted_ref) {
        return replay(oid, &accepted_ref, intent_oid, &intent, &args.operation_id);
    }
    let export_ref = model::delegation_export_ref(source_repository_id, &args.operation_id);
    let remote = repository::advertise_remote(
        &args.target_remote,
        &[export_ref.clone(), ACTIVATION.into()],
    )?;
    let export_oid = remote
        .refs
        .get(&export_ref)
        .ok_or("target does not advertise delegation export")?;
    let target_activation_oid = remote
        .refs
        .get(ACTIVATION)
        .ok_or("target does not advertise v2 activation")?;
    repository::materialize_remote(
        &args.target_remote,
        &[export_oid.clone(), target_activation_oid.clone()],
    )?;
    let exported = crate::validators::export(export_oid)?;
    let target_activation = crate::validators::activation(target_activation_oid)?;
    let (target_repository_id, target_fleet_digest, _) =
        crate::validators::activation_identity(&target_activation)?;
    if exported["operationId"] != args.operation_id
        || exported["sourceRepositoryId"] != source_repository_id
        || exported["targetRepositoryId"] != target_repository_id
        || exported["fleetDigest"] != target_fleet_digest
        || exported["targetTaskId"] != intent["targetTaskId"]
    {
        return Err("target activation and export do not match local intent".into());
    }
    let source_task_id = intent["sourceTaskId"]
        .as_str()
        .ok_or("validated intent lacks source Task-ID")?;
    let mut patterns = repository::lifecycle_patterns(source_task_id);
    patterns.extend([
        intent_ref.clone(),
        accepted_ref.clone(),
        ACTIVATION.into(),
        JOURNAL.into(),
    ]);
    let snap = repository::advertise(&patterns)?;
    if let Some(oid) = snap.refs.get(&accepted_ref) {
        return replay(oid, &accepted_ref, intent_oid, &intent, &args.operation_id);
    }
    repository::validate_snapshot(&snap)?;
    repository::exclusive(&snap, source_task_id, "waiting")?;
    let waiting_ref = model::state_ref("waiting", source_task_id);
    let waiting_oid = snap
        .refs
        .get(&waiting_ref)
        .ok_or("delegated waiting lifecycle disappeared")?;
    let waiting = crate::validators::waiting(waiting_oid, source_task_id)?;
    if waiting["intentOid"].as_str() != Some(intent_oid.as_str())
        || waiting["operationId"] != args.operation_id
    {
        return Err("delegated waiting lifecycle does not match acceptance".into());
    }
    let local_activation_oid = snap
        .refs
        .get(ACTIVATION)
        .ok_or("checked snapshot lacks activation")?;
    let local_activation = crate::validators::activation(local_activation_oid)?;
    let (activated_source_id, source_fleet_digest, _) =
        crate::validators::activation_identity(&local_activation)?;
    if activated_source_id != source_repository_id || source_fleet_digest != target_fleet_digest {
        return Err("source activation identity does not match accepted export".into());
    }
    let accepted = git::commit(
        &json!({"exportOid":export_oid,"formatVersion":2,"intentOid":intent_oid,"operationId":args.operation_id,"resultDigest":exported["resultDigest"],"sourceRepositoryId":source_repository_id,"sourceTaskId":source_task_id,"targetRepositoryId":target_repository_id,"targetTaskId":exported["targetTaskId"],"targetTaskOid":exported["targetTaskOid"]}),
        &[intent_oid.clone(), export_oid.clone()],
    )?;
    crate::validators::accepted(&accepted)?;
    let parent_task_oid = waiting["parentTaskOid"]
        .as_str()
        .ok_or("validated waiting lifecycle lacks parent Task OID")?;
    let done = git::commit(
        &json!({"acceptedOid":accepted,"formatVersion":2,"intentOid":intent_oid,"logicalId":model::framed_digest("delegated-completion-logical", &[source_task_id,intent_oid,export_oid]),"operationId":args.operation_id,"taskId":source_task_id,"taskOid":parent_task_oid}),
        &[
            waiting_oid.clone(),
            parent_task_oid.into(),
            accepted.clone(),
        ],
    )?;
    crate::validators::lifecycle("done", &done, source_task_id)?;
    let done_ref = model::state_ref("done", source_task_id);
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: accepted_ref.clone(),
            old: None,
            new: Some(accepted.clone()),
        },
        Update {
            semantic_ref: done_ref.clone(),
            old: None,
            new: Some(done.clone()),
        },
        Update {
            semantic_ref: waiting_ref,
            old: Some(waiting_oid.clone()),
            new: None,
        },
    ]);
    let outputs = vec![(accepted_ref.clone(), accepted.clone()), (done_ref, done)];
    let transition = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        local_activation_oid,
        &args.operation_id,
        &updates,
        &outputs,
    )?;
    repository::mutate(&snap, updates, &transition)?;
    print_json(
        &json!({"acceptedOid":accepted,"acceptedRef":accepted_ref,"resultDigest":exported["resultDigest"],"taskId":source_task_id}),
    )
}
