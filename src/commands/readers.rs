use super::print_json;
use crate::{Result, model, repository};
use serde_json::json;

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
pub(crate) fn frontier() -> Result<()> {
    let first = repository::advertise(&["refs/heads/tasks/frontier/*".into()])?;
    let frontier_oids: Vec<_> = first.refs.values().cloned().collect();
    repository::materialize(&frontier_oids)?;
    let mut patterns = vec!["refs/heads/tasks/frontier/*".into()];
    for (r, o) in &first.refs {
        if model::parse_state_ref(r, "frontier").is_some() {
            let id = model::parse_state_ref(r, "frontier").unwrap();
            let lifecycle = crate::validators::lifecycle("frontier", o, id)?;
            let task = lifecycle["taskOid"].as_str().unwrap();
            for req in crate::validators::task(task, id)?["requirements"]
                .as_array()
                .ok_or("Task requirements malformed")?
            {
                if let Some(id) = req["taskId"].as_str() {
                    patterns.extend(repository::lifecycle_patterns(id));
                }
            }
        }
    }
    let snap = repository::advertise(&patterns)?;
    let frontier_oids: Vec<_> = snap
        .refs
        .iter()
        .filter_map(|(r, o)| model::parse_state_ref(r, "frontier").map(|_| o.clone()))
        .collect();
    repository::materialize(&frontier_oids)?;
    let mut rows = Vec::new();
    for (r, o) in &snap.refs {
        if let Some(id) = model::parse_state_ref(r, "frontier")
            && model::valid_id(id).is_ok()
        {
            let lifecycle = crate::validators::lifecycle("frontier", o, id)?;
            let task = lifecycle["taskOid"].as_str().unwrap().to_owned();
            let value = crate::validators::task(&task, id)?;
            let reqs = value["requirements"]
                .as_array()
                .ok_or("Task requirements malformed")?;
            if model::readiness(&snap, reqs).is_ok() {
                rows.push(
                    json!({"ref":r,"stateOid":o,"taskId":id,"taskOid":task,"title":value["title"]}),
                );
            }
        }
    }
    print_json(&json!({"tasks":rows}))
}
