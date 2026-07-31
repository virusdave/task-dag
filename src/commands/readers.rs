use super::print_json;
use crate::{Result, model, repository};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const FRONTIER_V2_SCOPE: &str = "refs/heads/tasks/frontier/v2-*";

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
    let record = if state == "waiting" {
        crate::validators::waiting(oid, id)?
    } else {
        crate::validators::lifecycle(state, oid, id)?
    };
    print_json(&json!({"record":record,"ref":r,"state":state,"stateOid":oid,"taskId":id}))
}

pub(crate) fn activation() -> Result<()> {
    let snap = repository::checked_snapshot(Vec::new())?;
    let activation_oid = snap
        .refs
        .get(model::ACTIVATION)
        .ok_or("v2 activation is absent")?;
    let journal_oid = snap
        .refs
        .get(model::JOURNAL)
        .ok_or("transition journal is absent")?;
    let record = crate::validators::activation(activation_oid)?;
    print_json(&json!({
        "activationOid": activation_oid,
        "journalOid": journal_oid,
        "record": record,
    }))
}

pub(crate) fn frontier() -> Result<()> {
    let first = repository::advertise(&[FRONTIER_V2_SCOPE.into()])?;
    let first_frontier = frontier_map(&first)?;
    let frontier_oids: Vec<_> = first_frontier.values().cloned().collect();
    repository::materialize(&frontier_oids)?;
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
    let direct_children = if found[0].0 == "waiting" {
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
    Ok(if state == "waiting" {
        crate::validators::waiting(oid, id)?
    } else {
        crate::validators::lifecycle(state, oid, id)?
    })
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
