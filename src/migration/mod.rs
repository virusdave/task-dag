pub(crate) mod scan;

use crate::{
    Result, git,
    model::{self, Update},
    repository,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DOMAIN: &str = "migrate-v1";
const RECURSIVE_APPROXIMATION_POLICY: &str = "legacy-v1-recursive-approximation-v1";

pub(crate) fn census(recursive_approximation: bool) -> Result<()> {
    crate::commands::print_json(&scan::census(recursive_approximation)?)
}

pub(crate) fn run(
    root: &str,
    operation: &str,
    terminal_edges: &[String],
    resolution_authorization: Option<&str>,
    resolution_evidence: &[String],
    recursive_approximation: bool,
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
    let legacy_semantic = if terminal_edges.is_empty() {
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
    let semantic = if recursive_approximation {
        model::framed_digest(
            "migrate-v1-semantics-recursive-approximation",
            &[&legacy_semantic, RECURSIVE_APPROXIMATION_POLICY],
        )
    } else {
        legacy_semantic
    };
    let receipt_ref = format!(
        "refs/heads/tasks/v2/imports/v1/operations/{}",
        model::framed_digest("migrate-v1-operation", &[operation])
    );
    if let Some(value) = replay(&receipt_ref, operation, &semantic)? {
        return crate::commands::print_json(&value);
    }
    let frozen = scan::discover(root, recursive_approximation)?;
    scan::validate_terminal_edges(&frozen.terminal_edges, &terminal_edges)?;
    let snap = repository::checked_snapshot(frozen.patterns.clone())?;
    if snap.refs != frozen.refs {
        return Err("v1 discovery changed between frozen scan and activation capture".into());
    }
    let mut ids = BTreeMap::new();
    for legacy in frozen.planned_tasks.values() {
        ids.insert(
            legacy.task.clone(),
            model::task_id("legacy-v1-sha", &[&legacy.task]),
        );
    }
    let root_id = ids[root].clone();
    let mut task_oids: BTreeMap<String, String> = BTreeMap::new();
    let mut remaining: BTreeMap<_, _> = frozen.planned_tasks.clone();
    while !remaining.is_empty() {
        let key = remaining
            .iter()
            .find(|(_, task)| {
                let is_root = frozen.refs.iter().any(|(reference, oid)| {
                    reference.starts_with("refs/heads/tasks/pending/") && oid == &task.task
                });
                let structural_ready = is_root
                    || frozen.planned_parents[&task.task]
                        .as_ref()
                        .is_some_and(|parent| task_oids.contains_key(parent));
                structural_ready
                    && task
                        .requires
                        .iter()
                        .all(|requirement| task_oids.contains_key(requirement))
            })
            .map(|(key, _)| key.clone())
            .ok_or("legacy pending roots contain a global requirement cycle")?;
        let legacy = remaining.remove(&key).unwrap();
        let requirements: Vec<Value> = legacy
            .requires
            .iter()
            .map(|sha| json!({"taskId":ids[sha],"taskOid":task_oids[sha]}))
            .collect();
        let structural = if frozen.refs.iter().any(|(reference, oid)| {
            reference.starts_with("refs/heads/tasks/pending/") && oid == &legacy.task
        }) {
            Value::Null
        } else {
            let parent = frozen.planned_parents[&legacy.task]
                .clone()
                .ok_or("non-root legacy Task lacks a structural parent")?;
            json!({"taskId":ids[&parent],"taskOid":task_oids[&parent]})
        };
        let task_operation = model::framed_digest("migrate-v1-task-operation", &[&legacy.task]);
        let value = json!({"description":legacy.description,"formatVersion":2,"operationId":task_operation,"requirements":requirements,"structuralParent":structural,"taskId":ids[&legacy.task],"title":legacy.title});
        let mut parents = Vec::new();
        if !structural.is_null() {
            parents.push(structural["taskOid"].as_str().unwrap().to_owned());
        }
        parents.extend(legacy.requires.iter().map(|r| task_oids[r].clone()));
        task_oids.insert(
            legacy.task.clone(),
            git::migration_task_commit(&value, &parents)?,
        );
    }
    let now = crate::commands::timestamp()?;
    let mut updates = Vec::new();
    let mut outputs = Vec::new();
    let mut children = Vec::new();
    let mut nested_children: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut delegation_provenance = Vec::new();
    let mut tokens = BTreeMap::new();
    let mut block_leases = BTreeMap::new();
    for legacy in frozen.tasks.iter().filter(|t| t.task != root) {
        if legacy.disposition == scan::LegacyDisposition::Decomposed {
            continue;
        }
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
        let descriptor = json!({"claimToken":child_token,"owner":child_owner,"ref":child_ref,"stateOid":child_oid,"taskId":id,"taskOid":task});
        let parent = frozen.planned_parents[&legacy.task]
            .as_ref()
            .ok_or("native migration child lacks its immediate structural parent")?;
        if parent == root {
            children.push(descriptor);
        } else {
            nested_children
                .entry(parent.clone())
                .or_default()
                .push(descriptor);
        }
    }
    let root_task = &task_oids[root];
    for delegation in &frozen.delegations {
        let delegated_operation = model::framed_digest(
            "migrate-v1-delegation-operation",
            &[root, &delegation.reference, &delegation.oid],
        );
        let synthetic_source_id = model::task_id(
            "legacy-v1-delegation-source",
            &[root, &delegation.reference, &delegation.oid],
        );
        if let Some(local_target) = &delegation.local_target {
            match local_target {
                scan::LocalDelegationTarget::Completed { task, witness } => {
                    updates.push(Update {
                        semantic_ref: delegation.reference.clone(),
                        old: Some(delegation.oid.clone()),
                        new: None,
                    });
                    delegation_provenance.push(json!({
                        "declarationTrailers": delegation.trailers,
                        "disposition": "completed-local-requirement",
                        "legacyDelegatedOid": delegation.oid,
                        "legacyDelegatedRef": delegation.reference,
                        "normalization": "same-repository delegation->completed requires/all",
                        "operationId": delegated_operation,
                        "pairedEdgeBlobOid": delegation.edge_oid,
                        "peerIssue": delegation.peer_issue,
                        "peerRepository": delegation.peer_repository,
                        "sourceIssue": delegation.source_issue,
                        "targetCompletionWitnessOid": witness,
                        "targetLegacyTaskOid": task,
                    }));
                }
                scan::LocalDelegationTarget::Open { root: target_root } => {
                    let target_id = &ids[target_root];
                    let target_task = &task_oids[target_root];
                    let task_value = json!({
                        "description": format!("Imported same-repository legacy delegation {} at {} for {}#{} as a conjunctive requirement", delegation.oid, delegation.reference, delegation.peer_repository, delegation.peer_issue),
                        "formatVersion": 2,
                        "operationId": delegated_operation,
                        "requirements": [{"taskId": target_id, "taskOid": target_task}],
                        "structuralParent": {"taskId": root_id, "taskOid": root_task},
                        "taskId": synthetic_source_id,
                        "title": format!("Require issue {}#{}", delegation.peer_repository, delegation.peer_issue),
                    });
                    let synthetic_source_task = git::migration_task_commit(
                        &task_value,
                        &[root_task.clone(), target_task.clone()],
                    )?;
                    crate::validators::task(&synthetic_source_task, &synthetic_source_id)?;
                    let frontier = git::migration_task_commit(
                        &json!({"formatVersion":2,"operationId":delegated_operation,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}),
                        std::slice::from_ref(&synthetic_source_task),
                    )?;
                    crate::validators::lifecycle("frontier", &frontier, &synthetic_source_id)?;
                    let frontier_ref = model::state_ref("frontier", &synthetic_source_id);
                    updates.extend([
                        Update {
                            semantic_ref: frontier_ref.clone(),
                            old: None,
                            new: Some(frontier.clone()),
                        },
                        Update {
                            semantic_ref: delegation.reference.clone(),
                            old: Some(delegation.oid.clone()),
                            new: None,
                        },
                    ]);
                    outputs.push((frontier_ref.clone(), frontier.clone()));
                    children.push(json!({"claimToken":null,"owner":null,"ref":frontier_ref,"stateOid":frontier,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}));
                    delegation_provenance.push(json!({
                        "declarationTrailers": delegation.trailers,
                        "disposition": "open-local-requirement",
                        "legacyDelegatedOid": delegation.oid,
                        "legacyDelegatedRef": delegation.reference,
                        "normalization": "same-repository delegation->requires/all",
                        "operationId": delegated_operation,
                        "pairedEdgeBlobOid": delegation.edge_oid,
                        "peerIssue": delegation.peer_issue,
                        "peerRepository": delegation.peer_repository,
                        "sourceIssue": delegation.source_issue,
                        "syntheticTaskId": synthetic_source_id,
                        "syntheticTaskOid": synthetic_source_task,
                        "targetLegacyRootOid": target_root,
                        "targetTaskId": target_id,
                        "targetTaskOid": target_task,
                    }));
                }
                scan::LocalDelegationTarget::Unresolved {
                    root: historical_root,
                } => {
                    let task_value = json!({
                        "description": format!("Verify historical same-repository issue {}#{} closure. Legacy delegation {} at {} was still present, its pending ref was absent, and no canonical issue-close witness exists. Historical issue root: {}", delegation.peer_repository, delegation.peer_issue, delegation.oid, delegation.reference, historical_root),
                        "formatVersion": 2,
                        "operationId": delegated_operation,
                        "requirements": [],
                        "structuralParent": {"taskId": root_id, "taskOid": root_task},
                        "taskId": synthetic_source_id,
                        "title": format!("Verify historical closure of issue {}#{}", delegation.peer_repository, delegation.peer_issue),
                    });
                    let synthetic_source_task =
                        git::migration_task_commit(&task_value, std::slice::from_ref(root_task))?;
                    crate::validators::task(&synthetic_source_task, &synthetic_source_id)?;
                    let frontier = git::migration_task_commit(
                        &json!({"formatVersion":2,"operationId":delegated_operation,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}),
                        std::slice::from_ref(&synthetic_source_task),
                    )?;
                    crate::validators::lifecycle("frontier", &frontier, &synthetic_source_id)?;
                    let frontier_ref = model::state_ref("frontier", &synthetic_source_id);
                    updates.extend([
                        Update {
                            semantic_ref: frontier_ref.clone(),
                            old: None,
                            new: Some(frontier.clone()),
                        },
                        Update {
                            semantic_ref: delegation.reference.clone(),
                            old: Some(delegation.oid.clone()),
                            new: None,
                        },
                    ]);
                    outputs.push((frontier_ref.clone(), frontier.clone()));
                    children.push(json!({"claimToken":null,"owner":null,"ref":frontier_ref,"stateOid":frontier,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}));
                    delegation_provenance.push(json!({
                        "declarationTrailers": delegation.trailers,
                        "disposition": "unresolved-local-requirement",
                        "legacyDelegatedOid": delegation.oid,
                        "legacyDelegatedRef": delegation.reference,
                        "normalization": "same-repository delegation->explicit closure verification child",
                        "operationId": delegated_operation,
                        "pairedEdgeBlobOid": delegation.edge_oid,
                        "peerIssue": delegation.peer_issue,
                        "peerRepository": delegation.peer_repository,
                        "sourceIssue": delegation.source_issue,
                        "syntheticTaskId": synthetic_source_id,
                        "syntheticTaskOid": synthetic_source_task,
                        "targetHistoricalRootOid": historical_root,
                    }));
                }
            }
            continue;
        }
        let target_id = model::task_id(
            "delegated-task",
            &[
                &delegation.source_repository_id,
                &delegation.target_repository_id,
                &delegated_operation,
            ],
        );
        let task_value = json!({"description":format!("Imported legacy delegation {} at {} for {}#{}",delegation.oid,delegation.reference,delegation.peer_repository,delegation.peer_issue),"formatVersion":2,"operationId":delegated_operation,"requirements":[],"structuralParent":{"taskId":root_id,"taskOid":root_task},"taskId":synthetic_source_id,"title":format!("Delegated issue {}#{}",delegation.peer_repository,delegation.peer_issue)});
        let synthetic_source_task =
            git::migration_task_commit(&task_value, std::slice::from_ref(root_task))?;
        crate::validators::task(&synthetic_source_task, &synthetic_source_id)?;
        let semantic_id = model::framed_digest(
            "migrate-v1-delegation-semantic",
            &[root, &delegation.reference, &delegation.oid],
        );
        if let Some(close) = &delegation.close {
            let claim_token =
                model::framed_digest("migration-delegation-token", &[&delegated_operation]);
            let owner = "migration:v1-delegation";
            let active = git::migration_task_commit(
                &json!({"attemptId":model::framed_digest("migration-delegation-active", &[&delegated_operation]),"claimToken":claim_token,"claimedAt":1,"expiresAt":2,"formatVersion":2,"host":"migration","logicalId":semantic_id,"operationId":delegated_operation,"owner":owner,"sessionId":"migration","taskId":synthetic_source_id,"taskOid":synthetic_source_task}),
                std::slice::from_ref(&synthetic_source_task),
            )?;
            crate::validators::lifecycle("active", &active, &synthetic_source_id)?;
            let logical_id = model::framed_digest(
                "migration-delegation-done",
                &[&delegated_operation, &delegation.oid, &close.oid],
            );
            let done = git::migration_task_commit(
                &json!({"closeOid":close.oid,"closeRef":close.reference,"declarationOid":delegation.oid,"declarationRef":delegation.reference,"formatVersion":2,"logicalId":logical_id,"operationId":delegated_operation,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}),
                &[
                    active.clone(),
                    synthetic_source_task.clone(),
                    close.oid.clone(),
                ],
            )?;
            crate::validators::lifecycle("done", &done, &synthetic_source_id)?;
            let done_ref = model::state_ref("done", &synthetic_source_id);
            updates.extend([
                Update {
                    semantic_ref: done_ref.clone(),
                    old: None,
                    new: Some(done.clone()),
                },
                Update {
                    semantic_ref: delegation.reference.clone(),
                    old: Some(delegation.oid.clone()),
                    new: None,
                },
                Update {
                    semantic_ref: close.reference.clone(),
                    old: Some(close.oid.clone()),
                    new: None,
                },
            ]);
            outputs.push((done_ref.clone(), done.clone()));
            children.push(json!({"claimToken":claim_token,"owner":owner,"ref":model::state_ref("active", &synthetic_source_id),"stateOid":active,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}));
            delegation_provenance.push(json!({"closeTrailers":close.trailers,"disposition":"completed-delegation","doneOid":done,"doneRef":done_ref,"legacyCloseOid":close.oid,"legacyCloseRef":close.reference,"declarationTrailers":delegation.trailers,"fleetDigest":delegation.fleet_digest,"legacyDelegatedOid":delegation.oid,"legacyDelegatedRef":delegation.reference,"operationId":delegated_operation,"pairedEdgeBlobOid":delegation.edge_oid,"peerIssue":delegation.peer_issue,"peerRepository":delegation.peer_repository,"sourceIssue":delegation.source_issue,"sourceRepositoryId":delegation.source_repository_id,"syntheticTaskId":synthetic_source_id,"syntheticTaskOid":synthetic_source_task,"targetRepositoryId":delegation.target_repository_id,"targetTaskId":target_id}));
            continue;
        }
        let intent_ref = model::delegation_intent_ref(&delegated_operation);
        let intent = git::migration_task_commit(
            &json!({"description":task_value["description"],"fleetDigest":delegation.fleet_digest,"formatVersion":2,"operationId":delegated_operation,"repositoryPath":[delegation.source_repository_id,delegation.target_repository_id],"semanticId":semantic_id,"sourceRepositoryId":delegation.source_repository_id,"sourceTaskId":synthetic_source_id,"sourceTaskOid":synthetic_source_task,"targetRepositoryId":delegation.target_repository_id,"targetTaskId":target_id,"title":task_value["title"]}),
            &[],
        )?;
        crate::validators::intent(&intent)?;
        let active = git::migration_task_commit(
            &json!({"attemptId":model::framed_digest("migration-delegation-active", &[&delegated_operation]),"claimToken":model::framed_digest("migration-delegation-token", &[&delegated_operation]),"claimedAt":1,"expiresAt":2,"formatVersion":2,"host":"migration","logicalId":semantic_id,"operationId":delegated_operation,"owner":"migration:v1-delegation","sessionId":"migration","taskId":synthetic_source_id,"taskOid":synthetic_source_task}),
            std::slice::from_ref(&synthetic_source_task),
        )?;
        crate::validators::lifecycle("active", &active, &synthetic_source_id)?;
        let waiting = git::migration_task_commit(
            &json!({"formatVersion":2,"intentOid":intent,"intentRef":intent_ref,"operationId":delegated_operation,"parentTaskId":synthetic_source_id,"parentTaskOid":synthetic_source_task,"semanticId":semantic_id,"targetTaskId":target_id}),
            &[active, synthetic_source_task.clone(), intent.clone()],
        )?;
        crate::validators::waiting(&waiting, &synthetic_source_id)?;
        let waiting_ref = model::state_ref("waiting", &synthetic_source_id);
        updates.extend([
            Update {
                semantic_ref: intent_ref.clone(),
                old: None,
                new: Some(intent.clone()),
            },
            Update {
                semantic_ref: waiting_ref.clone(),
                old: None,
                new: Some(waiting.clone()),
            },
            Update {
                semantic_ref: delegation.reference.clone(),
                old: Some(delegation.oid.clone()),
                new: None,
            },
        ]);
        outputs.extend([
            (intent_ref.clone(), intent.clone()),
            (waiting_ref.clone(), waiting.clone()),
        ]);
        children.push(json!({"claimToken":null,"owner":null,"ref":waiting_ref,"stateOid":waiting,"taskId":synthetic_source_id,"taskOid":synthetic_source_task}));
        delegation_provenance.push(json!({"declarationTrailers":delegation.trailers,"disposition":"native-delegation","fleetDigest":delegation.fleet_digest,"intentOid":intent,"intentRef":intent_ref,"legacyDelegatedOid":delegation.oid,"legacyDelegatedRef":delegation.reference,"operationId":delegated_operation,"pairedEdgeBlobOid":delegation.edge_oid,"peerIssue":delegation.peer_issue,"peerRepository":delegation.peer_repository,"sourceIssue":delegation.source_issue,"sourceRepositoryId":delegation.source_repository_id,"syntheticTaskId":synthetic_source_id,"syntheticTaskOid":synthetic_source_task,"targetRepositoryId":delegation.target_repository_id,"targetTaskId":target_id,"waitingOid":waiting}));
    }
    let mut decomposed: BTreeMap<_, _> = frozen
        .tasks
        .iter()
        .filter(|task| task.disposition == scan::LegacyDisposition::Decomposed)
        .map(|task| (task.task.clone(), task))
        .collect();
    while !decomposed.is_empty() {
        let legacy_oid = decomposed
            .keys()
            .find(|oid| {
                frozen.tasks.iter().all(|candidate| {
                    frozen.planned_parents[&candidate.task].as_ref() != Some(*oid)
                        || !decomposed.contains_key(&candidate.task)
                })
            })
            .cloned()
            .ok_or("recursive approximation structural cycle")?;
        decomposed
            .remove(&legacy_oid)
            .ok_or("recursive approximation node disappeared")?;
        let direct = nested_children
            .remove(&legacy_oid)
            .ok_or("decomposed legacy Task has no direct included children")?;
        let id = &ids[&legacy_oid];
        let task = &task_oids[&legacy_oid];
        let manifest = git::commit(
            &json!({"children":direct,"formatVersion":2,"operationId":operation,"semanticId":semantic,"parentTaskId":id,"parentTaskOid":task}),
            &[
                vec![legacy_oid.clone(), task.clone()],
                direct
                    .iter()
                    .map(|child| {
                        child["taskOid"]
                            .as_str()
                            .ok_or_else(|| "waiting child lacks taskOid".to_owned())
                            .map(str::to_owned)
                    })
                    .collect::<Result<Vec<_>>>()?,
            ]
            .concat(),
        )?;
        crate::validators::waiting(&manifest, id)?;
        let waiting_ref = model::state_ref("waiting", id);
        updates.push(Update {
            semantic_ref: waiting_ref.clone(),
            old: None,
            new: Some(manifest.clone()),
        });
        outputs.push((waiting_ref.clone(), manifest.clone()));
        let descriptor = json!({"claimToken":null,"owner":null,"ref":waiting_ref,"stateOid":manifest,"taskId":id,"taskOid":task});
        let parent = frozen.planned_parents[&legacy_oid]
            .as_ref()
            .ok_or("decomposed migration child lacks its immediate structural parent")?;
        if parent == root {
            children.push(descriptor);
        } else {
            nested_children
                .entry(parent.clone())
                .or_default()
                .push(descriptor);
        }
    }
    if !nested_children.is_empty() {
        return Err("recursive approximation left children without an included parent".into());
    }
    if children.is_empty() {
        let legacy_root = &frozen.tasks[0];
        if legacy_root.state == "blocked" {
            let token = crate::commands::claim_token()?;
            let active_record = json!({"attemptId":model::framed_digest("migration-blocked-root-active", &[root]),"claimToken":token,"claimedAt":now.saturating_sub(1),"expiresAt":now,"formatVersion":2,"host":"migration","logicalId":semantic,"operationId":operation,"owner":"migration:v1-blocked-root","reclaimRequired":true,"sessionId":"migration","taskId":root_id,"taskOid":root_task});
            let active = git::commit(&active_record, std::slice::from_ref(root_task))?;
            crate::validators::lifecycle("active", &active, &root_id)?;
            let blocked_record = json!({"authorization":"factual v1 blocked-root migration","blockedAt":legacy_root.blocked_at.unwrap_or(now),"claimTokenDigest":model::digest(&token),"formatVersion":2,"operationId":operation,"reason":legacy_root.blocked_reason.as_deref().unwrap_or("Migrated from legacy v1 blocked root"),"taskId":root_id,"taskOid":root_task});
            let blocked = git::commit(&blocked_record, &[active, root_task.clone()])?;
            crate::validators::lifecycle("blocked", &blocked, &root_id)?;
            let blocked_ref = model::state_ref("blocked", &root_id);
            updates.push(Update {
                semantic_ref: blocked_ref.clone(),
                old: None,
                new: Some(blocked.clone()),
            });
            outputs.push((blocked_ref, blocked.clone()));
            block_leases.insert(root_id.clone(), blocked);
        } else {
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
        }
    } else {
        let manifest = git::commit(
            &json!({"children":children,"formatVersion":2,"operationId":operation,"semanticId":semantic,"parentTaskId":root_id,"parentTaskOid":root_task}),
            &[
                vec![root.to_owned(), root_task.clone()],
                children
                    .iter()
                    .map(|child| child["taskOid"].as_str().unwrap().to_owned())
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
        outputs.push((waiting_ref, manifest.clone()));
        if frozen
            .delegations
            .iter()
            .any(|delegation| delegation.close.is_some())
        {
            updates.push(Update {
                semantic_ref: format!("refs/heads/tasks/reconcile/{root_id}"),
                old: None,
                new: Some(manifest),
            });
        }
    }
    for legacy in &frozen.tasks {
        let mapping_ref = format!("refs/heads/tasks/v2/imports/v1/by-sha/{}", legacy.task);
        let terminal_resolution = if legacy.task == root && !frozen.terminal_edges.is_empty() {
            json!({"authorization":authorization,"edgeBlobOids":frozen.terminal_edges,"evidence":resolution_evidence,"disposition":"terminal"})
        } else {
            Value::Null
        };
        let mut mapping_parents = vec![task_oids[&legacy.task].clone(), legacy.task.clone()];
        for (_, oid) in &legacy.lifecycle {
            if !mapping_parents.contains(oid) {
                mapping_parents.push(oid.clone());
            }
        }
        if legacy.task == root {
            mapping_parents.extend(frozen.graph.iter().cloned());
            mapping_parents.extend(
                frozen
                    .delegations
                    .iter()
                    .map(|delegation| delegation.oid.clone()),
            );
            mapping_parents.extend(
                frozen.delegations.iter().filter_map(|delegation| {
                    delegation.close.as_ref().map(|close| close.oid.clone())
                }),
            );
        }
        let mut mapping_value = json!({"formatVersion":2,"legacyTaskOid":legacy.task,"migrationDigest":frozen.digest,"operationId":operation,"provenance":{"activation":frozen.activation,"completedParentRequirements":legacy.completed_parent_requirements.iter().map(|(task,witness)|json!({"taskOid":task,"completionWitnessOid":witness})).collect::<Vec<_>>(),"delegations":if legacy.task == root {json!(delegation_provenance)} else {json!([])},"graph":frozen.graph,"graphEdgeBlobOids":legacy.graph_edges,"graphNormalizations":legacy.graph_normalizations,"legacyLifecycleRefs":legacy.lifecycle.iter().map(|(r,o)|json!({"ref":r,"oid":o})).collect::<Vec<_>>(),"master":frozen.master,"terminalExternalEdges":terminal_resolution},"taskId":ids[&legacy.task],"taskOid":task_oids[&legacy.task]});
        if frozen.recursive_approximation {
            mapping_value["legacyStructuralParent"] = json!(legacy.structural_parent);
            mapping_value["recursiveApproximationPolicy"] = json!(RECURSIVE_APPROXIMATION_POLICY);
        }
        let mapping = git::commit(&mapping_value, &mapping_parents)?;
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
    let mut result = json!({"blockLeases":block_leases,"claimTokens":tokens,"delegations":delegation_provenance,"mapping":ids,"plannedTaskOids":task_oids,"reclaimRequired":true,"rootTaskId":root_id,"terminalExternalEdges":frozen.terminal_edges});
    if frozen.recursive_approximation {
        result["recursiveApproximationPolicy"] = json!(RECURSIVE_APPROXIMATION_POLICY);
    }
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
    let graph_guard = if let Some(graph) = &frozen.graph {
        let graph_tree = git::output(["show", "-s", "--format=%T", graph])?
            .trim()
            .to_owned();
        model::oid(&graph_tree)?;
        git::commit_with_tree(
            &graph_tree,
            &format!("Preserve v1 graph during bounded migration {safe_operation}"),
            std::slice::from_ref(graph),
        )?
    } else {
        git::commit_with_tree(
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            &format!("Initialize empty v1 graph during bounded migration {safe_operation}"),
            &[],
        )?
    };
    updates.push(Update {
        semantic_ref: "refs/heads/tasks/v1/graph".into(),
        old: frozen.graph.clone(),
        new: Some(graph_guard.clone()),
    });
    outputs.push((
        "refs/heads/tasks/v1/activation".into(),
        replacement_guard.clone(),
    ));
    outputs.push(("refs/heads/tasks/v1/graph".into(), graph_guard.clone()));
    updates = model::canonical_updates(updates);
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
        let expected = frozen.graph.as_deref().unwrap_or("");
        let status = std::process::Command::new("git")
            .args([
                "push",
                &format!("--force-with-lease=refs/heads/tasks/v1/graph:{}", expected),
                "origin",
                &format!("{raced}:refs/heads/tasks/v1/graph"),
            ])
            .status()
            .map_err(|e| format!("run migration graph race seam: {e}"))?;
        if !status.success() {
            return Err("migration graph race seam could not advance graph".into());
        }
    }
    repository::mutate(updates)?;
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
    let _span = tracing::info_span!("migration.format-time").entered();
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
