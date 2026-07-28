use crate::{Result, git, model, repository};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone)]
pub(super) struct LegacyTask {
    pub(super) task: String,
    pub(super) state: String,
    pub(super) owner: String,
    pub(super) title: String,
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
}

pub(super) fn discover(root: &str) -> Result<Frozen> {
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
    let mut closure = BTreeSet::from([root.to_owned()]);
    let mut queue = VecDeque::from([root.to_owned()]);
    while let Some(parent) = queue.pop_front() {
        for task in task_states.keys() {
            if !closure.contains(task) && git::parents(task)?.contains(&parent) {
                closure.insert(task.clone());
                queue.push_back(task.clone());
                if closure.len() > 100 {
                    return Err("migration closure exceeds 100 tasks".into());
                }
            }
        }
    }
    inspect_graph(&graph, &closure, &mut metadata)?;
    let guard = parse_guard(&activation)?;
    let mut tasks = Vec::new();
    tasks.push(LegacyTask {
        task: root.into(),
        state: "pending".into(),
        owner: String::new(),
        title: subject(root)?,
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
                git::parents(t)
                    .unwrap_or_default()
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
        let requires = git::parents(&next)?
            .into_iter()
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
    })
}
fn subject(oid: &str) -> Result<String> {
    let s = git::output(["show", "-s", "--format=%s", oid])?
        .trim()
        .to_owned();
    model::bounded("legacy title", &s, 512)?;
    Ok(s)
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

fn inspect_graph(graph: &str, closure: &BTreeSet<String>, total: &mut u64) -> Result<()> {
    let tree = git::output(["show", "-s", "--format=%T", graph])?
        .trim()
        .to_owned();
    model::oid(&tree)?;
    add_object_size(&tree, total)?;
    let listing = git::output(["ls-tree", "-rtl", "--full-tree", &tree])?;
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
        inspect_edges(&value, closure)?;
    }
    Ok(())
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

fn inspect_edges(value: &Value, closure: &BTreeSet<String>) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                inspect_edges(item, closure)?;
            }
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
                if endpoint_in_closure(from, closure)? || endpoint_in_closure(to, closure)? {
                    return Err("v1 graph has an edge touching migration closure".into());
                }
            } else {
                for child in map.values() {
                    inspect_edges(child, closure)?;
                }
            }
        }
        _ => return Err("graph edge JSON has malformed shape".into()),
    }
    Ok(())
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
