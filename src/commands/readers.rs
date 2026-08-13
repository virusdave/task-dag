use super::print_json;
use crate::{Result, model, repository};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const FRONTIER_V2_SCOPE: &str = "refs/heads/tasks/frontier/v2-*";
const CURRENT_MAX_TASKS: usize = 500;
const CURRENT_MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const CURRENT_MAX_RELATIONS: usize = 50_000;
const CURRENT_MAX_EXACT_DONE_REFS: usize = 4_096;
const CURRENT_MAX_EXACT_DONE_REF_BYTES: usize = 512 * 1024;

struct CacheOnlyGuard;

impl Drop for CacheOnlyGuard {
    fn drop(&mut self) {
        crate::git::set_cache_only(false);
    }
}

fn current_rows(snapshot: &repository::Snapshot) -> Result<Vec<(String, String, String, String)>> {
    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();
    for (reference, oid) in &snapshot.refs {
        for state in ["frontier", "active", "blocked", "waiting"] {
            if let Some(id) = model::parse_state_ref(reference, state) {
                model::valid_id(id)?;
                if !seen.insert(id.to_owned()) {
                    return Err(format!("Task-ID {id} appears in multiple lifecycle states"));
                }
                rows.push((reference.clone(), state.into(), id.into(), oid.clone()));
            }
        }
    }
    Ok(rows)
}

fn current_fingerprint(refs: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    hash.update(b"task-dag-open-state-v3\0");
    for (reference, oid) in refs {
        hash.update((reference.len() as u64).to_be_bytes());
        hash.update(reference.as_bytes());
        hash.update((oid.len() as u64).to_be_bytes());
        hash.update(oid.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn charge_current_relations(current: usize, count: usize) -> Result<usize> {
    let total = current
        .checked_add(count)
        .ok_or("current-state relation count overflow")?;
    if total > CURRENT_MAX_RELATIONS {
        return Err("current-state structural relations exceed hard limit".into());
    }
    Ok(total)
}

pub(crate) fn current_state(max_tasks: usize) -> Result<()> {
    if !(1..=CURRENT_MAX_TASKS).contains(&max_tasks) {
        return Err("--max-tasks must be between 1 and 500".into());
    }
    repository::start_local_inspection();
    let first = repository::advertise_current_state()?;
    let captured = current_rows(&first)?;
    if captured.len() > max_tasks {
        return Err(format!(
            "current-state has {} open tasks, exceeding --max-tasks {max_tasks}",
            captured.len()
        ));
    }
    let activation = first
        .refs
        .get(model::ACTIVATION)
        .ok_or("v2 activation is absent")?
        .clone();
    let lifecycle_objects: Vec<_> = captured.iter().map(|row| row.3.clone()).collect();
    repository::materialize_local(&lifecycle_objects)?;
    repository::materialize_local_activation(&activation)?;
    crate::git::set_cache_only(true);
    let _guard = CacheOnlyGuard;
    crate::validators::activation(&activation)?;
    let mut relation_count = 0usize;
    let mut charge_relations = |count: usize| -> Result<()> {
        relation_count = charge_current_relations(relation_count, count)?;
        Ok(())
    };
    for (_, state, _, state_oid) in &captured {
        if state == "waiting" {
            let raw = crate::git::object_json(state_oid)?;
            if let Some(children) = raw.get("children") {
                charge_relations(
                    children
                        .as_array()
                        .ok_or("waiting children malformed")?
                        .len(),
                )?;
            }
        }
    }
    let mut records = Vec::with_capacity(captured.len());
    let mut tasks = BTreeSet::new();
    for (reference, state, id, state_oid) in &captured {
        let record = crate::validators::current_lifecycle(state, state_oid, id)?;
        let task_oid = record_task(&record, &state)?;
        tasks.insert(task_oid.clone());
        records.push((reference, state, id, state_oid, record, task_oid));
    }
    repository::materialize_local(&tasks.into_iter().collect::<Vec<_>>())?;
    let identity: BTreeMap<_, _> = records
        .iter()
        .map(|(_, _, id, _, _, oid)| ((*id).clone(), oid.clone()))
        .collect();
    let mut required_done = BTreeMap::<String, String>::new();
    let mut remember_related = |edge: &Value, kind: &str| -> Result<()> {
        let id = edge["taskId"]
            .as_str()
            .ok_or_else(|| format!("{kind} Task-ID malformed"))?;
        let oid = edge["taskOid"]
            .as_str()
            .ok_or_else(|| format!("{kind} Task OID malformed"))?;
        if let Some(open_oid) = identity.get(id) {
            if open_oid != oid {
                return Err(format!("Immutable identity mismatch for {kind} {id}"));
            }
            return Ok(());
        }
        if required_done
            .insert(id.into(), oid.into())
            .is_some_and(|prior| prior != oid)
        {
            return Err(format!("Immutable identity mismatch for {kind} {id}"));
        }
        Ok(())
    };
    for (_, _, id, _, record, task_oid) in &records {
        let raw = crate::git::object_json(task_oid)?;
        if raw["taskId"].as_str() != Some(id) {
            return Err("Task object's own taskId is wrong".into());
        }
        let requirements = raw["requirements"]
            .as_array()
            .ok_or("Task requirements malformed")?;
        charge_relations(requirements.len() + usize::from(!raw["structuralParent"].is_null()))?;
        if !raw["structuralParent"].is_null() {
            let parent_id = raw["structuralParent"]["taskId"]
                .as_str()
                .ok_or("structural parent Task-ID malformed")?;
            let Some((_, parent_state, _, _, parent_record, parent_oid)) = records
                .iter()
                .find(|(_, _, candidate, _, _, _)| *candidate == parent_id)
            else {
                return Err(format!(
                    "Open task {id} has no open structural parent {parent_id}"
                ));
            };
            if *parent_state != "waiting" || raw["structuralParent"]["taskOid"] != *parent_oid {
                return Err(format!(
                    "Open task {id} has invalid structural parent {parent_id}"
                ));
            }
            let reciprocal = parent_record["children"]
                .as_array()
                .is_some_and(|children| {
                    children.iter().any(|child| {
                        child["taskId"].as_str() == Some(id)
                            && child["taskOid"].as_str() == Some(task_oid)
                    })
                });
            if !reciprocal {
                return Err(format!(
                    "Open structural parent {parent_id} does not name child {id}"
                ));
            }
        }
        for requirement in requirements {
            remember_related(requirement, "requirement")?;
        }
        if record.get("intentOid").is_none() {
            if let Some(children) = record.get("children") {
                let children = children.as_array().ok_or("waiting children malformed")?;
                charge_relations(children.len())?;
                for child in children {
                    remember_related(child, "waiting child")?;
                }
            }
        }
    }

    let mut done_ids: BTreeSet<String> = identity.keys().cloned().collect();
    done_ids.extend(required_done.keys().cloned());
    if done_ids.len() > CURRENT_MAX_EXACT_DONE_REFS {
        return Err("current-state exact done proof exceeds hard ref limit".into());
    }
    let done_refs: Vec<String> = done_ids
        .iter()
        .map(|id| model::state_ref("done", id))
        .collect();
    let done_ref_bytes = done_refs.iter().try_fold(0usize, |total, reference| {
        total
            .checked_add(reference.len())
            .ok_or("exact done ref byte overflow")
    })?;
    if done_ref_bytes > CURRENT_MAX_EXACT_DONE_REF_BYTES {
        return Err("current-state exact done proof exceeds hard byte limit".into());
    }
    let done_snapshot = if done_refs.is_empty() {
        repository::Snapshot {
            refs: BTreeMap::new(),
        }
    } else {
        repository::advertise_bounded(
            &done_refs,
            CURRENT_MAX_EXACT_DONE_REFS,
            CURRENT_MAX_EXACT_DONE_REF_BYTES,
        )?
    };
    for id in identity.keys() {
        if done_snapshot
            .refs
            .contains_key(&model::state_ref("done", id))
        {
            return Err(format!("Task-ID {id} appears in multiple lifecycle states"));
        }
    }
    let done_oids: Vec<String> = required_done
        .keys()
        .map(|id| {
            done_snapshot
                .refs
                .get(&model::state_ref("done", id))
                .cloned()
                .ok_or_else(|| format!("Related task {id} is neither open nor done"))
        })
        .collect::<Result<_>>()?;
    repository::materialize_local(&done_oids)?;
    let mut proven_done = Vec::with_capacity(required_done.len());
    for (id, expected_task_oid) in &required_done {
        let state_oid = done_snapshot
            .refs
            .get(&model::state_ref("done", id))
            .ok_or_else(|| format!("Related task {id} lost its done proof"))?
            .clone();
        let raw_record = crate::git::object_json(&state_oid)?;
        if raw_record.get("acceptedOid").is_some() || raw_record.get("closeOid").is_some() {
            // These two legacy-compatible shapes deliberately retain full
            // validation of a fixed evidence set independent of retained
            // lifecycle and Task requirement history.
            repository::materialize_local_legacy_done_evidence(
                &state_oid,
                raw_record.get("acceptedOid").is_some(),
            )?;
        }
        let record = crate::validators::current_lifecycle("done", &state_oid, id)?;
        let task_oid = record_task(&record, "done")?;
        if &task_oid != expected_task_oid {
            return Err(format!("Immutable identity mismatch for done task {id}"));
        }
        repository::materialize_local(std::slice::from_ref(&task_oid))?;
        let task = crate::validators::task(&task_oid, id)?;
        crate::validators::current_convergence_evidence(&state_oid, id, &record, &task)?;
        proven_done.push(json!({"stateOid":state_oid,"taskId":id,"taskOid":task_oid}));
    }

    let resolve = |edge: &Value, kind: &str| -> Result<()> {
        let id = edge["taskId"]
            .as_str()
            .ok_or_else(|| format!("{kind} Task-ID malformed"))?;
        let oid = edge["taskOid"]
            .as_str()
            .ok_or_else(|| format!("{kind} Task OID malformed"))?;
        if identity
            .get(id)
            .or_else(|| required_done.get(id))
            .map(String::as_str)
            != Some(oid)
        {
            return Err(format!(
                "{kind} {id} is absent from current-state closure or names a different Task OID"
            ));
        }
        Ok(())
    };
    let mut rows = Vec::with_capacity(records.len());
    for (reference, state, id, state_oid, record, task_oid) in records {
        let task = crate::validators::task(&task_oid, id)?;
        if !task["structuralParent"].is_null() {
            resolve(&task["structuralParent"], "structural parent")?;
        }
        for requirement in task["requirements"]
            .as_array()
            .ok_or("Task requirements malformed")?
        {
            resolve(requirement, "requirement")?;
        }
        let direct_children = if state == "waiting" && record.get("intentOid").is_none() {
            let children = record["children"]
                .as_array()
                .ok_or("waiting children malformed")?;
            for child in children {
                resolve(child, "waiting child")?;
            }
            Value::Array(
                children
                    .iter()
                    .map(|child| json!({"taskId":child["taskId"],"taskOid":child["taskOid"]}))
                    .collect(),
            )
        } else {
            json!([])
        };
        let context = json!({
            "directChildren": direct_children,
            "directRequirements": task["requirements"],
            "state": state,
            "stateOid": state_oid,
            "structuralParent": task["structuralParent"],
            "task": task,
            "taskId": id,
            "taskOid": task_oid,
        });
        rows.push(json!({"context":context,"record":record,"ref":reference,"state":state,"stateOid":state_oid,"taskId":id,"taskOid":task_oid}));
    }
    let second = repository::advertise_current_state()?;
    if first.refs != second.refs {
        return Err(
            "retryable current-state drift: authoritative refs changed between advertisements"
                .into(),
        );
    }
    if !done_refs.is_empty()
        && repository::advertise_bounded(
            &done_refs,
            CURRENT_MAX_EXACT_DONE_REFS,
            CURRENT_MAX_EXACT_DONE_REF_BYTES,
        )?
        .refs
            != done_snapshot.refs
    {
        return Err(
            "retryable current-state drift: exact done refs changed between advertisements".into(),
        );
    }
    let mut fingerprint_refs = first.refs.clone();
    fingerprint_refs.extend(done_snapshot.refs);
    let output = json!({"activationOid":activation,"fingerprint":current_fingerprint(&fingerprint_refs),"formatVersion":3,"provenDone":proven_done,"rows":rows,"scope":"open"});
    let encoded = serde_json::to_vec(&output).map_err(|e| e.to_string())?;
    if encoded.len() > CURRENT_MAX_OUTPUT_BYTES {
        return Err("current-state JSON output exceeds hard limit".into());
    }
    println!("{}", String::from_utf8(encoded).map_err(|e| e.to_string())?);
    Ok(())
}

#[cfg(test)]
mod current_state_tests {
    use super::{CURRENT_MAX_RELATIONS, charge_current_relations};

    #[test]
    fn relationship_budget_rejects_before_exceeding_the_hard_limit() {
        assert_eq!(
            charge_current_relations(CURRENT_MAX_RELATIONS - 1, 1).unwrap(),
            CURRENT_MAX_RELATIONS
        );
        assert!(charge_current_relations(CURRENT_MAX_RELATIONS, 1).is_err());
        assert!(charge_current_relations(usize::MAX, 1).is_err());
    }
}

fn frontier_id(reference: &str) -> Result<&str> {
    let id = model::parse_state_ref(reference, "frontier")
        .ok_or_else(|| format!("frontier advertisement returned unexpected ref {reference}"))?;
    model::valid_id(id)
        .map_err(|_| format!("frontier advertisement returned malformed v2 ref {reference}"))?;
    Ok(id)
}

fn frontier_map(snapshot: &repository::Snapshot) -> Result<BTreeMap<String, String>> {
    snapshot
        .refs
        .iter()
        .filter(|(reference, _)| reference.starts_with("refs/heads/tasks/frontier/"))
        .map(|(reference, oid)| {
            frontier_id(reference)?;
            Ok((reference.clone(), oid.clone()))
        })
        .collect()
}

fn materialize_frontier_tasks(frontier: &BTreeMap<String, String>) -> Result<()> {
    let tasks = frontier
        .values()
        .map(|oid| {
            let task = crate::git::object_json(oid)?["taskOid"]
                .as_str()
                .ok_or("frontier record has no Task OID")?
                .to_owned();
            model::oid(&task)?;
            Ok(task)
        })
        .collect::<Result<Vec<_>>>()?;
    repository::materialize(&tasks)
}

pub(crate) fn show(id: &str) -> Result<()> {
    model::valid_id(id)?;
    let snap = repository::advertise(&repository::lifecycle_patterns(id))?;
    let found = model::lifecycle(&snap, id);
    if found.len() != 1 {
        return Err(format!(
            "expected exactly one v2 lifecycle ref, found {}",
            found.len()
        ));
    }
    let (state, r, oid) = &found[0];
    repository::materialize(std::slice::from_ref(oid))?;
    let record = lifecycle_record(state, oid, id)?;
    print_json(&json!({"record":record,"ref":r,"state":state,"stateOid":oid,"taskId":id}))
}

pub(crate) fn activation() -> Result<()> {
    let snap = repository::checked_snapshot(Vec::new())?;
    let activation_oid = snap
        .refs
        .get(model::ACTIVATION)
        .ok_or("v2 activation is absent")?;
    let record = crate::validators::activation(activation_oid)?;
    print_json(&json!({
        "activationOid": activation_oid,
        "record": record,
    }))
}

pub(crate) fn frontier() -> Result<()> {
    let first = repository::advertise(&[FRONTIER_V2_SCOPE.into()])?;
    let first_frontier = frontier_map(&first)?;
    let frontier_oids: Vec<_> = first_frontier.values().cloned().collect();
    repository::materialize(&frontier_oids)?;
    materialize_frontier_tasks(&first_frontier)?;
    let mut patterns = vec![FRONTIER_V2_SCOPE.into()];
    for (reference, oid) in &first_frontier {
        let id = frontier_id(reference)?;
        let lifecycle = crate::validators::lifecycle("frontier", oid, id)?;
        let task = lifecycle["taskOid"]
            .as_str()
            .ok_or("frontier record has no Task OID")?;
        for req in crate::validators::task(task, id)?["requirements"]
            .as_array()
            .ok_or("Task requirements malformed")?
        {
            if let Some(id) = req["taskId"].as_str() {
                patterns.extend(repository::lifecycle_patterns(id));
            }
        }
    }
    let snap = repository::advertise(&patterns)?;
    let second_frontier = frontier_map(&snap)?;
    if second_frontier != first_frontier {
        return Err("frontier changed between authoritative advertisements; retry".into());
    }
    let frontier_oids: Vec<_> = second_frontier.values().cloned().collect();
    repository::materialize(&frontier_oids)?;
    materialize_frontier_tasks(&second_frontier)?;
    let mut rows = Vec::new();
    for (reference, oid) in &second_frontier {
        let id = frontier_id(reference)?;
        let lifecycle = crate::validators::lifecycle("frontier", oid, id)?;
        let task = lifecycle["taskOid"]
            .as_str()
            .ok_or("frontier record has no Task OID")?
            .to_owned();
        let value = crate::validators::task(&task, id)?;
        let reqs = value["requirements"]
            .as_array()
            .ok_or("Task requirements malformed")?;
        if model::readiness(&snap, reqs).is_ok() {
            rows.push(
                json!({"ref":reference,"stateOid":oid,"taskId":id,"taskOid":task,"title":value["title"]}),
            );
        }
    }
    print_json(&json!({"tasks":rows}))
}

pub(crate) fn blocked() -> Result<()> {
    let snap = repository::advertise(&["refs/heads/tasks/blocked/*".into()])?;
    let v2: Vec<_> = snap
        .refs
        .iter()
        .filter_map(|(reference, oid)| {
            model::parse_state_ref(reference, "blocked")
                .filter(|id| model::valid_id(id).is_ok())
                .map(|_| oid.clone())
        })
        .collect();
    repository::materialize(&v2)?;
    let mut tasks = Vec::new();
    for (reference, oid) in &snap.refs {
        let Some(id) = model::parse_state_ref(reference, "blocked") else {
            continue;
        };
        if model::valid_id(id).is_err() {
            continue;
        }
        let value = crate::validators::lifecycle("blocked", oid, id)?;
        tasks.push(json!({"authorization":value["authorization"],"blockLease":oid,"blockedAt":value["blockedAt"],"reason":value["reason"],"taskId":id,"taskOid":value["taskOid"]}));
    }
    print_json(&json!({"tasks":tasks}))
}

pub(crate) fn deps(id: &str) -> Result<()> {
    model::valid_id(id)?;
    let first = repository::advertise(&repository::lifecycle_patterns(id))?;
    let found = model::lifecycle(&first, id);
    if found.len() != 1 {
        return Err("task must have exactly one lifecycle ref".into());
    }
    repository::materialize(std::slice::from_ref(&found[0].2))?;
    let record = lifecycle_record(&found[0].0, &found[0].2, id)?;
    let task_oid = record_task(&record, &found[0].0)?;
    let task = crate::validators::task(&task_oid, id)?;
    let reqs = task["requirements"]
        .as_array()
        .ok_or("Task requirements malformed")?;
    let mut patterns = repository::lifecycle_patterns(id);
    for req in reqs {
        patterns.extend(repository::lifecycle_patterns(
            req["taskId"]
                .as_str()
                .ok_or("requirement taskId malformed")?,
        ));
    }
    let snap = repository::advertise(&patterns)?;
    let mut rows = Vec::new();
    for req in reqs {
        let dep = req["taskId"].as_str().unwrap();
        let states = model::lifecycle(&snap, dep);
        let ready = states.len() == 1
            && states[0].0 == "done"
            && model::readiness(&snap, std::slice::from_ref(req)).is_ok();
        rows.push(json!({"ready":ready,"state":states.first().map(|v|v.0.as_str()),"taskId":dep,"taskOid":req["taskOid"]}));
    }
    print_json(
        &json!({"ready":rows.iter().all(|v|v["ready"]==true),"requirements":rows,"taskId":id,"taskOid":task_oid}),
    )
}

pub(crate) fn context(id: &str) -> Result<()> {
    print_json(&neighborhood(id)?)
}

pub(crate) fn dag(id: &str) -> Result<()> {
    print_json(&neighborhood(id)?)
}

fn neighborhood(id: &str) -> Result<serde_json::Value> {
    model::valid_id(id)?;
    let first = repository::advertise(&repository::lifecycle_patterns(id))?;
    let found = model::lifecycle(&first, id);
    if found.len() != 1 {
        return Err("task must have exactly one lifecycle ref".into());
    }
    repository::materialize(std::slice::from_ref(&found[0].2))?;
    let record = lifecycle_record(&found[0].0, &found[0].2, id)?;
    let task_oid = record_task(&record, &found[0].0)?;
    let task = crate::validators::task(&task_oid, id)?;
    let direct_children = if found[0].0 == "waiting" && record.get("intentOid").is_none() {
        record["children"]
            .as_array()
            .ok_or("waiting children malformed")?
            .iter()
            .map(|child| json!({"taskId":child["taskId"],"taskOid":child["taskOid"]}))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    Ok(
        json!({"directChildren":direct_children,"directRequirements":task["requirements"],"state":found[0].0,"stateOid":found[0].2,"structuralParent":task["structuralParent"],"task":task,"taskId":id,"taskOid":task_oid}),
    )
}

fn lifecycle_record(state: &str, oid: &str, id: &str) -> Result<Value> {
    let record = crate::validators::current_lifecycle(state, oid, id)?;
    let task_oid = record_task(&record, state)?;
    let task = crate::validators::task(&task_oid, id)?;
    if state == "done" {
        crate::validators::current_convergence_evidence(oid, id, &record, &task)?;
    }
    Ok(record)
}

fn record_task(record: &Value, state: &str) -> Result<String> {
    record[if state == "waiting" {
        "parentTaskOid"
    } else {
        "taskOid"
    }]
    .as_str()
    .map(str::to_owned)
    .ok_or_else(|| format!("{state} record has no Task OID"))
}
