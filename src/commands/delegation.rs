use super::{print_json, timestamp};
use crate::{
    Result,
    cli::DelegateCreate,
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::json;

fn replay_intent(oid: &str, args: &DelegateCreate) -> Result<serde_json::Value> {
    repository::materialize(&[oid.into()])?;
    let value = crate::validators::intent(oid)?;
    let source_repository_id = value["sourceRepositoryId"]
        .as_str()
        .ok_or("validated delegation source repository ID is absent")?;
    let fleet_digest = value["fleetDigest"]
        .as_str()
        .ok_or("validated delegation fleet digest is absent")?;
    let semantic = model::framed_digest(
        "delegation-intent-semantics",
        &[
            &args.task_id,
            &args.claim_token,
            source_repository_id,
            &args.target_repository_id,
            &args.operation_id,
            &args.title,
            &args.description,
            fleet_digest,
        ],
    );
    if value["semanticId"] != semantic {
        return Err("delegation operation was already used with different semantics".into());
    }
    Ok(
        json!({"intentOid":oid,"intentRef":model::delegation_intent_ref(&args.operation_id),"targetTaskId":value["targetTaskId"]}),
    )
}

pub(crate) fn create(args: DelegateCreate) -> Result<()> {
    model::valid_id(&args.task_id)?;
    model::repository_id(&args.target_repository_id)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    model::bounded("title", &args.title, 512)?;
    model::bounded("description", &args.description, 16_384)?;
    let reference = model::delegation_intent_ref(&args.operation_id);
    let replay = repository::advertise(std::slice::from_ref(&reference))?;
    if let Some(oid) = replay.refs.get(&reference) {
        return print_json(&replay_intent(oid, &args)?);
    }
    let mut patterns = repository::lifecycle_patterns(&args.task_id);
    patterns.extend([reference.clone(), ACTIVATION.into(), JOURNAL.into()]);
    let snap = repository::advertise(&patterns)?;
    if let Some(oid) = snap.refs.get(&reference) {
        return print_json(&replay_intent(oid, &args)?);
    }
    repository::validate_snapshot(&snap)?;
    let activation_oid = snap
        .refs
        .get(ACTIVATION)
        .ok_or("checked snapshot lacks activation")?;
    let activation = crate::validators::activation(activation_oid)?;
    let (source_repository_id, fleet_digest, fleet) =
        crate::validators::activation_identity(&activation)?;
    if source_repository_id == args.target_repository_id
        || !fleet.contains(&args.target_repository_id)
    {
        return Err(
            "delegation target must be a different repository in the activated fleet".into(),
        );
    }
    let target_task_id = model::task_id(
        "delegated-task",
        &[
            &source_repository_id,
            &args.target_repository_id,
            &args.operation_id,
        ],
    );
    let semantic = model::framed_digest(
        "delegation-intent-semantics",
        &[
            &args.task_id,
            &args.claim_token,
            &source_repository_id,
            &args.target_repository_id,
            &args.operation_id,
            &args.title,
            &args.description,
            &fleet_digest,
        ],
    );
    repository::exclusive(&snap, &args.task_id, "active")?;
    let active_ref = model::state_ref("active", &args.task_id);
    let active = snap.refs[&active_ref].clone();
    repository::materialize(std::slice::from_ref(&active))?;
    let claim = model::validate_claim(
        git::object_json(&active)?,
        &args.claim_token,
        &args.task_id,
        timestamp()?,
    )?;
    let intent = git::commit(
        &json!({"description":args.description,"fleetDigest":fleet_digest,"formatVersion":2,"operationId":args.operation_id,"repositoryPath":[source_repository_id,args.target_repository_id],"semanticId":semantic,"sourceRepositoryId":source_repository_id,"sourceTaskId":args.task_id,"sourceTaskOid":claim.task_oid,"targetRepositoryId":args.target_repository_id,"targetTaskId":target_task_id,"title":args.title}),
        &[],
    )?;
    crate::validators::intent(&intent)?;
    let waiting_ref = model::state_ref("waiting", &args.task_id);
    let waiting = git::commit(
        &json!({"formatVersion":2,"intentOid":intent,"intentRef":reference,"operationId":args.operation_id,"parentTaskId":args.task_id,"parentTaskOid":claim.task_oid,"semanticId":semantic,"targetTaskId":target_task_id}),
        &[active.clone(), claim.task_oid.clone(), intent.clone()],
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: active_ref,
            old: Some(active),
            new: None,
        },
        Update {
            semantic_ref: reference.clone(),
            old: None,
            new: Some(intent.clone()),
        },
        Update {
            semantic_ref: waiting_ref.clone(),
            old: None,
            new: Some(waiting.clone()),
        },
    ]);
    let outputs = vec![(reference.clone(), intent.clone()), (waiting_ref, waiting)];
    let journal = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        activation_oid,
        &args.operation_id,
        &updates,
        &outputs,
    )?;
    repository::mutate(&snap, updates, &journal)?;
    print_json(&json!({"intentOid":intent,"intentRef":reference,"targetTaskId":target_task_id}))
}
