mod scan;

use crate::{
    Result, git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DOMAIN: &str = "migrate-v1";

pub(crate) fn census() -> Result<()> {
    crate::commands::print_json(&scan::census()?)
}

pub(crate) fn run(
    root: &str,
    operation: &str,
    terminal_edges: &[String],
    resolution_authorization: Option<&str>,
    resolution_evidence: &[String],
) -> Result<()> {
    model::oid(root)?;
    model::bounded("operation-id", operation, 256)?;
    let mut terminal_edges = terminal_edges.to_vec();
    terminal_edges.sort();
    if terminal_edges.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("terminal external edge OIDs must be unique".into());
    }
    for oid in &terminal_edges {
        model::oid(oid)?;
    }
    let authorization = resolution_authorization.unwrap_or("");
    if terminal_edges.is_empty() {
        if !authorization.is_empty() || !resolution_evidence.is_empty() {
            return Err("terminal resolution metadata requires an external edge".into());
        }
    } else {
        model::bounded(
            "terminal edge resolution authorization",
            authorization,
            4096,
        )?;
        if resolution_evidence.is_empty() {
            return Err("terminal edge resolution requires evidence".into());
        }
        for evidence in resolution_evidence {
            model::bounded("terminal edge resolution evidence", evidence, 4096)?;
        }
    }
    let semantic = if terminal_edges.is_empty() {
        model::framed_digest("migrate-v1-semantics", &[root])
    } else {
        let semantic_inputs = [
            root.to_owned(),
            terminal_edges.join(","),
            authorization.to_owned(),
            resolution_evidence.join("\n"),
        ];
        let semantic_parts: Vec<_> = semantic_inputs.iter().map(String::as_str).collect();
        model::framed_digest("migrate-v1-semantics-terminal-edges", &semantic_parts)
    };
    let receipt_ref = format!(
        "refs/heads/tasks/v2/imports/v1/operations/{}",
        model::framed_digest("migrate-v1-operation", &[operation])
    );
    if let Some(value) = replay(&receipt_ref, operation, &semantic)? {
        return crate::commands::print_json(&value);
    }
    let frozen = scan::discover(root)?;
    scan::validate_terminal_edges(&frozen.terminal_edges, &terminal_edges)?;
    let snap = repository::checked_snapshot(frozen.patterns.clone())?;
    if snap.refs != frozen.refs {
        return Err("v1 discovery changed between frozen scan and activation capture".into());
    }
    let mut ids = BTreeMap::new();
    for legacy in &frozen.tasks {
        ids.insert(
            legacy.task.clone(),
            model::task_id("legacy-v1-sha", &[&legacy.task]),
        );
    }
    let root_id = ids[root].clone();
    let mut task_oids: BTreeMap<String, String> = BTreeMap::new();
    for legacy in &frozen.tasks {
        let requirements: Vec<Value> = legacy
            .requires
            .iter()
            .map(|sha| json!({"taskId":ids[sha],"taskOid":task_oids[sha]}))
            .collect();
        let structural = if legacy.task == root {
            Value::Null
        } else {
            json!({"taskId":root_id,"taskOid":task_oids[root]})
        };
        let value = json!({"description":legacy.description,"formatVersion":2,"operationId":operation,"requirements":requirements,"structuralParent":structural,"taskId":ids[&legacy.task],"title":legacy.title});
        let mut parents = Vec::new();
        if legacy.task != root {
            parents.push(task_oids[root].clone());
        }
        parents.extend(legacy.requires.iter().map(|r| task_oids[r].clone()));
        task_oids.insert(legacy.task.clone(), git::commit(&value, &parents)?);
    }
    let now = crate::commands::timestamp()?;
    let mut updates = Vec::new();
    let mut outputs = Vec::new();
    let mut children = Vec::new();
    let mut tokens = BTreeMap::new();
    let mut block_leases = BTreeMap::new();
    for legacy in frozen.tasks.iter().filter(|t| t.task != root) {
        let id = &ids[&legacy.task];
        let task = &task_oids[&legacy.task];
        let (state, record, waiting_state) = if legacy.state == "active" {
            let token = crate::commands::claim_token()?;
            if tokens.values().any(|prior| prior == &token) {
                return Err("generated duplicate migration claim token".into());
            }
            tokens.insert(id.clone(), token.clone());
            (
                "active",
                json!({"attemptId":model::framed_digest("migration-active", &[&legacy.task]),"claimToken":token,"claimedAt":now,"expiresAt":now+43_200,"formatVersion":2,"host":"migration","logicalId":semantic,"operationId":operation,"owner":format!("migration:{}",legacy.owner),"reclaimRequired":true,"sessionId":"migration","taskId":id,"taskOid":task}),
                None,
            )
        } else if legacy.state == "blocked" {
            let token = crate::commands::claim_token()?;
            if tokens.values().any(|prior| prior == &token) {
                return Err("generated duplicate migration claim token".into());
            }
            let active_record = json!({"attemptId":model::framed_digest("migration-blocked-active", &[&legacy.task]),"claimToken":token,"claimedAt":now.saturating_sub(1),"expiresAt":now,"formatVersion":2,"host":"migration","logicalId":semantic,"operationId":operation,"owner":"migration:v1-blocked","reclaimRequired":true,"sessionId":"migration","taskId":id,"taskOid":task});
            let active = git::commit(&active_record, std::slice::from_ref(task))?;
            crate::validators::lifecycle("active", &active, id)?;
            let blocked_record = json!({"authorization":"factual v1 blocked-overlay migration","blockedAt":legacy.blocked_at.unwrap_or(now),"claimTokenDigest":model::digest(&token),"formatVersion":2,"operationId":operation,"reason":legacy.blocked_reason.as_deref().unwrap_or("Migrated from legacy v1 blocked overlay"),"taskId":id,"taskOid":task});
            ("blocked", blocked_record, Some((active, token)))
        } else {
            (
                "frontier",
                json!({"formatVersion":2,"operationId":operation,"semanticId":semantic,"taskId":id,"taskOid":task}),
                None,
            )
        };
        let parents = waiting_state
            .as_ref()
            .map(|(active, _)| vec![active.clone(), task.clone()])
            .unwrap_or_else(|| vec![task.clone()]);
        let state_oid = git::commit(&record, &parents)?;
        crate::validators::lifecycle(state, &state_oid, id)?;
        let state_ref = model::state_ref(state, id);
        updates.push(Update {
            semantic_ref: state_ref.clone(),
            old: None,
            new: Some(state_oid.clone()),
        });
        outputs.push((state_ref.clone(), state_oid.clone()));
        if state == "blocked" {
            block_leases.insert(id.clone(), state_oid.clone());
        }
        let (child_ref, child_oid, child_token, child_owner) =
            if let Some((active, token)) = waiting_state {
                (
                    model::state_ref("active", id),
                    active,
                    json!(token),
                    json!("migration:v1-blocked"),
                )
            } else {
                (
                    state_ref.clone(),
                    state_oid.clone(),
                    tokens.get(id).map_or(Value::Null, |v| json!(v)),
                    if state == "active" {
                        json!(format!("migration:{}", legacy.owner))
                    } else {
                        Value::Null
                    },
                )
            };
        children.push(json!({"claimToken":child_token,"owner":child_owner,"ref":child_ref,"stateOid":child_oid,"taskId":id,"taskOid":task}));
    }
    let root_task = &task_oids[root];
    if children.is_empty() {
        let frontier = git::commit(
            &json!({"formatVersion":2,"operationId":operation,"semanticId":semantic,"taskId":root_id,"taskOid":root_task}),
            std::slice::from_ref(root_task),
        )?;
        crate::validators::lifecycle("frontier", &frontier, &root_id)?;
        let frontier_ref = model::state_ref("frontier", &root_id);
        updates.push(Update {
            semantic_ref: frontier_ref.clone(),
            old: None,
            new: Some(frontier.clone()),
        });
        outputs.push((frontier_ref, frontier));
    } else {
        let manifest = git::commit(
            &json!({"children":children,"formatVersion":2,"operationId":operation,"semanticId":semantic,"parentTaskId":root_id,"parentTaskOid":root_task}),
            &[
                vec![root.to_owned(), root_task.clone()],
                frozen
                    .tasks
                    .iter()
                    .filter(|t| t.task != root)
                    .map(|t| task_oids[&t.task].clone())
                    .collect(),
            ]
            .concat(),
        )?;
        crate::validators::waiting(&manifest, &root_id)?;
        let waiting_ref = model::state_ref("waiting", &root_id);
        updates.push(Update {
            semantic_ref: waiting_ref.clone(),
            old: None,
            new: Some(manifest.clone()),
        });
        outputs.push((waiting_ref, manifest));
    }
    for legacy in &frozen.tasks {
        let mapping_ref = format!("refs/heads/tasks/v2/imports/v1/by-sha/{}", legacy.task);
        let terminal_resolution = if legacy.task == root && !frozen.terminal_edges.is_empty() {
            json!({"authorization":authorization,"edgeBlobOids":frozen.terminal_edges,"evidence":resolution_evidence,"disposition":"terminal"})
        } else {
            Value::Null
        };
        let mapping = git::commit(
            &json!({"formatVersion":2,"legacyTaskOid":legacy.task,"migrationDigest":frozen.digest,"operationId":operation,"provenance":{"activation":frozen.activation,"graph":frozen.graph,"graphEdgeBlobOids":legacy.graph_edges,"legacyLifecycleRefs":legacy.lifecycle.iter().map(|(r,o)|json!({"ref":r,"oid":o})).collect::<Vec<_>>(),"master":frozen.master,"terminalExternalEdges":terminal_resolution},"taskId":ids[&legacy.task],"taskOid":task_oids[&legacy.task]}),
            &if legacy.task == root {
                vec![
                    task_oids[&legacy.task].clone(),
                    legacy.task.clone(),
                    frozen.graph.clone(),
                ]
            } else {
                let mut parents = vec![task_oids[&legacy.task].clone(), legacy.task.clone()];
                for (_, oid) in &legacy.lifecycle {
                    if !parents.contains(oid) {
                        parents.push(oid.clone());
                    }
                }
                parents
            },
        )?;
        updates.push(Update {
            semantic_ref: mapping_ref.clone(),
            old: None,
            new: Some(mapping.clone()),
        });
        outputs.push((mapping_ref, mapping));
        for (reference, oid) in &legacy.lifecycle {
            updates.push(Update {
                semantic_ref: reference.clone(),
                old: Some(oid.clone()),
                new: None,
            });
        }
    }
    let result = json!({"blockLeases":block_leases,"claimTokens":tokens,"mapping":ids,"reclaimRequired":true,"rootTaskId":root_id,"terminalExternalEdges":frozen.terminal_edges});
    let receipt = git::commit(
        &json!({"domain":DOMAIN,"formatVersion":2,"operationId":operation,"outputs":result,"semanticDigest":semantic}),
        &outputs.iter().map(|(_, o)| o.clone()).collect::<Vec<_>>(),
    )?;
    updates.push(Update {
        semantic_ref: receipt_ref.clone(),
        old: None,
        new: Some(receipt.clone()),
    });
    outputs.push((receipt_ref, receipt));
    let mut updates = model::canonical_updates(updates);
    let target_updates: Vec<_> = updates
        .iter()
        .map(|update| {
            json!({
                "new": update.new.as_deref().unwrap_or(""),
                "old": update.old.as_deref().unwrap_or(""),
                "ref": update.semantic_ref,
            })
        })
        .collect();
    let target_json = serde_json::to_string(&target_updates).map_err(|e| e.to_string())?;
    let safe_operation = if operation
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && operation.len() <= 128
    {
        operation.to_owned()
    } else {
        model::framed_digest("migrate-v1-guard-operation", &[operation])
    };
    let timestamp = rfc3339(now)?;
    let message = format!(
        "Task-Dag-Activation-Guard: v1\nActivation-Epoch: {}\nActivation-Record-Digest: {}\nGuard-Version: 1\nActivation-Commit: {}\nExpected-Authority-Tip: {}\nWriter-Class: migration\nOperation: {}\nActor: task-dag-v2-migration\nAuthoritative-Timestamp: {}\nTarget-Updates: {}",
        frozen.activation_epoch,
        frozen.activation_digest,
        frozen.activation_parent,
        frozen.activation,
        safe_operation,
        timestamp,
        target_json
    );
    let replacement_guard = git::commit_with_tree(
        &frozen.activation_tree,
        &message,
        std::slice::from_ref(&frozen.activation_parent),
    )?;
    updates.push(Update {
        semantic_ref: "refs/heads/tasks/v1/activation".into(),
        old: Some(frozen.activation.clone()),
        new: Some(replacement_guard.clone()),
    });
    let graph_tree = git::output(["show", "-s", "--format=%T", &frozen.graph])?
        .trim()
        .to_owned();
    model::oid(&graph_tree)?;
    let graph_guard = git::commit_with_tree(
        &graph_tree,
        &format!("Preserve v1 graph during bounded migration {safe_operation}"),
        std::slice::from_ref(&frozen.graph),
    )?;
    updates.push(Update {
        semantic_ref: "refs/heads/tasks/v1/graph".into(),
        old: Some(frozen.graph.clone()),
        new: Some(graph_guard.clone()),
    });
    outputs.push((
        "refs/heads/tasks/v1/activation".into(),
        replacement_guard.clone(),
    ));
    outputs.push(("refs/heads/tasks/v1/graph".into(), graph_guard.clone()));
    updates = model::canonical_updates(updates);
    let j = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        snap.refs.get(ACTIVATION).unwrap(),
        operation,
        &updates,
        &outputs,
    )?;
    #[cfg(feature = "test-seam")]
    if let Ok(raced) = std::env::var("TASKDAG_TEST_RACE_V1_ACTIVATION") {
        model::oid(&raced)?;
        let status = std::process::Command::new("git")
            .args([
                "push",
                &format!(
                    "--force-with-lease=refs/heads/tasks/v1/activation:{}",
                    frozen.activation
                ),
                "origin",
                &format!("{raced}:refs/heads/tasks/v1/activation"),
            ])
            .status()
            .map_err(|e| format!("run migration race seam: {e}"))?;
        if !status.success() {
            return Err("migration race seam could not advance activation".into());
        }
    }
    #[cfg(feature = "test-seam")]
    if let Ok(raced) = std::env::var("TASKDAG_TEST_RACE_V1_GRAPH") {
        model::oid(&raced)?;
        let status = std::process::Command::new("git")
            .args([
                "push",
                &format!(
                    "--force-with-lease=refs/heads/tasks/v1/graph:{}",
                    frozen.graph
                ),
                "origin",
                &format!("{raced}:refs/heads/tasks/v1/graph"),
            ])
            .status()
            .map_err(|e| format!("run migration graph race seam: {e}"))?;
        if !status.success() {
            return Err("migration graph race seam could not advance graph".into());
        }
    }
    repository::mutate(&snap, updates, &j)?;
    let readback = repository::advertise(&[
        "refs/heads/master".into(),
        "refs/heads/tasks/v1/activation".into(),
        "refs/heads/tasks/v1/graph".into(),
    ])?;
    if readback.refs.get("refs/heads/master") != Some(&frozen.master)
        || readback.refs.get("refs/heads/tasks/v1/activation") != Some(&replacement_guard)
        || readback.refs.get("refs/heads/tasks/v1/graph") != Some(&graph_guard)
    {
        return Err("migration committed, but frozen master/v1 activation/graph changed; keep the operator freeze active and reconcile before proceeding".into());
    }
    crate::commands::print_json(&result)
}

fn rfc3339(timestamp: u64) -> Result<String> {
    // `git show` cannot format an arbitrary epoch. Use the ubiquitous POSIX
    // date boundary and validate its fixed UTC output before publishing it.
    let out = std::process::Command::new("date")
        .args(["-u", "-d", &format!("@{timestamp}"), "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .map_err(|e| format!("run date: {e}"))?;
    if !out.status.success() {
        return Err("could not format migration authoritative timestamp".into());
    }
    let text = String::from_utf8(out.stdout)
        .map_err(|e| e.to_string())?
        .trim()
        .to_owned();
    if text.len() != 20 || !text.ends_with('Z') {
        return Err("formatted authoritative timestamp is not RFC3339 UTC".into());
    }
    Ok(text)
}

fn replay(reference: &str, operation: &str, semantic: &str) -> Result<Option<Value>> {
    let snap = repository::advertise(&[reference.into()])?;
    let Some(oid) = snap.refs.get(reference) else {
        return Ok(None);
    };
    repository::materialize(std::slice::from_ref(oid))?;
    let v = git::object_json(oid)?;
    if v["domain"] != DOMAIN || v["operationId"] != operation || v["semanticDigest"] != semantic {
        return Err("migration operation ID was already used with different semantics".into());
    }
    Ok(Some(v["outputs"].clone()))
}
