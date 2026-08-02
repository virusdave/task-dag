use crate::{
    Result,
    cli::CompleteOps,
    git,
    model::{self, Update},
    repository,
};
use serde_json::json;

fn completion_snapshot(id: &str, include_master: bool) -> Result<repository::Snapshot> {
    let mut extras = Vec::new();
    if include_master {
        extras.push("refs/heads/master".into());
    }
    let first = repository::task_snapshot(id, extras.clone())?;
    repository::materialize_lifecycle(&first, &[id.into()])?;
    let lifecycle = model::lifecycle(&first, id);
    if lifecycle.len() != 1 {
        return Err("completion target must have exactly one advertised lifecycle".into());
    }
    let task_oid = git::lifecycle_task(&lifecycle[0].2)?;
    let task = crate::validators::task(&task_oid, id)?;
    let mut ancestor = task["structuralParent"]["taskId"]
        .as_str()
        .map(str::to_owned);
    for _ in 0..2 {
        let Some(parent) = ancestor else { break };
        let mut refs = repository::lifecycle_patterns(&parent);
        refs.push(format!("refs/heads/tasks/reconcile/{parent}"));
        let view = repository::advertise(&refs)?;
        repository::exclusive(&view, &parent, "waiting")?;
        let manifest_oid = &view.refs[&model::state_ref("waiting", &parent)];
        let manifest = crate::validators::waiting(manifest_oid, &parent)?;
        extras.extend(refs);
        let parent_task = manifest["parentTaskOid"]
            .as_str()
            .ok_or("waiting manifest parentTaskOid malformed")?;
        ancestor = crate::validators::task(parent_task, &parent)?["structuralParent"]["taskId"]
            .as_str()
            .map(str::to_owned);
    }
    let authoritative = repository::task_snapshot(id, extras)?;
    if let Some(parent) = task["structuralParent"]["taskId"].as_str() {
        repository::exclusive(&authoritative, parent, "waiting")?;
        crate::validators::waiting(
            &authoritative.refs[&model::state_ref("waiting", parent)],
            parent,
        )?;
    }
    Ok(authoritative)
}

pub(crate) fn reconciliation_update(
    snap: &repository::Snapshot,
    task: &str,
    id: &str,
) -> Result<Option<Update>> {
    let parent = git::object_json(task)?["structuralParent"].clone();
    let Some(parent_id) = parent.get("taskId").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let waiting = model::state_ref("waiting", parent_id);
    let manifest = snap
        .refs
        .get(&waiting)
        .ok_or("structural parent has no advertised waiting manifest")?
        .clone();
    repository::materialize(std::slice::from_ref(&manifest))?;
    let children = git::object_json(&manifest)?["children"]
        .as_array()
        .ok_or("waiting manifest children malformed")?
        .clone();
    if !children
        .iter()
        .any(|c| c["taskId"] == id && c["taskOid"] == task)
    {
        return Err("waiting manifest does not directly name completed child".into());
    }
    let marker = format!("refs/heads/tasks/reconcile/{parent_id}");
    match snap.refs.get(&marker) {
        Some(existing) if existing == &manifest => Ok(None),
        Some(_) => Err("parent reconciliation marker conflicts with manifest".into()),
        None => Ok(Some(Update {
            semantic_ref: marker,
            old: None,
            new: Some(manifest),
        })),
    }
}

pub(crate) fn complete(id: &str, publication: &str, claim_token: &str) -> Result<()> {
    model::valid_id(id)?;
    model::oid(publication)?;
    let snap = completion_snapshot(id, true)?;
    let logical = model::framed_digest(
        "complete-logical",
        &["complete", id, publication, claim_token],
    );
    let done = model::state_ref("done", id);
    if snap.refs.contains_key(&done) {
        let value = repository::exclusive_done(&snap, id)?;
        return if value["logicalId"] == logical {
            Ok(())
        } else {
            Err("task is done with a semantically different result".into())
        };
    }
    repository::exclusive(&snap, id, "active")?;
    let master = snap
        .refs
        .get("refs/heads/master")
        .ok_or("origin does not advertise refs/heads/master")?
        .clone();
    let active_ref = model::state_ref("active", id);
    let active = snap.refs[&active_ref].clone();
    repository::materialize(&[active.clone(), master.clone()])?;
    git::output(["cat-file", "-e", &format!("{publication}^{{commit}}")])
        .map_err(|_| "publication commit must exist locally")?;
    let claim = model::validate_claim(
        git::object_json(&active)?,
        claim_token,
        id,
        super::timestamp()?,
    )?;
    let parent = git::first_parent(publication)?;
    if parent != master {
        return Err(format!(
            "publication first parent {parent} is not advertised master {master}"
        ));
    }
    let task = claim.task_oid;
    let evidence = git::commit(
        &json!({"attemptId":logical,"formatVersion":2,"logicalId":logical,"oldMaster":master,"publicationCommit":publication,"taskId":id,"taskOid":task}),
        &[active.clone(), task.clone(), publication.into()],
    )?;
    let mut updates = vec![
        Update {
            semantic_ref: active_ref,
            old: Some(active),
            new: None,
        },
        Update {
            semantic_ref: done.clone(),
            old: None,
            new: Some(evidence.clone()),
        },
        Update {
            semantic_ref: "refs/heads/master".into(),
            old: Some(master),
            new: Some(publication.into()),
        },
    ];
    if let Some(update) = reconciliation_update(&snap, &task, id)? {
        updates.push(update);
    }
    let updates = model::canonical_updates(updates);
    repository::mutate(updates)
}
pub(crate) fn complete_ops(args: CompleteOps) -> Result<()> {
    model::valid_id(&args.task_id)?;
    model::nonempty("description", &args.description)?;
    model::nonempty("authorization", &args.authorization)?;
    let snap = completion_snapshot(&args.task_id, false)?;
    let evidence_values = serde_json::to_string(&args.evidence).map_err(|e| e.to_string())?;
    let logical = model::framed_digest(
        "complete-ops-logical",
        &[
            "complete-ops",
            &args.task_id,
            &args.description,
            &args.authorization,
            &evidence_values,
            &args.claim_token,
        ],
    );
    let done = model::state_ref("done", &args.task_id);
    if snap.refs.contains_key(&done) {
        let value = repository::exclusive_done(&snap, &args.task_id)?;
        return if value["logicalId"] == logical {
            Ok(())
        } else {
            Err("task is done with a semantically different result".into())
        };
    }
    repository::exclusive(&snap, &args.task_id, "active")?;
    let active_ref = model::state_ref("active", &args.task_id);
    let active = snap.refs[&active_ref].clone();
    repository::materialize(std::slice::from_ref(&active))?;
    let claim = model::validate_claim(
        git::object_json(&active)?,
        &args.claim_token,
        &args.task_id,
        super::timestamp()?,
    )?;
    let task = claim.task_oid;
    let evidence: Vec<_> = args
        .evidence
        .iter()
        .map(|v| json!({"digest":model::digest(v),"value":v}))
        .collect();
    let done_oid = git::commit(
        &json!({"attemptId":logical,"authorization":args.authorization,"description":args.description,"evidence":evidence,"formatVersion":2,"logicalId":logical,"taskId":args.task_id,"taskOid":task}),
        &[active.clone(), task.clone()],
    )?;
    let mut updates = vec![
        Update {
            semantic_ref: active_ref,
            old: Some(active),
            new: None,
        },
        Update {
            semantic_ref: done.clone(),
            old: None,
            new: Some(done_oid.clone()),
        },
    ];
    if let Some(update) = reconciliation_update(&snap, &task, &args.task_id)? {
        updates.push(update);
    }
    let updates = model::canonical_updates(updates);
    repository::mutate(updates)
}

pub(crate) fn converge(id: &str, operation: &str) -> Result<()> {
    model::valid_id(id)?;
    let first = repository::task_snapshot(id, vec![format!("refs/heads/tasks/reconcile/{id}")])?;
    let waiting = model::state_ref("waiting", id);
    if let Some(manifest) = first.refs.get(&waiting) {
        repository::materialize(std::slice::from_ref(manifest))?;
    }
    let children = first
        .refs
        .get(&waiting)
        .map(|m| git::object_json(m))
        .transpose()?
        .and_then(|v| v["children"].as_array().cloned())
        .unwrap_or_default();
    let mut patterns = repository::lifecycle_patterns(id);
    patterns.push(format!("refs/heads/tasks/reconcile/{id}"));
    if let Some(manifest_oid) = first.refs.get(&waiting) {
        let manifest = crate::validators::waiting(manifest_oid, id)?;
        let task_oid = manifest["parentTaskOid"]
            .as_str()
            .ok_or("manifest parent Task OID malformed")?;
        let task = crate::validators::task(task_oid, id)?;
        if let Some(parent) = task["structuralParent"]["taskId"].as_str() {
            patterns.extend(repository::lifecycle_patterns(parent));
            patterns.push(format!("refs/heads/tasks/reconcile/{parent}"));
        }
        for requirement in task["requirements"]
            .as_array()
            .ok_or("Task requirements malformed")?
        {
            let requirement_id = requirement["taskId"]
                .as_str()
                .ok_or("Task requirement Task-ID malformed")?;
            patterns.extend(repository::lifecycle_patterns(requirement_id));
        }
    }
    for child in &children {
        if let Some(cid) = child["taskId"].as_str() {
            patterns.extend(repository::lifecycle_patterns(cid));
        }
    }
    let snap = repository::checked_snapshot(patterns)?;
    let done_ref = model::state_ref("done", id);
    if snap.refs.contains_key(&done_ref) {
        let value = repository::exclusive_done(&snap, id)?;
        return if value["operationId"] == operation {
            Ok(())
        } else {
            Err("task converged by a different operation".into())
        };
    }
    repository::exclusive(&snap, id, "waiting")?;
    let waiting = model::state_ref("waiting", id);
    let manifest = snap.refs[&waiting].clone();
    let marker = format!("refs/heads/tasks/reconcile/{id}");
    if snap.refs.get(&marker) != Some(&manifest) {
        return Err("exact reconciliation marker is absent".into());
    }
    repository::materialize(std::slice::from_ref(&manifest))?;
    let value = git::object_json(&manifest)?;
    let task = value["parentTaskOid"]
        .as_str()
        .ok_or("manifest parent Task OID malformed")?
        .to_owned();
    let task_value = crate::validators::task(&task, id)?;
    if let Some(parent) = task_value["structuralParent"]["taskId"].as_str() {
        repository::exclusive(&snap, parent, "waiting")?;
    }
    let children = value["children"]
        .as_array()
        .ok_or("manifest children malformed")?;
    let mut child_done = Vec::new();
    for child in children {
        let child_id = child["taskId"].as_str().ok_or("child Task-ID malformed")?;
        let child_task = child["taskOid"]
            .as_str()
            .ok_or("child Task OID malformed")?;
        let done_ref = model::state_ref("done", child_id);
        let done = snap
            .refs
            .get(&done_ref)
            .ok_or_else(|| format!("child {child_id} is not done"))?
            .clone();
        let done_value = repository::exclusive_done(&snap, child_id)?;
        if done_value["taskOid"] != child_task {
            return Err("child done evidence names wrong Task object".into());
        }
        child_done.push((done_ref, done));
    }
    child_done.sort();
    let mut requirement_done = Vec::new();
    for requirement in task_value["requirements"]
        .as_array()
        .ok_or("Task requirements malformed")?
    {
        let requirement_id = requirement["taskId"]
            .as_str()
            .ok_or("Task requirement Task-ID malformed")?;
        let requirement_task = requirement["taskOid"]
            .as_str()
            .ok_or("Task requirement OID malformed")?;
        let done_ref = model::state_ref("done", requirement_id);
        let done = snap
            .refs
            .get(&done_ref)
            .ok_or_else(|| format!("requirement {requirement_id} is not done"))?
            .clone();
        let done_value = repository::exclusive_done(&snap, requirement_id)?;
        if done_value["taskOid"] != requirement_task {
            return Err("requirement done evidence names wrong Task object".into());
        }
        requirement_done.push((done_ref, done));
    }
    requirement_done.sort();
    let children_json = serde_json::to_string(&child_done).map_err(|e| e.to_string())?;
    let logical = if requirement_done.is_empty() {
        model::framed_digest(
            "converge-logical",
            &[id, operation, &manifest, &children_json],
        )
    } else {
        model::framed_digest(
            "converge-requirements-logical",
            &[
                id,
                operation,
                &manifest,
                &children_json,
                &serde_json::to_string(&requirement_done).map_err(|e| e.to_string())?,
            ],
        )
    };
    let mut parents = vec![manifest.clone(), task.clone()];
    parents.extend(child_done.iter().map(|(_, o)| o.clone()));
    parents.extend(requirement_done.iter().map(|(_, o)| o.clone()));
    let mut evidence_value = json!({"children":child_done,"formatVersion":2,"logicalId":logical,"operationId":operation,"manifestOid":manifest,"taskId":id,"taskOid":task});
    if !requirement_done.is_empty() {
        evidence_value["requirements"] = json!(requirement_done);
    }
    let evidence = git::commit(&evidence_value, &parents)?;
    crate::validators::lifecycle("done", &evidence, id)?;
    let done = model::state_ref("done", id);
    let mut updates = vec![
        Update {
            semantic_ref: waiting,
            old: Some(manifest),
            new: None,
        },
        Update {
            semantic_ref: marker,
            old: Some(snap.refs[&format!("refs/heads/tasks/reconcile/{id}")].clone()),
            new: None,
        },
        Update {
            semantic_ref: done.clone(),
            old: None,
            new: Some(evidence.clone()),
        },
    ];
    if let Some(update) = reconciliation_update(&snap, &task, id)? {
        updates.push(update);
    }
    let updates = model::canonical_updates(updates);
    repository::mutate(updates)
}
