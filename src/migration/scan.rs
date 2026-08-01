use crate::{Result, git, model, repository};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone)]
pub(super) struct LegacyTask {
    pub(super) task: String,
    pub(super) state: String,
    pub(super) owner: String,
    pub(super) title: String,
    pub(super) description: String,
    pub(super) requires: Vec<String>,
    pub(super) lifecycle: Vec<(String, String)>,
    pub(super) blocked_reason: Option<String>,
    pub(super) blocked_at: Option<u64>,
    pub(super) graph_edges: Vec<String>,
    pub(super) completed_parent_requirements: Vec<(String, String)>,
    pub(super) graph_normalizations: Vec<String>,
    pub(super) structural_parent: Option<String>,
    pub(super) disposition: LegacyDisposition,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LegacyDisposition {
    Native,
    Decomposed,
}
#[derive(Clone)]
pub(super) struct LegacyDelegation {
    pub(super) reference: String,
    pub(super) oid: String,
    pub(super) edge_oid: Option<String>,
    pub(super) close: Option<LegacyDelegatedClose>,
    pub(super) source_issue: String,
    pub(super) peer_repository: String,
    pub(super) peer_issue: String,
    pub(super) trailers: BTreeMap<String, String>,
    pub(super) source_repository_id: String,
    pub(super) target_repository_id: String,
    pub(super) fleet_digest: String,
    pub(super) local_target: Option<LocalDelegationTarget>,
}

#[derive(Clone)]
pub(super) enum LocalDelegationTarget {
    Open { root: String },
    Completed { task: String, witness: String },
    Unresolved { root: String },
}
#[derive(Clone)]
pub(super) struct LegacyDelegatedClose {
    pub(super) reference: String,
    pub(super) oid: String,
    pub(super) trailers: BTreeMap<String, String>,
}
pub(super) struct Frozen {
    pub(super) refs: BTreeMap<String, String>,
    pub(super) patterns: Vec<String>,
    pub(super) tasks: Vec<LegacyTask>,
    pub(super) master: String,
    pub(super) activation: String,
    pub(super) activation_parent: String,
    pub(super) activation_tree: String,
    pub(super) activation_epoch: u64,
    pub(super) activation_digest: String,
    pub(super) graph: Option<String>,
    pub(super) digest: String,
    pub(super) terminal_edges: Vec<String>,
    pub(super) planned_tasks: BTreeMap<String, LegacyTask>,
    pub(super) planned_parents: BTreeMap<String, Option<String>>,
    pub(super) recursive_approximation: bool,
    pub(super) delegations: Vec<LegacyDelegation>,
}

#[derive(Default)]
struct CompletionFacts {
    by_task: BTreeMap<String, String>,
    by_issue: BTreeMap<String, Vec<(String, String)>>,
}

fn migration_patterns() -> Vec<String> {
    vec![
        "refs/heads/master".into(),
        "refs/heads/tasks/v1/activation".into(),
        "refs/heads/tasks/v1/graph".into(),
        "refs/heads/gh/issues/*".into(),
        "refs/heads/tasks/pending/*".into(),
        "refs/heads/tasks/frontier/*".into(),
        "refs/heads/tasks/active/*".into(),
        "refs/heads/tasks/blocked/*".into(),
        "refs/heads/tasks/blocked-meta/*".into(),
        "refs/heads/tasks/root-active/*".into(),
        "refs/heads/tasks/delegated/*".into(),
        "refs/heads/tasks/delegated-close/v1/*".into(),
        "refs/heads/tasks/v2/activation".into(),
        "refs/heads/tasks/system/transitions".into(),
    ]
}

pub(super) fn census(recursive_approximation: bool) -> Result<Value> {
    let patterns = migration_patterns();
    let snapshot = repository::advertise(&patterns)?;
    if snapshot.refs.len() > 500 {
        return Err("migration discovery exceeds 500 refs".into());
    }
    validate_global_delegated_closes(&snapshot)?;
    let pending: Vec<_> = snapshot
        .refs
        .iter()
        .filter(|(reference, _)| reference.starts_with("refs/heads/tasks/pending/"))
        .map(|(reference, root)| (reference.clone(), root.clone()))
        .collect();
    if pending.len() > 100 {
        return Err("migration census exceeds 100 pending roots".into());
    }
    let master = snapshot
        .refs
        .get("refs/heads/master")
        .ok_or("migration requires refs/heads/master")?;
    repository::materialize(std::slice::from_ref(master))?;
    let completion_facts = completion_facts(master, &snapshot)?;
    let mut roots = Vec::new();
    let mut seen = BTreeSet::new();
    for (pending_ref, root) in pending {
        if !seen.insert(root.clone()) {
            return Err("migration root has more than one legacy pending ref".into());
        }
        let frozen = discover_from_snapshot(
            &root,
            patterns.clone(),
            snapshot.clone(),
            Some(&completion_facts),
            recursive_approximation,
        )
        .map_err(|error| format!("migration root {root} at {pending_ref}: {error}"))?;
        roots.push(json!({
            "pendingRef": pending_ref,
            "root": root,
            "snapshotDigest": frozen.digest,
            "taskCount": frozen.tasks.len(),
            "terminalExternalEdges": frozen.terminal_edges,
            "v1ActivationOid": frozen.activation,
            "v1GraphOid": frozen.graph,
            "v1MasterOid": frozen.master,
        }));
    }
    census_race_seam()?;
    if repository::advertise(&patterns)?.refs != snapshot.refs {
        return Err("v1 migration census changed during readback".into());
    }
    Ok(json!({"formatVersion":1,"roots":roots}))
}

pub(super) fn discover(root: &str, recursive_approximation: bool) -> Result<Frozen> {
    let patterns = migration_patterns();
    let snap = repository::advertise(&patterns)?;
    if snap.refs.len() > 500 {
        return Err("migration discovery exceeds 500 refs".into());
    }
    validate_global_delegated_closes(&snap)?;
    let master = snap
        .refs
        .get("refs/heads/master")
        .ok_or("migration requires refs/heads/master")?;
    repository::materialize(std::slice::from_ref(master))?;
    let completion = completion_facts(master, &snap)?;
    let roots: BTreeSet<_> = snap
        .refs
        .iter()
        .filter(|(reference, _)| reference.starts_with("refs/heads/tasks/pending/"))
        .map(|(_, oid)| oid.clone())
        .collect();
    let mut plans = vec![discover_from_snapshot(
        root,
        patterns.clone(),
        snap.clone(),
        Some(&completion),
        recursive_approximation,
    )?];
    let mut planned_root_oids = BTreeSet::from([root.to_owned()]);
    loop {
        let known: BTreeSet<_> = plans
            .iter()
            .flat_map(|plan| plan.tasks.iter().map(|task| task.task.clone()))
            .collect();
        let unresolved = plans
            .iter()
            .flat_map(|plan| plan.tasks.iter())
            .flat_map(|task| task.requires.iter())
            .find(|requirement| !known.contains(*requirement))
            .cloned();
        let Some(requirement) = unresolved else { break };
        let mut owners = Vec::new();
        for candidate in &roots {
            if &requirement == candidate || reaches_structural_root(&requirement, candidate, 100)? {
                owners.push(candidate);
            }
        }
        if owners.len() != 1 {
            return Err(format!(
                "incomplete external Task {requirement} must belong to exactly one pending root"
            ));
        }
        let owner = owners[0];
        if !planned_root_oids.insert(owner.clone()) {
            return Err(format!(
                "incomplete external Task {requirement} belongs to a pending root but lacks a valid schedulable lifecycle"
            ));
        }
        let plan = discover_from_snapshot(
            owner,
            patterns.clone(),
            snap.clone(),
            Some(&completion),
            recursive_approximation,
        )?;
        if !plan.tasks.iter().any(|task| task.task == requirement) {
            return Err(format!(
                "incomplete external Task {requirement} belongs to a pending root but lacks a valid schedulable lifecycle"
            ));
        }
        plans.push(plan);
    }
    let mut planned_tasks = BTreeMap::new();
    let mut planned_parents = BTreeMap::new();
    for plan in &plans {
        let plan_root = plan.tasks[0].task.clone();
        for task in &plan.tasks {
            if planned_tasks
                .insert(task.task.clone(), task.clone())
                .is_some()
            {
                return Err("legacy Task belongs to more than one pending root".into());
            }
            planned_parents.insert(
                task.task.clone(),
                if recursive_approximation {
                    task.structural_parent.clone()
                } else if task.task == plan_root {
                    None
                } else {
                    Some(plan_root.clone())
                },
            );
        }
    }
    let mut selected = plans
        .into_iter()
        .find(|plan| plan.tasks.first().is_some_and(|task| task.task == root))
        .ok_or("root has no legacy pending closure")?;
    selected.planned_tasks = planned_tasks;
    selected.planned_parents = planned_parents;
    Ok(selected)
}

fn validate_global_delegated_closes(snap: &repository::Snapshot) -> Result<()> {
    let declarations: BTreeMap<_, _> = snap
        .refs
        .iter()
        .filter(|(reference, _)| reference.starts_with("refs/heads/tasks/delegated/"))
        .map(|(reference, oid)| (reference.as_str(), oid.as_str()))
        .collect();
    let closes: Vec<_> = snap
        .refs
        .iter()
        .filter(|(reference, _)| reference.starts_with("refs/heads/tasks/delegated-close/v1/"))
        .collect();
    let mut objects: Vec<_> = declarations.values().map(|oid| (*oid).to_owned()).collect();
    objects.extend(closes.iter().map(|(_, oid)| (*oid).clone()));
    repository::materialize(&objects)?;
    let mut total = 0_u64;
    for oid in objects.iter().collect::<BTreeSet<_>>() {
        add_object_size(oid, &mut total)?;
    }
    for (declaration_ref, declaration_oid) in &declarations {
        validate_standalone_declaration(declaration_ref, declaration_oid)?;
    }
    for (close_ref, close_oid) in closes {
        let declaration_ref = close_ref.replacen(
            "refs/heads/tasks/delegated-close/v1/",
            "refs/heads/tasks/delegated/",
            1,
        );
        let declaration_oid = declarations
            .get(declaration_ref.as_str())
            .ok_or("orphan or mismatched legacy delegated-close ref")?;
        validate_declaration_close_binding(
            &declaration_ref,
            declaration_oid,
            close_ref,
            close_oid,
        )?;
    }
    Ok(())
}

fn discover_from_snapshot(
    root: &str,
    patterns: Vec<String>,
    snap: repository::Snapshot,
    precomputed_completion_facts: Option<&CompletionFacts>,
    recursive_approximation: bool,
) -> Result<Frozen> {
    if snap.refs.len() > 500 {
        return Err("migration discovery exceeds 500 refs".into());
    }
    let required = |r: &str| {
        snap.refs
            .get(r)
            .cloned()
            .ok_or_else(|| format!("migration requires {r}"))
    };
    let master = required("refs/heads/master")?;
    let activation = required("refs/heads/tasks/v1/activation")?;
    let v2_activation = required("refs/heads/tasks/v2/activation")?;
    let graph = snap.refs.get("refs/heads/tasks/v1/graph").cloned();
    let pending: Vec<_> = snap
        .refs
        .iter()
        .filter(|(r, o)| r.starts_with("refs/heads/tasks/pending/") && *o == root)
        .collect();
    if pending.len() != 1 {
        return Err("root must have exactly one legacy pending ref".into());
    }
    let mut task_states: BTreeMap<String, Vec<(String, String, String)>> = BTreeMap::new();
    let mut objects = vec![
        master.clone(),
        activation.clone(),
        v2_activation.clone(),
        root.into(),
    ];
    objects.extend(graph.iter().cloned());
    let mut blocked_meta = BTreeMap::new();
    let mut root_active = Vec::new();
    let mut delegated = Vec::new();
    let mut delegated_closes = Vec::new();
    let mut pending_tasks = Vec::new();
    for (r, o) in &snap.refs {
        let state = if let Some(suffix) = r.strip_prefix("refs/heads/tasks/frontier/") {
            legacy_lifecycle_suffix(suffix)?.then_some("frontier")
        } else if let Some(suffix) = r.strip_prefix("refs/heads/tasks/active/") {
            legacy_lifecycle_suffix(suffix)?.then_some("active")
        } else if let Some(suffix) = r.strip_prefix("refs/heads/tasks/blocked/") {
            legacy_lifecycle_suffix(suffix)?.then_some("blocked")
        } else {
            None
        };
        if let Some(state) = state {
            objects.push(o.clone());
            repository::materialize(std::slice::from_ref(o))?;
            let task = if state == "active" {
                git::first_parent(o)?
            } else {
                o.clone()
            };
            task_states
                .entry(task)
                .or_default()
                .push((state.into(), r.clone(), o.clone()));
        } else if let Some(suffix) = r.strip_prefix("refs/heads/tasks/blocked-meta/") {
            if legacy_lifecycle_suffix(suffix)? {
                if blocked_meta
                    .insert(suffix.to_owned(), (r.clone(), o.clone()))
                    .is_some()
                {
                    return Err("duplicate legacy blocked metadata".into());
                }
                objects.push(o.clone());
            }
        } else if r.starts_with("refs/heads/tasks/root-active/") {
            root_active.push((r.clone(), o.clone()));
            objects.push(o.clone());
        } else if r.starts_with("refs/heads/tasks/delegated/") {
            delegated.push((r.clone(), o.clone()));
            objects.push(o.clone());
        } else if r.starts_with("refs/heads/tasks/delegated-close/v1/") {
            delegated_closes.push((r.clone(), o.clone()));
            objects.push(o.clone());
        } else if r.starts_with("refs/heads/tasks/pending/") {
            pending_tasks.push(o.clone());
            objects.push(o.clone());
        }
    }
    objects.extend(task_states.keys().cloned());
    repository::materialize(&objects)?;
    let mut metadata = 0_u64;
    for oid in &objects {
        metadata += git::output(["cat-file", "-s", oid])?
            .trim()
            .parse::<u64>()
            .map_err(|_| "object size malformed")?;
    }
    if metadata > 10 * 1024 * 1024 {
        return Err("migration metadata exceeds 10MiB".into());
    }
    let mut task_parents: BTreeMap<_, _> = task_states
        .keys()
        .map(|task| Ok((task.clone(), git::parents(task)?)))
        .collect::<Result<_>>()?;
    let root_tree = git::output(["show", "-s", "--format=%T", root])?
        .trim()
        .to_owned();
    if root_tree != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" {
        return Err("legacy migration root must use the empty Task tree".into());
    }
    let root_parents = git::parents(root)?;
    if root_parents.len() > 1 {
        return Err("legacy migration root has more than one provenance parent".into());
    }
    let computed_completion_facts = if precomputed_completion_facts.is_none() {
        Some(completion_facts(&master, &snap)?)
    } else {
        None
    };
    let completion_facts = precomputed_completion_facts
        .or(computed_completion_facts.as_ref())
        .ok_or("legacy completion facts unavailable")?;
    let repository = current_repository()?;
    let mut closure = scheduled_closure(root, &task_parents, 100)?;
    if recursive_approximation {
        let mut seeds: BTreeSet<_> = task_parents.keys().cloned().collect();
        loop {
            closure = recursive_closure(root, &seeds, &completion_facts.by_task, 100)?;
            let Some(graph) = graph.as_deref() else {
                break;
            };
            // Discovery parses and validates the graph without charging its objects to
            // metadata repeatedly. The final classification below accounts for it once.
            let mut provisional_metadata = metadata;
            let provisional = inspect_graph(
                graph,
                &closure,
                &repository,
                completion_facts,
                &mut provisional_metadata,
            )?;
            let before = seeds.len();
            seeds.extend(provisional.requires.values().flatten().cloned());
            if seeds.len() == before {
                break;
            }
        }
        for task in &closure {
            task_parents
                .entry(task.clone())
                .or_insert(git::parents(task)?);
            if !objects.contains(task) {
                add_object_size(task, &mut metadata)?;
            }
        }
        if metadata > 10 * 1024 * 1024 {
            return Err("migration metadata exceeds 10MiB".into());
        }
    }
    for (reference, oid) in &snap.refs {
        if let Some(task) = reference.strip_prefix("refs/heads/tasks/blocked/") {
            if closure.contains(task) && oid != task {
                return Err("legacy blocked overlay does not point to its Task".into());
            }
            if closure.contains(oid) && task != oid {
                return Err(
                    "legacy blocked ref must use the full Task OID as its exact path".into(),
                );
            }
        }
    }
    for (task, (_, oid)) in &blocked_meta {
        let parents = git::parents(oid)?;
        if (closure.contains(task) || parents.iter().any(|parent| closure.contains(parent)))
            && parents != [task.clone()]
        {
            return Err("legacy blocked metadata path does not name its Task parent".into());
        }
    }
    for pending_task in pending_tasks.iter().filter(|task| task.as_str() != root) {
        if reaches_structural_root(pending_task, root, 100)? {
            return Err("nested legacy pending root is unsupported".into());
        }
    }
    let pending_suffix = pending[0]
        .0
        .strip_prefix("refs/heads/tasks/pending/")
        .unwrap();
    let mut expired_root_claims = Vec::new();
    for (reference, oid) in &root_active {
        if git::parents(oid)?.iter().any(|parent| parent == root)
            || reference == &format!("refs/heads/tasks/root-active/{pending_suffix}")
        {
            validate_expired_root_claim(reference, oid, pending[0].0, root, pending_suffix)?;
            expired_root_claims.push((reference.clone(), oid.clone()));
        }
    }
    let mut selected_delegations = Vec::new();
    for (reference, oid) in &delegated {
        let parents = git::parents(oid)?;
        let parent_matches = parents == [root];
        let namespace_matches = positive_number(pending_suffix)
            && reference
                .strip_prefix("refs/heads/tasks/delegated/")
                .and_then(|suffix| suffix.split('/').next())
                == Some(pending_suffix);
        if parent_matches || namespace_matches {
            if !parent_matches || (positive_number(pending_suffix) && !namespace_matches) {
                return Err(
                    "legacy delegation ref namespace and selected root parent disagree".into(),
                );
            }
            selected_delegations.push((reference, oid));
        }
    }
    let mut parsed_delegations = Vec::new();
    if !selected_delegations.is_empty() {
        let activation_value = crate::validators::activation(&v2_activation)?;
        let (source_repository_id, fleet_digest, fleet) =
            crate::validators::activation_identity(&activation_value)?;
        let derived_source_id = model::repository_id_for_path(&repository)?;
        if source_repository_id != derived_source_id {
            return Err(
                "activation repositoryId does not match derived source repository ID".into(),
            );
        }
        for (reference, oid) in selected_delegations {
            parsed_delegations.push(parse_delegation(
                reference,
                oid,
                root,
                &repository,
                &source_repository_id,
                &fleet_digest,
                &fleet,
            )?);
        }
    }
    let mut graph_inspection = match graph.as_deref() {
        Some(graph) => inspect_graph(
            graph,
            &closure,
            &repository,
            completion_facts,
            &mut metadata,
        )?,
        None => GraphInspection::empty(),
    };
    for delegation in &mut parsed_delegations {
        let matches: Vec<_> = graph_inspection
            .terminal
            .iter()
            .filter(|(_, task, endpoint)| {
                task == root
                    && endpoint.eq_ignore_ascii_case(&format!(
                        "issue:{}#{}",
                        delegation.peer_repository, delegation.peer_issue
                    ))
            })
            .cloned()
            .collect();
        if matches.len() > 1 {
            return Err("legacy delegation has ambiguous paired graph edges".into());
        }
        if let Some(edge) = matches.first() {
            delegation.edge_oid = Some(edge.0.clone());
            graph_inspection.terminal.retain(|entry| entry.0 != edge.0);
        }
        let expected_close = delegation.reference.replacen(
            "refs/heads/tasks/delegated/",
            "refs/heads/tasks/delegated-close/v1/",
            1,
        );
        let close_matches: Vec<_> = delegated_closes
            .iter()
            .filter(|(reference, _)| reference == &expected_close)
            .collect();
        if close_matches.len() == 1 {
            delegation.close = Some(parse_delegated_close(
                &close_matches[0].0,
                &close_matches[0].1,
                delegation,
                &repository,
            )?);
        }
        if delegation.target_repository_id == delegation.source_repository_id {
            if delegation.close.is_some() {
                return Err("same-repository legacy delegation cannot carry a peer close".into());
            }
            let target_ref = format!("refs/heads/tasks/pending/{}", delegation.peer_issue);
            if let Some(target) = snap.refs.get(&target_ref) {
                if target == root {
                    return Err("same-repository legacy delegation self-cycle".into());
                }
                delegation.local_target = Some(LocalDelegationTarget::Open {
                    root: target.clone(),
                });
            } else {
                let witnesses = completion_facts.by_issue.get(&delegation.peer_issue);
                if witnesses.is_some_and(|witnesses| witnesses.len() > 1) {
                    return Err(
                        "same-repository legacy delegation target completion is ambiguous".into(),
                    );
                }
                if let Some(witness) = witnesses.and_then(|witnesses| witnesses.first()) {
                    delegation.local_target = Some(LocalDelegationTarget::Completed {
                        task: witness.0.clone(),
                        witness: witness.1.clone(),
                    });
                } else {
                    let historical_ref = format!("refs/heads/gh/issues/{}", delegation.peer_issue);
                    let historical_root = snap.refs.get(&historical_ref).ok_or(
                        "same-repository legacy delegation target has no authoritative root",
                    )?;
                    if historical_root == root {
                        return Err("same-repository legacy delegation self-cycle".into());
                    }
                    delegation.local_target = Some(LocalDelegationTarget::Unresolved {
                        root: historical_root.clone(),
                    });
                }
            }
        }
    }
    let mut normalized = BTreeSet::new();
    for delegation in &parsed_delegations {
        if !normalized.insert((
            delegation.source_issue.clone(),
            delegation.peer_repository.to_ascii_lowercase(),
            delegation.peer_issue.clone(),
        )) {
            return Err("duplicate normalized legacy delegation tuple".into());
        }
    }
    if graph_inspection.requires.contains_key(root) {
        return Err(
            "legacy root requirements cannot be represented without a dependency cycle".into(),
        );
    }
    let observed_terminal_edges = graph_inspection
        .terminal
        .iter()
        .map(|entry| entry.0.clone())
        .collect();
    let guard = parse_guard(&activation)?;
    let mut root_state = "pending".to_owned();
    let mut root_lifecycle = vec![(pending[0].0.clone(), pending[0].1.clone())];
    root_lifecycle.extend(expired_root_claims);
    let mut root_blocked_reason = None;
    let mut root_blocked_at = None;
    if let Some(states) = task_states.get(root) {
        if states.len() != 1 || states[0].0 != "blocked" || states[0].2 != root {
            return Err("legacy root has unsupported or conflicting scheduled state".into());
        }
        root_state = "blocked".into();
        root_lifecycle.push((states[0].1.clone(), states[0].2.clone()));
        if let Some((reference, oid)) = blocked_meta.remove(root) {
            let parents = git::parents(&oid)?;
            if parents != [root.to_owned()]
                || git::output(["show", "-s", "--format=%T", &oid])?.trim()
                    != git::output(["show", "-s", "--format=%T", root])?.trim()
            {
                return Err("legacy root blocked metadata shape is malformed".into());
            }
            let raw = git::output(["cat-file", "commit", &oid])?;
            let body = raw
                .split_once("\n\n")
                .map(|(_, message)| message)
                .ok_or("legacy root blocked metadata commit lacks a message")?;
            let parsed = parse_blocked_metadata(&body, root)?;
            root_blocked_reason = parsed.0;
            root_blocked_at = Some(parsed.1);
            root_lifecycle.push((reference, oid));
        }
    }
    let mut tasks = Vec::new();
    let local_open_requirements: Vec<_> = parsed_delegations
        .iter()
        .filter_map(|delegation| match &delegation.local_target {
            Some(LocalDelegationTarget::Open { root }) => Some(root.clone()),
            _ => None,
        })
        .collect();
    tasks.push(LegacyTask {
        task: root.into(),
        state: root_state,
        owner: String::new(),
        title: subject(root)?,
        description: description(root)?,
        requires: local_open_requirements,
        lifecycle: root_lifecycle,
        blocked_reason: root_blocked_reason,
        blocked_at: root_blocked_at,
        graph_edges: graph_inspection
            .provenance
            .get(root)
            .cloned()
            .unwrap_or_default(),
        completed_parent_requirements: graph_inspection
            .completed
            .get(root)
            .cloned()
            .unwrap_or_default(),
        graph_normalizations: graph_inspection
            .normalizations
            .get(root)
            .cloned()
            .unwrap_or_default(),
        structural_parent: None,
        disposition: LegacyDisposition::Native,
    });
    let mut remaining: BTreeSet<_> = closure
        .iter()
        .filter(|s| s.as_str() != root)
        .cloned()
        .collect();
    while !remaining.is_empty() {
        let next = remaining
            .iter()
            .find(|t| {
                task_parents[*t]
                    .iter()
                    .skip(1)
                    .chain(graph_inspection.requires.get(*t).into_iter().flatten())
                    .filter(|p| closure.contains(*p))
                    .all(|p| !remaining.contains(p))
            })
            .cloned()
            .ok_or("legacy dependency cycle")?;
        remaining.remove(&next);
        let states = task_states.get(&next);
        if states.is_none() && !recursive_approximation {
            return Err("legacy task has conflicting or missing lifecycle state".into());
        }
        let empty_states = Vec::new();
        let states = states.unwrap_or(&empty_states);
        let schedule: Vec<_> = states.iter().filter(|state| state.0 != "blocked").collect();
        let blocked: Vec<_> = states.iter().filter(|state| state.0 == "blocked").collect();
        if (!states.is_empty() && schedule.len() != 1) || blocked.len() > 1 {
            return Err("legacy task has conflicting or missing lifecycle state".into());
        }
        let mut lifecycle = schedule
            .first()
            .map(|state| vec![(state.1.clone(), state.2.clone())])
            .unwrap_or_default();
        let mut blocked_reason = None;
        let mut blocked_at = None;
        if let Some(blocked) = blocked.first() {
            lifecycle.push((blocked.1.clone(), blocked.2.clone()));
            if blocked.2 != next {
                return Err("legacy blocked overlay does not point to its Task".into());
            }
            if let Some((reference, oid)) = blocked_meta.remove(&next) {
                let parents = git::parents(&oid)?;
                if parents != [next.clone()]
                    || git::output(["show", "-s", "--format=%T", &oid])?.trim()
                        != git::output(["show", "-s", "--format=%T", &next])?.trim()
                {
                    return Err(
                        "legacy blocked metadata must have one Task parent and its tree".into(),
                    );
                }
                let raw = git::output(["cat-file", "commit", &oid])?;
                let body = raw
                    .split_once("\n\n")
                    .map(|(_, message)| message)
                    .ok_or("legacy blocked metadata commit lacks a message")?;
                let parsed = parse_blocked_metadata(&body, &next)?;
                blocked_reason = parsed.0;
                blocked_at = Some(parsed.1);
                lifecycle.push((reference, oid));
            }
        }
        let external_parents: Vec<_> = task_parents[&next]
            .iter()
            .skip(1)
            .filter(|parent| !closure.contains(*parent))
            .cloned()
            .collect();
        let mut completed_parent_requirements: Vec<_> = external_parents
            .iter()
            .filter_map(|parent| {
                completion_facts
                    .by_task
                    .get(parent)
                    .map(|witness| (parent.clone(), witness.clone()))
            })
            .collect();
        completed_parent_requirements.extend(
            graph_inspection
                .completed
                .get(&next)
                .into_iter()
                .flatten()
                .cloned(),
        );
        let mut requires: BTreeSet<_> = task_parents[&next]
            .iter()
            .skip(1)
            .cloned()
            .filter(|p| closure.contains(p) && p != root)
            .collect();
        requires.extend(
            graph_inspection
                .requires
                .get(&next)
                .into_iter()
                .flatten()
                .cloned(),
        );
        for parent in external_parents {
            if !completion_facts.by_task.contains_key(&parent) {
                let mut owners = Vec::new();
                for candidate in &pending_tasks {
                    if &parent == candidate || reaches_structural_root(&parent, candidate, 100)? {
                        owners.push(candidate);
                    }
                }
                if owners.len() != 1 {
                    return Err(format!(
                        "incomplete external Task {parent} crosses migration closure and must belong to exactly one pending root"
                    ));
                }
                requires.insert(parent);
            }
        }
        if requires.contains(root) {
            return Err("legacy child cannot require its structural root".into());
        }
        if requires.contains(&next) {
            return Err("legacy local requirement self-cycle".into());
        }
        let owner = if schedule.first().is_some_and(|state| state.0 == "active") {
            owner(&schedule[0].2)?
        } else {
            String::new()
        };
        let has_cross_root_requirement = requires
            .iter()
            .any(|requirement| !closure.contains(requirement));
        let block_for_cross_root =
            has_cross_root_requirement && schedule.first().is_some_and(|state| state.0 == "active");
        let has_structural_children = closure.iter().any(|candidate| {
            task_parents
                .get(candidate)
                .and_then(|parents| parents.first())
                == Some(&next)
        });
        let explicit_requirement = closure.iter().any(|candidate| {
            task_parents.get(candidate).is_some_and(|parents| {
                parents
                    .iter()
                    .skip(1)
                    .any(|requirement| requirement == &next)
            })
        }) || graph_inspection
            .requires
            .values()
            .any(|requirements| requirements.contains(&next));
        if states.is_empty() && !has_structural_children && !explicit_requirement {
            return Err(
                "lifecycle-less legacy leaf was not reached as an explicit requirement".into(),
            );
        }
        tasks.push(LegacyTask {
            task: next.clone(),
            state: if states.is_empty() && has_structural_children {
                "waiting".into()
            } else if states.is_empty() {
                "blocked".into()
            } else if blocked.is_empty() && !block_for_cross_root {
                schedule[0].0.clone()
            } else {
                "blocked".into()
            },
            owner,
            title: subject(&next)?,
            description: description(&next)?,
            requires: requires.into_iter().collect(),
            lifecycle,
            blocked_reason: if states.is_empty() && !has_structural_children {
                Some("Preserves a legacy gated or dormant Task; explicit review and unblock are required".into())
            } else { blocked_reason.or_else(|| {
                block_for_cross_root
                    .then(|| "Migrated active Task has an incomplete cross-root requirement".into())
            }) },
            blocked_at,
            graph_edges: graph_inspection
                .provenance
                .get(&next)
                .cloned()
                .unwrap_or_default(),
            completed_parent_requirements,
            graph_normalizations: graph_inspection
                .normalizations
                .get(&next)
                .cloned()
                .unwrap_or_default(),
            structural_parent: task_parents[&next].first().cloned(),
            disposition: if states.is_empty() && has_structural_children { LegacyDisposition::Decomposed } else { LegacyDisposition::Native },
        });
    }
    if recursive_approximation {
        for task in &tasks {
            for requirement in &task.requires {
                if is_structural_ancestor(&task.task, requirement, 100)? {
                    return Err("legacy Task cannot require one of its structural ancestors".into());
                }
            }
        }
    }
    let root_was_blocked = tasks[0].state == "blocked";
    if root_was_blocked && !parsed_delegations.is_empty() {
        return Err("blocked legacy root with delegation is unsupported".into());
    }
    if root_was_blocked && tasks.len() != 1 {
        let reason = tasks[0]
            .blocked_reason
            .clone()
            .unwrap_or_else(|| "Migrated from legacy v1 blocked root".into());
        let blocked_at = tasks[0].blocked_at;
        tasks[0].state = "pending".into();
        for task in tasks.iter_mut().skip(1) {
            if task.disposition == LegacyDisposition::Native && task.state != "blocked" {
                task.state = "blocked".into();
                task.blocked_reason = Some(reason.clone());
                task.blocked_at = blocked_at;
            }
        }
    }
    if blocked_meta.keys().any(|task| closure.contains(task)) {
        return Err("legacy blocked metadata has no matching blocked closure overlay".into());
    }
    let legacy_digest = model::framed_digest(
        "migrate-v1-snapshot",
        &[
            root,
            &master,
            &activation,
            graph.as_deref().unwrap_or("absent"),
            &serde_json::to_string(&snap.refs).map_err(|e| e.to_string())?,
        ],
    );
    let digest = if recursive_approximation {
        model::framed_digest(
            "migrate-v1-snapshot-recursive-approximation",
            &[&legacy_digest, "legacy-v1-recursive-approximation-v1"],
        )
    } else {
        legacy_digest
    };
    Ok(Frozen {
        refs: snap.refs,
        patterns,
        tasks,
        master,
        activation,
        activation_parent: guard.parent,
        activation_tree: guard.tree,
        activation_epoch: guard.epoch,
        activation_digest: guard.digest,
        graph,
        digest,
        terminal_edges: observed_terminal_edges,
        planned_tasks: BTreeMap::new(),
        planned_parents: BTreeMap::new(),
        recursive_approximation,
        delegations: parsed_delegations,
    })
}

#[cfg(feature = "test-seam")]
fn census_race_seam() -> Result<()> {
    let Ok(value) = std::env::var("TASKDAG_TEST_CENSUS_UPDATE") else {
        return Ok(());
    };
    let parts: Vec<_> = value.split('|').collect();
    if parts.len() != 3 || !parts[0].starts_with("refs/heads/tasks/") {
        return Err("census race seam is malformed".into());
    }
    if !parts[1].is_empty() {
        model::oid(parts[1])?;
    }
    model::oid(parts[2])?;
    let status = std::process::Command::new("git")
        .args([
            "push",
            &format!("--force-with-lease={}:{}", parts[0], parts[1]),
            "origin",
            &format!("{}:{}", parts[2], parts[0]),
        ])
        .status()
        .map_err(|error| format!("run census race seam: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("census race seam could not update the remote ref".into())
    }
}

#[cfg(not(feature = "test-seam"))]
fn census_race_seam() -> Result<()> {
    Ok(())
}

#[cfg(test)]
fn descendant_closure(
    root: &str,
    task_parents: &BTreeMap<String, Vec<String>>,
    limit: usize,
) -> Result<BTreeSet<String>> {
    let mut closure = BTreeSet::from([root.to_owned()]);
    let mut queue = VecDeque::from([root.to_owned()]);
    while let Some(parent) = queue.pop_front() {
        for (task, parents) in task_parents {
            if !closure.contains(task) && parents.first() == Some(&parent) {
                closure.insert(task.clone());
                queue.push_back(task.clone());
                if closure.len() > limit {
                    return Err(format!("migration closure exceeds {limit} tasks"));
                }
            }
        }
    }
    Ok(closure)
}

fn scheduled_closure(
    root: &str,
    task_parents: &BTreeMap<String, Vec<String>>,
    limit: usize,
) -> Result<BTreeSet<String>> {
    let mut closure = BTreeSet::from([root.to_owned()]);
    for task in task_parents.keys().filter(|task| task.as_str() != root) {
        if reaches_structural_root(task, root, limit)? {
            closure.insert(task.clone());
            if closure.len() > limit {
                return Err(format!("migration closure exceeds {limit} tasks"));
            }
        }
    }
    Ok(closure)
}

fn recursive_closure(
    root: &str,
    seeds: &BTreeSet<String>,
    completed: &BTreeMap<String, String>,
    limit: usize,
) -> Result<BTreeSet<String>> {
    let mut closure = BTreeSet::from([root.to_owned()]);
    let mut queue: VecDeque<String> = seeds.iter().cloned().collect();
    let mut inspected = BTreeSet::new();
    while let Some(task) = queue.pop_front() {
        if task == root || !inspected.insert(task.clone()) {
            continue;
        }
        if !reaches_structural_root(&task, root, limit)? {
            continue;
        }
        if git::output(["show", "-s", "--format=%T", &task])?.trim()
            != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        {
            return Err("recursive approximation encountered a non-Task object".into());
        }
        let parents = git::parents(&task)?;
        if let Some(parent) = parents.first() {
            queue.push_back(parent.clone());
        }
        for requirement in parents.iter().skip(1) {
            if !completed.contains_key(requirement) {
                queue.push_back(requirement.clone());
            }
        }
        closure.insert(task);
        if closure.len() > limit {
            return Err(format!("migration closure exceeds {limit} tasks"));
        }
    }
    Ok(closure)
}

fn reaches_structural_root(task: &str, root: &str, limit: usize) -> Result<bool> {
    let mut current = task.to_owned();
    let mut seen = BTreeSet::new();
    for _ in 0..limit {
        if !seen.insert(current.clone()) {
            return Err("legacy structural ancestry contains a cycle".into());
        }
        let parents = git::parents(&current)?;
        let Some(parent) = parents.first() else {
            return Ok(false);
        };
        if parent == root {
            return Ok(true);
        }
        if git::output(["show", "-s", "--format=%T", parent])?.trim()
            != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        {
            return Ok(false);
        }
        current = parent.clone();
    }
    Err(format!("legacy structural ancestry exceeds {limit} tasks"))
}

fn is_structural_ancestor(task: &str, candidate: &str, limit: usize) -> Result<bool> {
    let mut current = task.to_owned();
    let mut seen = BTreeSet::new();
    for _ in 0..limit {
        if !seen.insert(current.clone()) {
            return Err("legacy structural ancestry contains a cycle".into());
        }
        let parents = git::parents(&current)?;
        let Some(parent) = parents.first() else {
            return Ok(false);
        };
        if parent == candidate {
            return Ok(true);
        }
        if git::output(["show", "-s", "--format=%T", parent])?.trim()
            != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        {
            return Ok(false);
        }
        current = parent.clone();
    }
    Err(format!("legacy structural ancestry exceeds {limit} tasks"))
}

fn subject(oid: &str) -> Result<String> {
    let raw = git::output(["show", "-s", "--format=%s", oid])?;
    let s = raw
        .trim()
        .strip_prefix("Task: ")
        .unwrap_or(raw.trim())
        .to_owned();
    model::bounded("legacy title", &s, 512)?;
    Ok(s)
}
fn description(oid: &str) -> Result<String> {
    let body = git::output(["show", "-s", "--format=%s%n%n%b", oid])?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    model::bounded("legacy description", &body, 16_384)
        .map_err(|error| format!("{error} for {oid}"))?;
    Ok(body)
}
fn owner(oid: &str) -> Result<String> {
    let body = git::output(["show", "-s", "--format=%B", oid])?;
    let values: Vec<_> = body
        .lines()
        .filter_map(|line| line.strip_prefix("Claimer: "))
        .collect();
    if values.len() != 1 || values[0].is_empty() {
        return Err("active legacy claim must have exactly one canonical Claimer trailer".into());
    }
    let value = values[0];
    model::bounded("legacy owner", value, 256)?;
    Ok(value.into())
}

fn legacy_lifecycle_suffix(suffix: &str) -> Result<bool> {
    if suffix.starts_with("v2-") {
        model::valid_id(suffix)
            .map(|()| false)
            .map_err(|_| format!("malformed v2 lifecycle ref suffix {suffix}"))
    } else {
        Ok(true)
    }
}

fn completion_facts(master: &str, snapshot: &repository::Snapshot) -> Result<CompletionFacts> {
    let scan = git::output(["rev-list", "--first-parent", "--parents", master])?;
    let mut facts = CompletionFacts::default();
    for line in scan.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 3 {
            continue;
        }
        let commit_tree = git::output(["show", "-s", "--format=%T", fields[0]])?;
        let first_tree = git::output(["show", "-s", "--format=%T", fields[1]])?;
        if commit_tree.trim() != first_tree.trim() {
            continue;
        }
        let trailer_keys = git::output([
            "show",
            "-s",
            "--format=%(trailers:keyonly,separator=%x0A)",
            fields[0],
        ])?;
        let close_keys = trailer_keys
            .lines()
            .filter(|key| *key == "Closes-Epic")
            .count();
        let typed_close_keys = trailer_keys
            .lines()
            .filter(|key| *key == "Closes-Epic-ID")
            .count();
        if close_keys > 0 || typed_close_keys > 0 {
            if close_keys == 1 && typed_close_keys == 0 {
                let close = git::output([
                    "show",
                    "-s",
                    "--format=%(trailers:key=Closes-Epic,valueonly,separator=%x0A)",
                    fields[0],
                ])?;
                let issue = close
                    .trim()
                    .strip_prefix('#')
                    .filter(|issue| positive_number(issue));
                if let Some(issue) = issue {
                    let gh_root = snapshot.refs.get(&format!("refs/heads/gh/issues/{issue}"));
                    let pending_root = snapshot
                        .refs
                        .get(&format!("refs/heads/tasks/pending/{issue}"));
                    if gh_root.is_some() && pending_root.is_some() && gh_root != pending_root {
                        return Err("legacy issue root authorities disagree".into());
                    }
                    if gh_root
                        .or(pending_root)
                        .is_some_and(|root| root == fields[2])
                    {
                        facts
                            .by_issue
                            .entry(issue.to_owned())
                            .or_default()
                            .push((fields[2].to_owned(), fields[0].to_owned()));
                    }
                }
            }
            continue;
        }
        let task_tree = git::output(["show", "-s", "--format=%T", fields[2]])?;
        if task_tree.trim() == "4b825dc642cb6eb9a060e54bf8d69288fbee4904" {
            facts
                .by_task
                .insert(fields[2].to_owned(), fields[0].to_owned());
        }
    }
    Ok(facts)
}

fn validate_expired_root_claim(
    reference: &str,
    oid: &str,
    pending_ref: &str,
    root: &str,
    epic_id: &str,
) -> Result<()> {
    if reference != format!("refs/heads/tasks/root-active/{epic_id}")
        || git::parents(oid)? != [root]
        || git::output(["show", "-s", "--format=%T", oid])?.trim()
            != git::output(["show", "-s", "--format=%T", root])?.trim()
    {
        return Err("legacy root claim identity or object shape is malformed".into());
    }
    let message = git::output(["show", "-s", "--format=%B", oid])?;
    let field = |name: &str| -> Result<&str> {
        let prefix = format!("{name}:");
        let values: Vec<_> = message
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix))
            .collect();
        let value = values
            .first()
            .and_then(|value| value.strip_prefix(' '))
            .filter(|value| !value.is_empty() && !value.starts_with(char::is_whitespace));
        if values.len() != 1 || value.is_none() {
            return Err(format!("legacy root claim {name} field is malformed"));
        }
        Ok(value.unwrap())
    };
    if field("Claim-Kind")? != "root" || field("Task-Commit")? != root {
        return Err("legacy root claim does not bind its pending root".into());
    }
    for required in ["Claim-ID", "Claimer", "Claimer-Host"] {
        field(required)?;
    }
    let optional_pid: Vec<_> = message
        .lines()
        .filter_map(|line| line.strip_prefix("Claimer-PID:"))
        .collect();
    if optional_pid.len() > 1 || (optional_pid.len() == 1 && field("Claimer-PID").is_err()) {
        return Err("legacy root claim Claimer-PID field is malformed".into());
    }
    for reserved in ["Issue", "Epic-ID", "Root-Ref"] {
        if message.lines().any(|line| {
            line.strip_prefix(reserved).is_some_and(|suffix| {
                suffix.starts_with(char::is_whitespace) && suffix.trim_start().starts_with(':')
            })
        }) {
            return Err("legacy root claim contains malformed reserved identity field".into());
        }
    }
    let identity_count = |name: &str| {
        message
            .lines()
            .filter(|line| line.starts_with(&format!("{name}:")))
            .count()
    };
    if positive_number(epic_id) {
        if identity_count("Issue") != 1
            || identity_count("Epic-ID") != 0
            || identity_count("Root-Ref") != 0
            || field("Issue")? != format!("#{epic_id}")
        {
            return Err("legacy numeric root claim does not bind its pending root".into());
        }
    } else {
        let digest = epic_id
            .strip_prefix("epic-v1/")
            .filter(|digest| {
                digest.len() == 64
                    && digest
                        .chars()
                        .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
            })
            .ok_or("legacy root claim path dialect is malformed")?;
        if identity_count("Issue") != 0
            || identity_count("Epic-ID") != 1
            || identity_count("Root-Ref") != 1
            || field("Epic-ID")? != format!("epic-v1:{digest}")
            || field("Root-Ref")? != pending_ref
        {
            return Err("legacy typed root claim does not bind its pending root".into());
        }
    }
    let claimed_at = parse_rfc3339(field("Claimed-At")?)?;
    let ttl_raw = field("TTL-Hours")?;
    let ttl_grammar = ttl_raw.chars().all(|c| c.is_ascii_digit())
        || ttl_raw.split_once('.').is_some_and(|(whole, fraction)| {
            !whole.is_empty()
                && whole.chars().all(|c| c.is_ascii_digit())
                && !fraction.is_empty()
                && fraction.chars().all(|c| c.is_ascii_digit())
        });
    if !ttl_grammar {
        return Err("legacy root claim TTL is malformed".into());
    }
    let ttl = ttl_raw
        .parse::<f64>()
        .map_err(|_| "legacy root claim TTL is malformed")?;
    if !ttl.is_finite() || ttl <= 0.0 {
        return Err("legacy root claim TTL is malformed".into());
    }
    let host = std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|host| host.trim().to_owned())
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let configured_host = std::env::var("TASK_DAG_CLAIMER_HOST").unwrap_or_else(|_| host.clone());
    let claimer_host = field("Claimer-Host")?;
    if claimer_host == host || claimer_host == configured_host {
        if let Some(pid) = optional_pid
            .first()
            .and_then(|pid| pid.trim().parse::<u32>().ok())
            .filter(|pid| *pid > 0)
        {
            match std::fs::metadata(format!("/proc/{pid}")) {
                Ok(_) => {
                    return Err("legacy root claim is still live by same-host PID evidence".into());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err("legacy root claim PID liveness is indeterminate".into());
                }
            }
        }
    }
    let expires = claimed_at as f64 + ttl * 3600.0 + 300.0;
    if !expires.is_finite() || crate::commands::timestamp()? as f64 <= expires.round() {
        return Err("legacy root claim is still live".into());
    }
    Ok(())
}

fn parse_blocked_metadata(body: &str, task: &str) -> Result<(Option<String>, u64)> {
    let body = body
        .strip_suffix('\n')
        .ok_or("legacy blocked metadata message lacks its canonical terminator")?;
    if body.ends_with(char::is_whitespace) {
        return Err("legacy blocked metadata has trailing whitespace".into());
    }
    let lines: Vec<_> = body.lines().collect();
    let expected_header = format!("Blocked-Meta: {}", subject(task)?);
    if lines.len() < 5 {
        return Err("legacy blocked metadata has fewer than five lines".into());
    }
    if lines[0] != expected_header {
        return Err(format!(
            "legacy blocked metadata header does not match Task {task}"
        ));
    }
    if !lines[1].is_empty() {
        return Err("legacy blocked metadata header lacks its blank separator".into());
    }
    let order = [
        "Task-Commit",
        "Blocker-Kind",
        "Reason",
        "Request-URL",
        "Repo",
        "Issue",
        "Source-URL",
        "Blocked-By",
        "Blocked-Host",
        "Blocked-At",
    ];
    let mut seen = BTreeSet::new();
    let mut prior = None;
    let mut reason = None;
    let mut blocked_at = None;
    for line in &lines[2..] {
        let (key, value) = line
            .split_once(": ")
            .ok_or("legacy blocked metadata field is malformed")?;
        let position = order
            .iter()
            .position(|candidate| *candidate == key)
            .ok_or("legacy blocked metadata has an unknown field")?;
        if value.is_empty()
            || prior.is_some_and(|previous| position <= previous)
            || !seen.insert(key)
        {
            return Err("legacy blocked metadata fields are not canonical".into());
        }
        model::bounded("legacy blocked metadata field", value, 16_384)?;
        match key {
            "Task-Commit" if value != task => {
                return Err("legacy blocked metadata names the wrong Task".into());
            }
            "Reason" => reason = Some(value.to_owned()),
            "Blocked-At" => blocked_at = Some(parse_rfc3339(value)?),
            _ => {}
        }
        prior = Some(position);
    }
    if lines[2] != format!("Task-Commit: {task}")
        || !lines[3].starts_with("Blocker-Kind: ")
        || !lines.last().unwrap().starts_with("Blocked-At: ")
    {
        return Err("legacy blocked metadata lacks canonical required fields".into());
    }
    Ok((
        reason,
        blocked_at.ok_or("legacy blocked metadata lacks Blocked-At")?,
    ))
}

fn parse_rfc3339(value: &str) -> Result<u64> {
    if value.len() != 20 || !value.ends_with('Z') {
        return Err("legacy Blocked-At is not canonical RFC3339 UTC".into());
    }
    let out = std::process::Command::new("date")
        .args(["-u", "-d", value, "+%s|%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .map_err(|e| format!("parse legacy Blocked-At: {e}"))?;
    if !out.status.success() {
        return Err("legacy Blocked-At is malformed".into());
    }
    let text = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
    let (epoch, roundtrip) = text
        .trim()
        .split_once('|')
        .ok_or("legacy Blocked-At parser returned malformed output")?;
    if roundtrip != value {
        return Err("legacy Blocked-At is not canonical RFC3339 UTC".into());
    }
    epoch
        .parse()
        .map_err(|_| "legacy Blocked-At epoch is malformed".into())
}

#[cfg(test)]
mod tests {
    use super::{
        CompletionFacts, EdgeUse, descendant_closure, edge_id_for_value, inspect_edge,
        inspect_edges, validate_terminal_edges,
    };
    use proptest::prelude::*;
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn malformed_terminal_edges_are_rejected() {
        let task = "1".repeat(40);
        let closure = BTreeSet::from([task.clone()]);
        let valid = serde_json::json!({
            "from":format!("task:owner/repo@{task}"),
            "mode":"all",
            "origin":{"repo-id":1,"witness":"fixture"},
            "relation":"requires",
            "schema":1,
            "to":"issue:owner/repo#1"
        });
        assert_eq!(inspect_edges(&valid, &closure, "owner/repo").unwrap(), true);
        let mut wrong_schema = valid.clone();
        wrong_schema["schema"] = serde_json::json!(999);
        let mut wrong_mode = valid.clone();
        wrong_mode["mode"] = serde_json::json!("any");
        let mut missing_origin = valid.clone();
        missing_origin["origin"] = serde_json::Value::Null;
        let mut zero_repository = valid.clone();
        zero_repository["origin"]["repo-id"] = serde_json::json!(0);
        let mut extra_field = valid.clone();
        extra_field["extra"] = serde_json::json!(true);
        let mut reversed = valid.clone();
        reversed["from"] = valid["to"].clone();
        reversed["to"] = valid["from"].clone();
        let tombstone = serde_json::json!({"from":valid["from"],"mode":"all","origin":valid["origin"],"relation":"requires","schema":1,"to":valid["to"],"tombstone":true});
        for malformed in [
            wrong_schema,
            wrong_mode,
            missing_origin,
            zero_repository,
            extra_field,
        ] {
            assert!(inspect_edges(&malformed, &closure, "owner/repo").is_err());
        }
        assert!(inspect_edges(&reversed, &closure, "owner/repo").is_err());
        assert!(inspect_edges(&tombstone, &closure, "owner/repo").is_err());
        assert!(edge_id_for_value(&tombstone, true).is_ok());
        let mut foreign = valid.clone();
        foreign["from"] = serde_json::json!(format!("task:other/repo@{task}"));
        assert!(inspect_edges(&foreign, &closure, "owner/repo").is_err());
        let mut empty_issue = valid.clone();
        empty_issue["to"] = serde_json::json!("issue:owner/repo#");
        assert!(inspect_edges(&empty_issue, &closure, "owner/repo").is_err());
        let unrelated_64 = serde_json::json!({
            "from":format!("task:owner/repo@{}", "2".repeat(64)),
            "mode":"all",
            "origin":{"repo-id":1,"witness":"fixture"},
            "relation":"requires",
            "schema":1,
            "to":"issue:owner/repo#2"
        });
        assert!(!inspect_edges(&unrelated_64, &closure, "owner/repo").unwrap());
    }

    #[test]
    fn satisfies_any_normalizes_to_a_conjunctive_requirement() {
        let from = "1".repeat(40);
        let to = "2".repeat(40);
        let closure = BTreeSet::from([from.clone()]);
        let edge = serde_json::json!({
            "from":format!("task:owner/repo@{from}"),
            "mode":"any",
            "origin":{"repo-id":1,"witness":"fixture"},
            "relation":"satisfies",
            "schema":1,
            "to":format!("task:owner/repo@{to}")
        });
        let mut facts = CompletionFacts::default();
        assert!(matches!(
            inspect_edge(&edge, &closure, "owner/repo", &facts).unwrap(),
            EdgeUse::Local(task, requirement) if task == from && requirement == to
        ));
        facts.by_task.insert(to.clone(), "4".repeat(40));
        match inspect_edge(&edge, &closure, "owner/repo", &facts).unwrap() {
            EdgeUse::Completed(task, endpoints) => {
                assert_eq!(task, from);
                assert_eq!(endpoints, vec![(to.clone(), "4".repeat(40))]);
            }
            _ => panic!("completed satisfies was not classified as inert provenance"),
        }

        let foreign_source = serde_json::json!({
            "from":format!("task:foreign/repo@{from}"),
            "mode":"any",
            "origin":{"repo-id":1,"witness":"fixture"},
            "relation":"satisfies",
            "schema":1,
            "to":format!("task:owner/repo@{to}")
        });
        assert!(inspect_edge(&foreign_source, &closure, "owner/repo", &facts).is_err());
        let foreign_target = serde_json::json!({
            "from":format!("task:owner/repo@{from}"),
            "mode":"any",
            "origin":{"repo-id":1,"witness":"fixture"},
            "relation":"satisfies",
            "schema":1,
            "to":format!("task:foreign/repo@{to}")
        });
        assert!(inspect_edge(&foreign_target, &closure, "owner/repo", &facts).is_err());
    }

    proptest! {
        #[test]
        fn discovered_closure_is_a_bounded_reachability_fixed_point(
            node_count in 1_usize..32,
            edges in prop::collection::vec(any::<bool>(), 1..1024),
        ) {
            let mut parents = BTreeMap::new();
            for node in 0..node_count {
                let mut node_parents = Vec::new();
                if edges[node % edges.len()] {
                    node_parents.push("root".to_owned());
                }
                for parent in 0..node_count {
                    if edges[(node * node_count + parent + 1) % edges.len()] {
                        node_parents.push(format!("node-{parent}"));
                    }
                }
                parents.insert(format!("node-{node}"), node_parents);
            }
            let closure = descendant_closure("root", &parents, node_count + 1).unwrap();
            prop_assert!(closure.contains("root"));
            prop_assert!(closure.len() <= node_count + 1);
            for (task, task_parents) in &parents {
                let has_reachable_parent = task_parents.first().is_some_and(|parent| closure.contains(parent));
                prop_assert_eq!(closure.contains(task), has_reachable_parent);
            }
        }

        #[test]
        fn terminal_edge_resolution_requires_exact_set(mut values in prop::collection::btree_set(any::<u64>(), 0..32)) {
            let observed: Vec<_> = values
                .iter()
                .map(|value| format!("{value:040x}"))
                .collect();
            prop_assert!(validate_terminal_edges(&observed, &observed).is_ok());
            let extra = values.iter().next_back().copied().unwrap_or(0).saturating_add(1);
            values.insert(extra);
            let changed: Vec<_> = values
                .iter()
                .map(|value| format!("{value:040x}"))
                .collect();
            if changed != observed {
                prop_assert!(validate_terminal_edges(&observed, &changed).is_err());
            }
        }
    }
}

struct Guard {
    parent: String,
    tree: String,
    epoch: u64,
    digest: String,
}

fn parse_guard(oid: &str) -> Result<Guard> {
    let parents = git::parents(oid)?;
    if parents.len() != 1 {
        return Err("v1 activation authority guard must have exactly one parent".into());
    }
    let parent = parents[0].clone();
    let tree = git::output(["show", "-s", "--format=%T", oid])?
        .trim()
        .to_owned();
    let parent_tree = git::output(["show", "-s", "--format=%T", &parent])?
        .trim()
        .to_owned();
    model::oid(&tree)?;
    if tree != parent_tree {
        return Err("v1 activation guard tree differs from activation record".into());
    }
    let body = git::output(["show", "-s", "--format=%B", oid])?;
    let mut fields = BTreeMap::new();
    for line in body.trim_end().lines() {
        let (key, value) = line
            .split_once(": ")
            .ok_or("v1 activation guard field malformed")?;
        if fields.insert(key, value).is_some() {
            return Err("duplicate v1 activation guard field".into());
        }
    }
    let known = [
        "Task-Dag-Activation-Guard",
        "Activation-Epoch",
        "Activation-Record-Digest",
        "Guard-Version",
        "Activation-Commit",
        "Expected-Authority-Tip",
        "Writer-Class",
        "Operation",
        "Actor",
        "Authoritative-Timestamp",
        "Target-Updates",
    ];
    let actual: Vec<_> = body
        .trim_end()
        .lines()
        .filter_map(|line| line.split_once(": ").map(|(key, _)| key))
        .collect();
    if actual != known || fields.len() != known.len() {
        return Err("v1 activation guard fields are not canonical".into());
    }
    if fields["Task-Dag-Activation-Guard"] != "v1"
        || fields["Guard-Version"] != "1"
        || fields["Activation-Commit"] != parent
    {
        return Err("v1 activation guard identity is malformed".into());
    }
    model::oid(fields["Activation-Commit"])?;
    model::oid(fields["Expected-Authority-Tip"])?;
    let epoch = fields["Activation-Epoch"]
        .parse::<u64>()
        .map_err(|_| "activation epoch malformed")?;
    if epoch == 0 {
        return Err("activation epoch must be positive".into());
    }
    let digest = fields["Activation-Record-Digest"].to_owned();
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("activation record digest malformed".into());
    }
    Ok(Guard {
        parent,
        tree,
        epoch,
        digest,
    })
}

struct GraphInspection {
    terminal: Vec<(String, String, String)>,
    requires: BTreeMap<String, BTreeSet<String>>,
    provenance: BTreeMap<String, Vec<String>>,
    completed: BTreeMap<String, Vec<(String, String)>>,
    normalizations: BTreeMap<String, Vec<String>>,
}

impl GraphInspection {
    fn empty() -> Self {
        Self {
            terminal: Vec::new(),
            requires: BTreeMap::new(),
            provenance: BTreeMap::new(),
            completed: BTreeMap::new(),
            normalizations: BTreeMap::new(),
        }
    }
}

fn inspect_graph(
    graph: &str,
    closure: &BTreeSet<String>,
    repository: &str,
    completion_facts: &CompletionFacts,
    total: &mut u64,
) -> Result<GraphInspection> {
    let tree = git::output(["show", "-s", "--format=%T", graph])?
        .trim()
        .to_owned();
    model::oid(&tree)?;
    add_object_size(&tree, total)?;
    let listing = git::output(["ls-tree", "-rl", "--full-tree", &tree])?;
    let mut edges = BTreeMap::new();
    let mut tombstones = BTreeSet::new();
    for line in listing.lines() {
        let (meta, path) = line.split_once('\t').ok_or("malformed graph tree entry")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if parts.len() != 4 || parts[0] != "100644" || parts[1] != "blob" {
            return Err("graph tree contains malformed entry".into());
        }
        model::oid(parts[2])?;
        let size = parts[3]
            .parse::<u64>()
            .map_err(|_| "graph blob size malformed")?;
        *total = total
            .checked_add(size)
            .ok_or("migration metadata size overflow")?;
        if *total > 10 * 1024 * 1024 {
            return Err("migration metadata exceeds 10MiB".into());
        }
        let value: Value = serde_json::from_str(&git::output(["cat-file", "blob", parts[2]])?)
            .map_err(|_| "graph edge blob is malformed JSON")?;
        let (kind, edge_id) = graph_path(path)?;
        let recomputed = edge_id_for_value(&value, kind == "tombstones")?;
        if recomputed != edge_id {
            return Err("graph edge path does not match its semantic edge ID".into());
        }
        if kind == "tombstones" {
            tombstones.insert(edge_id.to_owned());
        } else if edges
            .insert(edge_id.to_owned(), (parts[2].to_owned(), value))
            .is_some()
        {
            return Err("graph contains duplicate semantic edge ID".into());
        }
    }
    let mut terminal_edges = Vec::new();
    let mut requires: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut provenance: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut completed: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut normalizations: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (edge_id, (blob_oid, value)) in edges {
        if !tombstones.contains(&edge_id) {
            let normalized = value["relation"] == "satisfies" && value["mode"] == "any";
            match inspect_edge(&value, closure, repository, completion_facts)? {
                EdgeUse::Unrelated => {}
                EdgeUse::Terminal(task) => {
                    provenance
                        .entry(task.clone())
                        .or_default()
                        .push(blob_oid.clone());
                    terminal_edges.push((blob_oid, task, value["to"].as_str().unwrap().to_owned()));
                }
                EdgeUse::Local(from, to) => {
                    requires.entry(from.clone()).or_default().insert(to);
                    provenance.entry(from.clone()).or_default().push(blob_oid);
                    if normalized {
                        normalizations
                            .entry(from)
                            .or_default()
                            .push("satisfies/any->requires/all".into());
                    }
                }
                EdgeUse::Completed(from, endpoints) => {
                    provenance.entry(from.clone()).or_default().push(blob_oid);
                    normalizations
                        .entry(from.clone())
                        .or_default()
                        .push("satisfies/any->requires/all".into());
                    completed.entry(from).or_default().extend(endpoints);
                }
            }
        }
    }
    terminal_edges.sort();
    Ok(GraphInspection {
        terminal: terminal_edges,
        requires,
        provenance,
        completed,
        normalizations,
    })
}

fn graph_path(path: &str) -> Result<(&str, &str)> {
    let (kind, file) = path
        .split_once('/')
        .ok_or("graph tree contains malformed path")?;
    if !matches!(kind, "edges" | "tombstones") || !file.ends_with(".json") {
        return Err("graph tree contains unexpected path".into());
    }
    let edge_id = file
        .strip_suffix(".json")
        .ok_or("graph tree contains malformed path")?;
    if edge_id.len() != 64
        || !edge_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("graph tree path has malformed semantic edge ID".into());
    }
    Ok((kind, edge_id))
}
fn add_object_size(oid: &str, total: &mut u64) -> Result<()> {
    let size = git::output(["cat-file", "-s", oid])?
        .trim()
        .parse::<u64>()
        .map_err(|_| "graph object size malformed")?;
    *total = total
        .checked_add(size)
        .ok_or("migration metadata size overflow")?;
    if *total > 10 * 1024 * 1024 {
        return Err("migration metadata exceeds 10MiB".into());
    }
    Ok(())
}

#[cfg(test)]
fn inspect_edges(value: &Value, closure: &BTreeSet<String>, repository: &str) -> Result<bool> {
    Ok(!matches!(
        inspect_edge(value, closure, repository, &CompletionFacts::default())?,
        EdgeUse::Unrelated
    ))
}

enum EdgeUse {
    Unrelated,
    Terminal(String),
    Local(String, String),
    Completed(String, Vec<(String, String)>),
}

fn inspect_edge(
    value: &Value,
    closure: &BTreeSet<String>,
    repository: &str,
    completion_facts: &CompletionFacts,
) -> Result<EdgeUse> {
    let map = value
        .as_object()
        .ok_or("graph edge JSON has malformed shape")?;
    validate_edge_shape(map, false)?;
    let from = map["from"].as_str().unwrap();
    let to = map["to"].as_str().unwrap();
    let from_in_closure = endpoint_in_closure(from, closure, repository)?;
    let to_in_closure = endpoint_in_closure(to, closure, repository)?;
    if !from_in_closure && to_in_closure && !from.starts_with(&format!("task:{repository}@")) {
        return Err("v1 graph edge into migration closure has an unsupported source".into());
    }
    if !from_in_closure {
        return Ok(EdgeUse::Unrelated);
    }
    let task_oid = |endpoint: &str| endpoint.rsplit_once('@').map(|(_, oid)| oid.to_owned());
    if map["relation"] == "satisfies" && map["mode"] == "any" {
        let expected_prefix = format!("task:{repository}@");
        if !from.starts_with(&expected_prefix) || !to.starts_with(&expected_prefix) {
            return Err(
                "completed satisfies endpoints must name Tasks in the current repository".into(),
            );
        }
        let from_task = task_oid(from).ok_or("graph satisfies source is not a Task")?;
        let to_task = task_oid(to).ok_or("graph satisfies target is not a Task")?;
        if let Some(to_witness) = completion_facts.by_task.get(&to_task) {
            return Ok(EdgeUse::Completed(
                from_task,
                vec![(to_task, to_witness.clone())],
            ));
        }
        return Ok(EdgeUse::Local(from_task, to_task));
    }
    if map["relation"] != "requires" || map["mode"] != "all" {
        return Err(
            "v1 graph edge touching migration closure is not a terminal external requirement"
                .into(),
        );
    }
    let from_task = task_oid(from).ok_or("graph requirement source is not a Task")?;
    if to.starts_with(&format!("task:{repository}@")) {
        let to_task = task_oid(to).ok_or("graph requirement target is not a Task")?;
        Ok(EdgeUse::Local(from_task, to_task))
    } else if to.starts_with("task:") {
        Err("v1 graph requirement targets a Task in another repository".into())
    } else if to.starts_with("issue:") && !to_in_closure {
        Ok(EdgeUse::Terminal(from_task))
    } else {
        Err("v1 graph requirement crosses the migration closure boundary".into())
    }
}

fn edge_id_for_value(value: &Value, tombstone: bool) -> Result<String> {
    let map = value
        .as_object()
        .ok_or("graph edge JSON has malformed shape")?;
    validate_edge_shape(map, tombstone)?;
    let mut digest = Sha256::new();
    for field in ["from", "to", "relation", "mode"] {
        digest.update(map[field].as_str().unwrap().as_bytes());
        if field != "mode" {
            digest.update([0]);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn validate_edge_shape(map: &serde_json::Map<String, Value>, tombstone: bool) -> Result<()> {
    let expected = if tombstone {
        vec![
            "from",
            "mode",
            "origin",
            "relation",
            "schema",
            "to",
            "tombstone",
        ]
    } else {
        vec!["from", "mode", "origin", "relation", "schema", "to"]
    };
    let origin = map.get("origin").and_then(Value::as_object);
    let repo_id = origin
        .and_then(|value| value.get("repo-id"))
        .and_then(Value::as_u64);
    if map.keys().map(String::as_str).collect::<Vec<_>>() != expected
        || map.get("schema").and_then(Value::as_u64) != Some(1)
        || tombstone
            != map
                .get("tombstone")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        || origin.map(|value| value.keys().map(String::as_str).collect::<Vec<_>>())
            != Some(vec!["repo-id", "witness"])
        || repo_id.is_none_or(|value| value == 0)
        || origin
            .and_then(|value| value.get("witness"))
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err("graph edge blob is not canonical schema 1".into());
    }
    let from = map
        .get("from")
        .and_then(Value::as_str)
        .ok_or("graph edge from is malformed")?;
    let to = map
        .get("to")
        .and_then(Value::as_str)
        .ok_or("graph edge to is malformed")?;
    endpoint_in_closure(from, &BTreeSet::new(), "")?;
    endpoint_in_closure(to, &BTreeSet::new(), "")?;
    match (
        map.get("relation").and_then(Value::as_str),
        map.get("mode").and_then(Value::as_str),
    ) {
        (Some("requires"), Some("all")) | (Some("satisfies"), Some("any")) => Ok(()),
        _ => Err("graph edge relation and mode are not canonical".into()),
    }
}

pub(super) fn validate_terminal_edges(observed: &[String], supplied: &[String]) -> Result<()> {
    if observed == supplied {
        Ok(())
    } else {
        Err("terminal external edge resolutions must exactly match graph edges touching migration closure".into())
    }
}
fn endpoint_in_closure(
    value: &str,
    closure: &BTreeSet<String>,
    current_repository: &str,
) -> Result<bool> {
    if let Some(issue) = value.strip_prefix("issue:") {
        let (repository, number) = issue
            .rsplit_once('#')
            .ok_or("graph issue endpoint is malformed")?;
        if !canonical_repository(repository)
            || number.is_empty()
            || number.starts_with('0')
            || !number.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("graph issue endpoint is malformed".into());
        }
        return Ok(false);
    }
    let task = value
        .strip_prefix("task:")
        .ok_or("graph edge endpoint kind is unsupported")?;
    let (repository, oid) = task
        .rsplit_once('@')
        .ok_or("graph task endpoint is malformed")?;
    if !canonical_repository(repository) {
        return Err("graph task endpoint is malformed".into());
    }
    if !matches!(oid.len(), 40 | 64)
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("graph edge endpoint is malformed".into());
    }
    if closure.contains(oid) && repository != current_repository {
        return Err("graph task endpoint names the migration closure in another repository".into());
    }
    Ok(repository == current_repository && closure.contains(oid))
}

fn canonical_repository(value: &str) -> bool {
    let Some((owner, repository)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !repository.is_empty()
        && !repository.contains('/')
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-' | b'/')
        })
}

pub(crate) fn current_repository() -> Result<String> {
    #[cfg(feature = "test-seam")]
    if let Ok(value) = std::env::var("TASKDAG_TEST_CURRENT_REPOSITORY") {
        if canonical_repository(&value) {
            return Ok(value);
        }
        return Err("test current repository identity is malformed".into());
    }
    let remote = git::output(["remote", "get-url", "origin"])?;
    let remote = remote.trim().trim_end_matches(".git");
    let path = if let Some(path) = remote.strip_prefix("https://github.com/") {
        path
    } else if remote.starts_with("git@") {
        remote
            .split_once(':')
            .map(|(_, path)| path)
            .ok_or("origin URL does not contain a repository path")?
    } else {
        return Err("origin URL does not identify a canonical GitHub repository".into());
    };
    let value = path.to_ascii_lowercase();
    if canonical_repository(&value) {
        model::repository_id_for_path(&value)?;
        Ok(value)
    } else {
        Err("origin URL has malformed GitHub repository identity".into())
    }
}

fn parse_delegation(
    reference: &str,
    oid: &str,
    root: &str,
    repository: &str,
    source_repository_id: &str,
    fleet_digest: &str,
    fleet: &[String],
) -> Result<LegacyDelegation> {
    let suffix = reference
        .strip_prefix("refs/heads/tasks/delegated/")
        .ok_or("legacy delegation ref malformed")?;
    let parts: Vec<_> = suffix.split('/').collect();
    if parts.len() != 4 || !positive_number(parts[0]) || !positive_number(parts[3]) {
        return Err("legacy delegation ref malformed".into());
    }
    let peer_repository = format!("{}/{}", parts[1], parts[2]);
    if !canonical_repository(&peer_repository.to_ascii_lowercase()) {
        return Err("legacy delegation peer repository malformed".into());
    }
    if git::parents(oid)? != [root]
        || git::output(["show", "-s", "--format=%T", oid])?.trim()
            != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    {
        return Err(
            "legacy delegation must be an empty-tree commit with selected root parent".into(),
        );
    }
    let message = git::output(["show", "-s", "--format=%B", oid])?;
    for required in ["kind: delegated", "role: system", "intent: delegated-child"] {
        if message.lines().filter(|line| *line == required).count() != 1 {
            return Err("legacy delegation message header malformed".into());
        }
    }
    let fields = delegation_fields(&message)?;
    if !fields["issue.repo"].eq_ignore_ascii_case(repository)
        || fields["issue.number"] != parts[0]
        || !fields["delegated.repo"].eq_ignore_ascii_case(&peer_repository)
        || fields["delegated.number"] != parts[3]
    {
        return Err("legacy delegation message does not match its ref identity".into());
    }
    let trailer_names = [
        "Parent-Repo-Node-Id",
        "Parent-Issue-Node-Id",
        "Peer-Repo-Node-Id",
        "Peer-Issue-Node-Id",
        "Materialisation-Operation-Id",
        "Declaration-Digest",
    ];
    let mut trailers: BTreeMap<String, String> = BTreeMap::new();
    for name in trailer_names {
        let extracted = git::trailer_values(oid, name)?;
        if extracted.occurrences > 1 || extracted.values.first().is_some_and(String::is_empty) {
            return Err("legacy delegation trailer duplicated or empty".into());
        }
        if let Some(value) = extracted.values.first() {
            trailers.insert(name.to_owned(), value.clone());
        }
    }
    if !matches!(trailers.len(), 0 | 6) {
        return Err("legacy delegation trailers must be all absent or all present".into());
    }
    if trailers.get("Declaration-Digest").is_some_and(|digest| {
        digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err("legacy delegation declaration digest malformed".into());
    }
    let target_repository_id = model::repository_id_for_path(&peer_repository)?;
    if !fleet.contains(&target_repository_id) {
        return Err("legacy delegation target repository is not an activation fleet member".into());
    }
    Ok(LegacyDelegation {
        reference: reference.into(),
        oid: oid.into(),
        edge_oid: None,
        close: None,
        source_issue: parts[0].into(),
        peer_repository,
        peer_issue: parts[3].into(),
        trailers,
        source_repository_id: source_repository_id.into(),
        target_repository_id,
        fleet_digest: fleet_digest.into(),
        local_target: None,
    })
}

fn parse_delegated_close(
    reference: &str,
    oid: &str,
    delegation: &LegacyDelegation,
    repository: &str,
) -> Result<LegacyDelegatedClose> {
    let expected = delegation.reference.replacen(
        "refs/heads/tasks/delegated/",
        "refs/heads/tasks/delegated-close/v1/",
        1,
    );
    if reference != expected {
        return Err("legacy delegated-close path does not exactly match declaration".into());
    }
    if git::parents(oid)? != [delegation.oid.clone()]
        || git::output(["show", "-s", "--format=%T", oid])?.trim()
            != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    {
        return Err(
            "legacy delegated-close must be empty-tree with sole declaration parent".into(),
        );
    }
    let required = [
        "Task-Dag-Delegated-Close",
        "Parent-Repo",
        "Parent-Issue",
        "Peer-Repo",
        "Peer-Issue",
        "Peer-Tip",
        "Peer-Close",
        "Peer-Epic",
    ];
    let identity = [
        "Parent-Repo-Node-Id",
        "Parent-Issue-Node-Id",
        "Peer-Repo-Node-Id",
        "Peer-Issue-Node-Id",
        "Materialisation-Operation-Id",
        "Declaration-Digest",
    ];
    let mut trailers: BTreeMap<String, String> = BTreeMap::new();
    for key in required
        .iter()
        .chain(identity.iter())
        .chain(std::iter::once(&"Legacy-Delegation"))
    {
        let extracted = git::trailer_values(oid, key)?;
        if extracted.occurrences > 1 || extracted.values.first().is_some_and(String::is_empty) {
            return Err("legacy delegated-close trailer duplicated or empty".into());
        }
        if let Some(value) = extracted.values.first() {
            trailers.insert((*key).into(), value.clone());
        }
    }
    if required.iter().any(|key| !trailers.contains_key(*key))
        || trailers["Task-Dag-Delegated-Close"] != "v1"
        || !trailers["Parent-Repo"].eq_ignore_ascii_case(repository)
        || trailers["Parent-Issue"] != format!("#{}", delegation.source_issue)
        || !trailers["Peer-Repo"].eq_ignore_ascii_case(&delegation.peer_repository)
        || trailers["Peer-Issue"] != format!("#{}", delegation.peer_issue)
    {
        return Err("legacy delegated-close binding is malformed".into());
    }
    for key in ["Peer-Tip", "Peer-Close", "Peer-Epic"] {
        let value = &trailers[key];
        if value.len() != 40
            || !value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("legacy delegated-close peer OID is malformed".into());
        }
    }
    if delegation.trailers.is_empty() {
        if identity.iter().any(|key| trailers.contains_key(*key))
            || trailers.get("Legacy-Delegation") != Some(&delegation.oid)
        {
            return Err("legacy delegated-close legacy identity is inconsistent".into());
        }
    } else if trailers.contains_key("Legacy-Delegation")
        || identity
            .iter()
            .any(|key| trailers.get(*key) != delegation.trailers.get(*key))
    {
        return Err("legacy delegated-close modern identity is inconsistent".into());
    }
    Ok(LegacyDelegatedClose {
        reference: reference.into(),
        oid: oid.into(),
        trailers,
    })
}

/// Validate the immutable v1 declaration/close pair without relying on an
/// advertised ref snapshot. Lifecycle validation uses this same strict parser
/// as migration discovery so imported historical state cannot outlive weaker
/// scan-only checks.
pub(crate) fn validate_declaration_close_binding(
    declaration_ref: &str,
    declaration_oid: &str,
    close_ref: &str,
    close_oid: &str,
) -> Result<(String, String, String, String, String)> {
    let (root, source_id, delegation) =
        validate_standalone_declaration(declaration_ref, declaration_oid)?;
    let repository = current_repository()?;
    parse_delegated_close(close_ref, close_oid, &delegation, &repository)?;
    Ok((
        root,
        source_id,
        delegation.target_repository_id,
        delegation.peer_repository,
        delegation.peer_issue,
    ))
}

/// Validate the exact migrated root Task that a historical delegated child is
/// structurally attached to. Generic Task validation alone is insufficient:
/// without these migration bindings, an unrelated synthetic parent could be
/// substituted while retaining a grammatically valid Task graph.
pub(crate) fn expected_imported_root_task(root: &str) -> Result<String> {
    if git::output(["show", "-s", "--format=%T", root])?.trim()
        != "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        || git::parents(root)?.len() > 1
    {
        return Err("migration delegated Task names a malformed legacy root".into());
    }
    let task_id = model::task_id("legacy-v1-sha", &[root]);
    let expected = json!({
        "description": description(root)?,
        "formatVersion": 2,
        "operationId": model::framed_digest("migrate-v1-task-operation", &[root]),
        "requirements": [],
        "structuralParent": Value::Null,
        "taskId": task_id,
        "title": subject(root)?,
    });
    git::migration_task_commit(&expected, &[])
}

fn validate_standalone_declaration(
    declaration_ref: &str,
    declaration_oid: &str,
) -> Result<(String, String, LegacyDelegation)> {
    let root = git::parents(declaration_oid)?;
    if root.len() != 1 {
        return Err("legacy delegation must have exactly one structural-root parent".into());
    }
    let suffix = declaration_ref
        .strip_prefix("refs/heads/tasks/delegated/")
        .ok_or("legacy delegation ref malformed")?;
    let parts: Vec<_> = suffix.split('/').collect();
    if parts.len() != 4 || !positive_number(parts[0]) || !positive_number(parts[3]) {
        return Err("legacy delegation ref malformed".into());
    }
    let peer = format!("{}/{}", parts[1], parts[2]);
    let repository = current_repository()?;
    // Reuse the complete declaration parser. Repository/fleet identity is
    // supplied only to satisfy its activation-era checks and does not loosen
    // any object, ref, grammar, or message binding validation.
    let source_id = model::repository_id_for_path(&repository)?;
    let target_id = model::repository_id_for_path(&peer)?;
    let delegation = parse_delegation(
        declaration_ref,
        declaration_oid,
        &root[0],
        &repository,
        &source_id,
        "lifecycle-validation",
        &[source_id.clone(), target_id],
    )?;
    Ok((root[0].clone(), source_id, delegation))
}

fn positive_number(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('0') && value.bytes().all(|b| b.is_ascii_digit())
}

fn delegation_fields(message: &str) -> Result<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    let mut section = "";
    for line in message.lines() {
        match line {
            "issue:" => section = "issue",
            "delegated:" => section = "delegated",
            _ if line.starts_with("  repo: ") || line.starts_with("  number: ") => {
                if section.is_empty() {
                    return Err("legacy delegation field outside section".into());
                }
                let (name, value) = line[2..]
                    .split_once(": ")
                    .ok_or("legacy delegation field malformed")?;
                if value.is_empty()
                    || fields
                        .insert(format!("{section}.{name}"), value.into())
                        .is_some()
                {
                    return Err("legacy delegation field duplicated or empty".into());
                }
            }
            _ if !line.starts_with(' ') => section = "",
            _ => {}
        }
    }
    if fields.keys().cloned().collect::<Vec<_>>()
        != [
            "delegated.number",
            "delegated.repo",
            "issue.number",
            "issue.repo",
        ]
    {
        return Err("legacy delegation issue/delegated schema malformed".into());
    }
    Ok(fields)
}
