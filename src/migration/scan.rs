use crate::{Result, git, model, repository};
use serde_json::Value;
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
    pub(super) graph: String,
    pub(super) digest: String,
    pub(super) terminal_edges: Vec<String>,
}

pub(super) fn discover(root: &str, terminal_edges: &[String]) -> Result<Frozen> {
    let patterns = vec![
        "refs/heads/master".into(),
        "refs/heads/tasks/v1/activation".into(),
        "refs/heads/tasks/v1/graph".into(),
        "refs/heads/tasks/pending/*".into(),
        "refs/heads/tasks/frontier/*".into(),
        "refs/heads/tasks/active/*".into(),
        "refs/heads/tasks/blocked/*".into(),
        "refs/heads/tasks/blocked-meta/*".into(),
        "refs/heads/tasks/v2/activation".into(),
        "refs/heads/tasks/system/transitions".into(),
    ];
    let snap = repository::advertise(&patterns)?;
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
    let graph = required("refs/heads/tasks/v1/graph")?;
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
        graph.clone(),
        root.into(),
    ];
    for (r, o) in &snap.refs {
        let state = if r.starts_with("refs/heads/tasks/frontier/") {
            Some("frontier")
        } else if r.starts_with("refs/heads/tasks/active/") {
            Some("active")
        } else if r.starts_with("refs/heads/tasks/blocked/") {
            Some("blocked")
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
    let task_parents: BTreeMap<_, _> = task_states
        .keys()
        .map(|task| Ok((task.clone(), git::parents(task)?)))
        .collect::<Result<_>>()?;
    let closure = descendant_closure(root, &task_parents, 100)?;
    let observed_terminal_edges = inspect_graph(&graph, &closure, &mut metadata)?;
    validate_terminal_edges(&observed_terminal_edges, terminal_edges)?;
    let guard = parse_guard(&activation)?;
    let mut tasks = Vec::new();
    tasks.push(LegacyTask {
        task: root.into(),
        state: "pending".into(),
        owner: String::new(),
        title: subject(root)?,
        description: description(root)?,
        requires: vec![],
        lifecycle: vec![(pending[0].0.clone(), pending[0].1.clone())],
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
                    .filter(|p| closure.contains(*p) && p.as_str() != root)
                    .all(|p| !remaining.contains(p))
            })
            .cloned()
            .ok_or("legacy dependency cycle")?;
        remaining.remove(&next);
        let states = &task_states[&next];
        if states.len() != 1 {
            return Err("legacy task has conflicting or missing lifecycle state".into());
        }
        if states[0].0 == "blocked" {
            return Err("blocked legacy state in migration closure is unsupported".into());
        }
        let requires = task_parents[&next]
            .iter()
            .cloned()
            .filter(|p| closure.contains(p) && p != root)
            .collect();
        let owner = if states[0].0 == "active" {
            owner(&states[0].2)?
        } else {
            String::new()
        };
        tasks.push(LegacyTask {
            task: next.clone(),
            state: states[0].0.clone(),
            owner,
            title: subject(&next)?,
            description: description(&next)?,
            requires,
            lifecycle: vec![(states[0].1.clone(), states[0].2.clone())],
        });
    }
    let digest = model::framed_digest(
        "migrate-v1-snapshot",
        &[
            root,
            &master,
            &activation,
            &graph,
            &serde_json::to_string(&snap.refs).map_err(|e| e.to_string())?,
        ],
    );
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
    })
}

fn descendant_closure(
    root: &str,
    task_parents: &BTreeMap<String, Vec<String>>,
    limit: usize,
) -> Result<BTreeSet<String>> {
    let mut closure = BTreeSet::from([root.to_owned()]);
    let mut queue = VecDeque::from([root.to_owned()]);
    while let Some(parent) = queue.pop_front() {
        for (task, parents) in task_parents {
            if !closure.contains(task) && parents.contains(&parent) {
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

fn subject(oid: &str) -> Result<String> {
    let s = git::output(["show", "-s", "--format=%s", oid])?
        .trim()
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

#[cfg(test)]
mod tests {
    use super::{descendant_closure, inspect_edges, validate_terminal_edges};
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
        assert_eq!(inspect_edges(&valid, &closure).unwrap(), true);
        let mut wrong_schema = valid.clone();
        wrong_schema["schema"] = serde_json::json!(999);
        let mut wrong_mode = valid.clone();
        wrong_mode["mode"] = serde_json::json!("any");
        let mut missing_origin = valid.clone();
        missing_origin["origin"] = serde_json::Value::Null;
        let tombstone =
            serde_json::json!({"schema":1,"tombstone":true,"from":valid["from"],"to":valid["to"]});
        for malformed in [wrong_schema, wrong_mode, missing_origin, tombstone] {
            assert!(inspect_edges(&malformed, &closure).is_err());
        }
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
                let has_reachable_parent = task_parents.iter().any(|parent| closure.contains(parent));
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

fn inspect_graph(graph: &str, closure: &BTreeSet<String>, total: &mut u64) -> Result<Vec<String>> {
    let tree = git::output(["show", "-s", "--format=%T", graph])?
        .trim()
        .to_owned();
    model::oid(&tree)?;
    add_object_size(&tree, total)?;
    let listing = git::output(["ls-tree", "-rtl", "--full-tree", &tree])?;
    let mut terminal_edges = Vec::new();
    for line in listing.lines() {
        let (meta, _) = line.split_once('\t').ok_or("malformed graph tree entry")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if parts.len() != 4 || !matches!(parts[1], "blob" | "tree") {
            return Err("graph tree contains malformed entry".into());
        }
        model::oid(parts[2])?;
        if parts[1] == "tree" {
            add_object_size(parts[2], total)?;
            continue;
        }
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
        if inspect_edges(&value, closure)? {
            terminal_edges.push(parts[2].to_owned());
        }
    }
    terminal_edges.sort();
    Ok(terminal_edges)
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

fn inspect_edges(value: &Value, closure: &BTreeSet<String>) -> Result<bool> {
    match value {
        Value::Array(items) => {
            let mut touches = false;
            for item in items {
                touches |= inspect_edges(item, closure)?;
            }
            Ok(touches)
        }
        Value::Object(map) => {
            if map.contains_key("from") || map.contains_key("to") {
                let from = map
                    .get("from")
                    .and_then(Value::as_str)
                    .ok_or("graph edge from is malformed")?;
                let to = map
                    .get("to")
                    .and_then(Value::as_str)
                    .ok_or("graph edge to is malformed")?;
                let from_in_closure = endpoint_in_closure(from, closure)?;
                let to_in_closure = endpoint_in_closure(to, closure)?;
                if from_in_closure || to_in_closure {
                    let canonical_keys = ["from", "mode", "origin", "relation", "schema", "to"];
                    let origin = map.get("origin").and_then(Value::as_object);
                    if map.keys().map(String::as_str).collect::<Vec<_>>() != canonical_keys
                        || map.get("schema").and_then(Value::as_u64) != Some(1)
                        || map.get("mode").and_then(Value::as_str) != Some("all")
                        || origin.map(|value| value.len()) != Some(2)
                        || origin
                            .and_then(|value| value.get("repo-id"))
                            .and_then(Value::as_u64)
                            .is_none()
                        || origin
                            .and_then(|value| value.get("witness"))
                            .and_then(Value::as_str)
                            .is_none_or(str::is_empty)
                        || from_in_closure == to_in_closure
                        || map.get("relation").and_then(Value::as_str) != Some("requires")
                        || !if from_in_closure { to } else { from }.starts_with("issue:")
                    {
                        return Err("v1 graph edge touching migration closure is not a terminal external requirement".into());
                    }
                    return Ok(true);
                }
                Ok(false)
            } else {
                let mut touches = false;
                for child in map.values() {
                    touches |= inspect_edges(child, closure)?;
                }
                Ok(touches)
            }
        }
        _ => return Err("graph edge JSON has malformed shape".into()),
    }
}

fn validate_terminal_edges(observed: &[String], supplied: &[String]) -> Result<()> {
    if observed == supplied {
        Ok(())
    } else {
        Err("terminal external edge resolutions must exactly match graph edges touching migration closure".into())
    }
}
fn endpoint_in_closure(value: &str, closure: &BTreeSet<String>) -> Result<bool> {
    if let Some(issue) = value.strip_prefix("issue:") {
        let (repository, number) = issue
            .rsplit_once('#')
            .ok_or("graph issue endpoint is malformed")?;
        if repository.is_empty()
            || number.is_empty()
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
    if repository.is_empty() {
        return Err("graph task endpoint is malformed".into());
    }
    model::oid(oid).map_err(|_| "graph edge endpoint is malformed")?;
    Ok(closure.contains(oid))
}
