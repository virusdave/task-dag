use super::{checked_identity, claim_token, default_owner, print_json, timestamp};
use crate::{
    Result,
    cli::Create,
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    receipts,
    repository::{self},
    runtime,
};
use serde_json::{Value, json};

pub(crate) fn init(trusted_floor: &str) -> Result<()> {
    model::oid(trusted_floor)?;
    let runtime = runtime()?;
    let operation = format!("init-{trusted_floor}");
    let semantic = model::framed_digest("init-semantics", &[trusted_floor, &runtime]);
    if let Some(outputs) = receipts::replay("init", &operation, &semantic)? {
        return print_json(&outputs);
    }
    let snap = repository::advertise(&[
        ACTIVATION.into(),
        JOURNAL.into(),
        "refs/heads/master".into(),
    ])?;
    if let Some(a) = snap.refs.get(ACTIVATION) {
        let j = snap
            .refs
            .get(JOURNAL)
            .ok_or("init replay requires activation and journal together")?;
        repository::materialize(&[a.clone(), j.clone()])?;
        let value = git::object_json(a)?;
        let journal = git::object_json(j)?;
        return if value
            == json!({"allowedRuntimeCommits":[runtime],"epoch":1,"formatVersion":2,"state":"enabled","trustedFloor":trusted_floor})
            && journal["activation"] == *a
            && journal["operationId"] == "init"
            && git::parents(j)?.first() == Some(a)
        {
            Ok(())
        } else {
            Err("v2 is already initialized differently".into())
        };
    }
    if snap.refs.contains_key(JOURNAL) {
        return Err("init found journal without activation".into());
    }
    repository::absent(&snap, JOURNAL)?;
    let master = snap
        .refs
        .get("refs/heads/master")
        .ok_or("origin does not advertise master")?;
    if master != trusted_floor {
        return Err("trusted floor must equal advertised master".into());
    }
    repository::materialize(std::slice::from_ref(master))?;
    git::output(["cat-file", "-e", &format!("{runtime}^{{commit}}")])
        .map_err(|_| "runtime candidate must already exist locally")?;
    if git::first_parent(&runtime)? != *master {
        return Err(
            "runtime commit immediate first parent must equal trusted floor and advertised master"
                .into(),
        );
    }
    let activation = git::commit(
        &json!({"allowedRuntimeCommits":[runtime],"epoch":1,"formatVersion":2,"state":"enabled","trustedFloor":trusted_floor}),
        std::slice::from_ref(&runtime),
    )?;
    let result = json!({});
    let (receipt_ref, receipt_oid) = receipts::create(
        "init",
        &operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&activation),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: ACTIVATION.into(),
            old: None,
            new: Some(activation.clone()),
        },
        Update {
            semantic_ref: receipt_ref.clone(),
            old: None,
            new: Some(receipt_oid.clone()),
        },
    ]);
    let j = journal::commit(
        None,
        &activation,
        "init",
        &updates,
        &[
            (ACTIVATION.into(), activation.clone()),
            (receipt_ref, receipt_oid),
        ],
    )?;
    repository::mutate(&snap, updates, &j)?;
    print_json(&result)
}

pub(crate) fn activate_runtime(candidate: &str, lease: &str, operation: &str) -> Result<()> {
    model::oid(candidate)?;
    model::oid(lease)?;
    model::bounded("operation-id", operation, 256)?;
    let semantic = model::framed_digest("activate-runtime-semantics", &[candidate, lease]);
    if let Some(outputs) = receipts::replay("activate-runtime", operation, &semantic)? {
        return print_json(&outputs);
    }
    let snap = repository::checked_snapshot(vec!["refs/heads/master".into()])?;
    let logical = model::framed_digest("activate-runtime-logical", &[candidate, lease, operation]);
    if let Some(current) = snap.refs.get(ACTIVATION) {
        repository::materialize(std::slice::from_ref(current))?;
        if git::object_json(current)?["logicalId"] == logical {
            return Ok(());
        }
    }
    if snap.refs.get(ACTIVATION).map(String::as_str) != Some(lease) {
        return Err("activation lease does not equal advertised activation".into());
    }
    git::output(["cat-file", "-e", &format!("{candidate}^{{commit}}")])
        .map_err(|_| "candidate must exist locally")?;
    let master = snap
        .refs
        .get("refs/heads/master")
        .ok_or("origin does not advertise master")?;
    if git::first_parent(candidate)? != *master {
        return Err("candidate immediate first parent must equal advertised master".into());
    }
    let prior = git::object_json(lease)?;
    let current = runtime()?;
    let epoch = prior["epoch"]
        .as_u64()
        .ok_or("activation epoch malformed")?
        .checked_add(1)
        .ok_or("activation epoch overflow")?;
    let activation = git::commit(
        &json!({"allowedRuntimeCommits":[current,candidate],"epoch":epoch,"formatVersion":2,"logicalId":logical,"operationId":operation,"state":"enabled","trustedFloor":prior["trustedFloor"]}),
        &[lease.into(), candidate.into()],
    )?;
    let result = json!({});
    let (receipt_ref, receipt_oid) = receipts::create(
        "activate-runtime",
        operation,
        &semantic,
        result.clone(),
        std::slice::from_ref(&activation),
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: ACTIVATION.into(),
            old: Some(lease.into()),
            new: Some(activation.clone()),
        },
        Update {
            semantic_ref: receipt_ref.clone(),
            old: None,
            new: Some(receipt_oid.clone()),
        },
    ]);
    let j = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        &activation,
        &logical,
        &updates,
        &[
            (ACTIVATION.into(), activation.clone()),
            (receipt_ref, receipt_oid),
        ],
    )?;
    repository::mutate(&snap, updates, &j)?;
    print_json(&result)
}
pub(crate) fn create(args: Create) -> Result<()> {
    model::bounded("operation-id", &args.operation_id, 256)?;
    model::bounded("title", &args.title, 512)?;
    model::bounded("description", &args.description, 16_384)?;
    let id = model::task_id("root", &[&args.operation_id]);
    let mut canonical_requires = args.requires.clone();
    canonical_requires.sort();
    let semantic = model::framed_digest(
        "create-semantics",
        &[
            &args.operation_id,
            &args.title,
            &args.description,
            if args.claim { "claim" } else { "frontier" },
            &serde_json::to_string(&canonical_requires).map_err(|e| e.to_string())?,
        ],
    );
    if let Some(outputs) = receipts::replay("create", &args.operation_id, &semantic)? {
        return print_json(&outputs);
    }
    let mut patterns = repository::lifecycle_patterns(&id);
    for requirement in &args.requires {
        patterns.extend(repository::lifecycle_patterns(requirement));
    }
    let snap = repository::checked_snapshot(patterns)?;
    if let Some((_, r, state_oid)) = model::lifecycle(&snap, &id).into_iter().next() {
        repository::materialize(std::slice::from_ref(&state_oid))?;
        let v = git::object_json(&state_oid)?;
        let task_oid = v["taskOid"]
            .as_str()
            .ok_or("lifecycle record lacks taskOid")?;
        let task_value = git::object_json(task_oid)?;
        if task_value["createSemanticId"] == semantic {
            return print_json(
                &json!({"claimToken":v.get("claimToken"),"owner":v.get("owner"),"ref":r,"stateOid":state_oid,"taskId":id,"taskOid":v["taskOid"]}),
            );
        }
    }
    repository::ensure_new(&snap, &id)?;
    repository::materialize_lifecycle(&snap, &args.requires)?;
    let requirements = model::requirements(&snap, &args.requires)?;
    if args.claim {
        model::readiness(&snap, &requirements)?;
    }
    let task = git::commit(
        &json!({"createSemanticId":semantic,"description":args.description,"formatVersion":2,"operationId":args.operation_id,"requirements":requirements,"structuralParent":Value::Null,"taskId":id,"title":args.title}),
        &model::requirement_oids(&requirements),
    )?;
    let now = timestamp()?;
    let token = if args.claim {
        Some(claim_token()?)
    } else {
        None
    };
    let owner = default_owner();
    let (host, session_id) = checked_identity(&owner)?;
    let (state, record) = if args.claim {
        (
            "active",
            json!({"attemptId":model::framed_digest("create-claim-attempt", &[&args.operation_id,&id,token.as_ref().unwrap()]),"claimToken":token,"claimedAt":now,"expiresAt":now+12*3600,"formatVersion":2,"host":host,"logicalId":model::framed_digest("create-logical", &["create",&args.operation_id]),"operationId":args.operation_id,"semanticId":semantic,"owner":owner,"sessionId":session_id,"taskId":id,"taskOid":task}),
        )
    } else {
        (
            "frontier",
            json!({"formatVersion":2,"operationId":args.operation_id,"semanticId":semantic,"taskId":id,"taskOid":task}),
        )
    };
    let state_oid = git::commit(&record, std::slice::from_ref(&task))?;
    let r = model::state_ref(state, &id);
    let result = json!({"claimToken":token,"owner":if args.claim {Some(owner)} else {None},"ref":r,"stateOid":state_oid,"taskId":id,"taskOid":task});
    let (receipt_ref, receipt_oid) = receipts::create(
        "create",
        &args.operation_id,
        &semantic,
        result.clone(),
        &[state_oid.clone(), task.clone()],
    )?;
    let updates = model::canonical_updates(vec![
        Update {
            semantic_ref: r.clone(),
            old: None,
            new: Some(state_oid.clone()),
        },
        Update {
            semantic_ref: receipt_ref.clone(),
            old: None,
            new: Some(receipt_oid.clone()),
        },
    ]);
    let mut outputs = vec![
        (r.clone(), state_oid.clone()),
        (format!("object/task/{id}"), task.clone()),
        (receipt_ref, receipt_oid),
    ];
    outputs.sort();
    let j = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        snap.refs.get(ACTIVATION).unwrap(),
        &args.operation_id,
        &updates,
        &outputs,
    )?;
    repository::mutate(&snap, updates, &j)?;
    print_json(&result)
}
