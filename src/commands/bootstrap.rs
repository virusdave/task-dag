use super::{checked_identity, claim_token, default_owner, print_json, timestamp};
use crate::{
    Result,
    cli::Create,
    git,
    model::{self, ACTIVATION, Update},
    receipts,
    repository::{self},
    runtime, runtime_authority,
};
use serde_json::{Value, json};

fn legacy_v2_test_write() -> bool {
    cfg!(feature = "test-seam") && std::env::var_os("TASKDAG_TEST_LEGACY_ACTIVATION").is_some()
}

fn identity_fields(repository_id: &str, fleet: &[String]) -> Result<Value> {
    model::repository_id(repository_id)?;
    if fleet.is_empty() || fleet.len() > 256 {
        return Err("fleet repository IDs must contain 1 through 256 entries".into());
    }
    let mut canonical = fleet.to_vec();
    for id in &canonical {
        model::repository_id(id)?;
    }
    canonical.sort();
    canonical.dedup();
    if canonical.len() != fleet.len()
        || canonical != fleet
        || !canonical.iter().any(|id| id == repository_id)
    {
        return Err(
            "fleet repository IDs must be sorted, unique, and contain repository-id".into(),
        );
    }
    let parts: Vec<_> = canonical.iter().map(String::as_str).collect();
    Ok(json!({
        "fleetDigest": model::framed_digest("fleet-repository-ids-v1", &parts),
        "fleetRepositoryIds": canonical,
        "repositoryId": repository_id,
    }))
}

pub(crate) fn init(
    trusted_floor: &str,
    repository_id: Option<&str>,
    fleet: &[String],
) -> Result<()> {
    model::oid(trusted_floor)?;
    let runtime = runtime()?;
    git::output(["cat-file", "-e", &format!("{runtime}^{{commit}}")])
        .map_err(|_| "embedded runtime must exist locally as a commit")?;
    runtime_authority::validate(&runtime)?;
    let operation = format!("init-{trusted_floor}");
    let identity = repository_id
        .map(|id| identity_fields(id, fleet))
        .transpose()?;
    if identity.is_none() {
        let legacy_semantic = model::framed_digest("init-semantics", &[trusted_floor, &runtime]);
        if let Some(outputs) = receipts::replay("init", &operation, &legacy_semantic)? {
            return print_json(&outputs);
        }
        if !legacy_v2_test_write() {
            return Err(
                "new v2 initialization is disabled; repository and fleet identity are required"
                    .into(),
            );
        }
    }
    let semantic = identity.as_ref().map_or_else(
        || model::framed_digest("init-semantics", &[trusted_floor, &runtime]),
        |identity| {
            model::framed_digest(
                "init-semantics",
                &[
                    trusted_floor,
                    &runtime,
                    identity["repositoryId"].as_str().unwrap(),
                    identity["fleetDigest"].as_str().unwrap(),
                ],
            )
        },
    );
    if let Some(outputs) = receipts::replay("init", &operation, &semantic)? {
        return print_json(&outputs);
    }
    let snap = repository::advertise(&[ACTIVATION.into(), "refs/heads/master".into()])?;
    if let Some(a) = snap.refs.get(ACTIVATION) {
        repository::materialize(std::slice::from_ref(a))?;
        let value = git::object_json(a)?;
        let expected = identity.as_ref().map_or_else(
            || json!({"allowedRuntimeCommits":[runtime],"epoch":1,"formatVersion":2,"state":"enabled","trustedFloor":trusted_floor}),
            |identity| json!({"allowedRuntimeCommits":[runtime],"epoch":1,"fleetDigest":identity["fleetDigest"],"fleetRepositoryIds":identity["fleetRepositoryIds"],"formatVersion":3,"repositoryId":identity["repositoryId"],"state":"enabled","trustedFloor":trusted_floor}),
        );
        return if value == expected && crate::validators::activation(a).is_ok() {
            Ok(())
        } else {
            Err("v2 is already initialized differently".into())
        };
    }
    let master = snap
        .refs
        .get("refs/heads/master")
        .ok_or("origin does not advertise master")?;
    if master != trusted_floor {
        return Err("trusted floor must equal advertised master".into());
    }
    repository::materialize(std::slice::from_ref(master))?;
    let activation_value = identity.as_ref().map_or_else(
        || json!({"allowedRuntimeCommits":[runtime],"epoch":1,"formatVersion":2,"state":"enabled","trustedFloor":trusted_floor}),
        |identity| json!({"allowedRuntimeCommits":[runtime],"epoch":1,"fleetDigest":identity["fleetDigest"],"fleetRepositoryIds":identity["fleetRepositoryIds"],"formatVersion":3,"repositoryId":identity["repositoryId"],"state":"enabled","trustedFloor":trusted_floor}),
    );
    let activation = git::commit(&activation_value, &[runtime, master.clone()])?;
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
    repository::mutate(updates)?;
    print_json(&result)
}

pub(crate) fn activate_runtime(
    candidate: &str,
    lease: &str,
    operation: &str,
    repository_id: Option<&str>,
    fleet: &[String],
) -> Result<()> {
    model::oid(candidate)?;
    model::oid(lease)?;
    model::bounded("operation-id", operation, 256)?;
    let requested_identity = repository_id
        .map(|id| identity_fields(id, fleet))
        .transpose()?;
    repository::materialize(&[lease.into()])?;
    let prior = crate::validators::activation(lease)?;
    if prior["formatVersion"] == 2 && requested_identity.is_none() {
        let legacy_semantic =
            model::framed_digest("activate-runtime-semantics", &[candidate, lease]);
        if let Some(outputs) = receipts::replay("activate-runtime", operation, &legacy_semantic)? {
            return print_json(&outputs);
        }
    }
    let identity = match (prior["formatVersion"].as_u64(), requested_identity) {
        (Some(2), Some(value)) => value,
        (Some(2), None) if legacy_v2_test_write() => Value::Null,
        (Some(2), None) => {
            return Err("v2 activation rollover requires repository and fleet identity".into());
        }
        (Some(3), None) => json!({
            "fleetDigest": prior["fleetDigest"],
            "fleetRepositoryIds": prior["fleetRepositoryIds"],
            "repositoryId": prior["repositoryId"],
        }),
        (Some(3), Some(value)) => {
            if value["repositoryId"] != prior["repositoryId"] {
                return Err("activation repository identity cannot change".into());
            }
            value
        }
        _ => return Err("activation formatVersion malformed".into()),
    };
    let semantic = if identity.is_null() {
        model::framed_digest("activate-runtime-semantics", &[candidate, lease])
    } else {
        model::framed_digest(
            "activate-runtime-semantics-v3",
            &[
                candidate,
                lease,
                identity["repositoryId"].as_str().unwrap(),
                identity["fleetDigest"].as_str().unwrap(),
            ],
        )
    };
    if let Some(outputs) = receipts::replay("activate-runtime", operation, &semantic)? {
        return print_json(&outputs);
    }
    // Runtime activation is the bootstrap boundary: the immutable candidate
    // may execute this one command before it appears in the leased activation.
    // The exact activation lease and canonical runtime tag remain mandatory.
    let snap = repository::activation_snapshot()?;
    let logical = if identity.is_null() {
        model::framed_digest("activate-runtime-logical", &[candidate, lease, operation])
    } else {
        model::framed_digest(
            "activate-runtime-logical-v3",
            &[
                candidate,
                lease,
                operation,
                identity["repositoryId"].as_str().unwrap(),
                identity["fleetDigest"].as_str().unwrap(),
            ],
        )
    };
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
    runtime_authority::validate(candidate)?;
    let current = runtime()?;
    let prior_runtimes = prior["allowedRuntimeCommits"]
        .as_array()
        .ok_or("activation runtimes malformed")?;
    let baseline = rollover_baseline(prior_runtimes, &current, candidate)?;
    let epoch = prior["epoch"]
        .as_u64()
        .ok_or("activation epoch malformed")?
        .checked_add(1)
        .ok_or("activation epoch overflow")?;
    let activation_value = if identity.is_null() {
        json!({"allowedRuntimeCommits":[baseline,candidate],"epoch":epoch,"formatVersion":2,"logicalId":logical,"operationId":operation,"state":"enabled","trustedFloor":prior["trustedFloor"]})
    } else {
        let mut runtimes = vec![baseline];
        if runtimes[0] != candidate {
            runtimes.push(candidate.into());
        }
        json!({"allowedRuntimeCommits":runtimes,"epoch":epoch,"fleetDigest":identity["fleetDigest"],"fleetRepositoryIds":identity["fleetRepositoryIds"],"formatVersion":3,"logicalId":logical,"operationId":operation,"repositoryId":identity["repositoryId"],"state":"enabled","trustedFloor":prior["trustedFloor"]})
    };
    let activation = git::commit(&activation_value, &[lease.into(), candidate.into()])?;
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
    repository::mutate(updates)?;
    print_json(&result)
}

fn rollover_baseline(prior_runtimes: &[Value], current: &str, candidate: &str) -> Result<String> {
    if prior_runtimes
        .iter()
        .any(|value| value.as_str() == Some(current))
    {
        return Ok(current.into());
    }
    if current == candidate {
        return prior_runtimes
            .last()
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "activation runtimes malformed".into());
    }
    Err("executing runtime is neither authorized nor the immutable candidate".into())
}

#[cfg(test)]
mod tests {
    use super::rollover_baseline;
    use serde_json::json;

    #[test]
    fn runtime_rollover_accepts_authorized_or_exact_candidate_only() {
        let prior = json!([
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ]);
        let prior = prior.as_array().unwrap();
        assert_eq!(
            rollover_baseline(
                prior,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "cccccccccccccccccccccccccccccccccccccccc"
            )
            .unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            rollover_baseline(
                prior,
                "cccccccccccccccccccccccccccccccccccccccc",
                "cccccccccccccccccccccccccccccccccccccccc"
            )
            .unwrap(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert!(
            rollover_baseline(
                prior,
                "dddddddddddddddddddddddddddddddddddddddd",
                "cccccccccccccccccccccccccccccccccccccccc"
            )
            .is_err()
        );
    }
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
    repository::mutate(updates)?;
    print_json(&result)
}
