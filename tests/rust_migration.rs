use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn git(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap()
}
fn ok(cwd: &Path, args: &[&str]) -> String {
    let out = git(cwd, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn commit(cwd: &Path, message: &str, parents: &[&str]) -> String {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(["commit-tree", EMPTY_TREE])
        .env("GIT_AUTHOR_NAME", "task-dag test")
        .env("GIT_AUTHOR_EMAIL", "task-dag-test@localhost")
        .env("GIT_COMMITTER_NAME", "task-dag test")
        .env("GIT_COMMITTER_EMAIL", "task-dag-test@localhost");
    for parent in parents {
        command.args(["-p", parent]);
    }
    let out = command.args(["-m", message]).output().unwrap();
    assert!(
        out.status.success(),
        "commit-tree: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn body(cwd: &Path, oid: &str) -> Value {
    serde_json::from_str(&ok(cwd, &["show", "-s", "--format=%B", oid])).unwrap()
}
fn repository_id(path: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_ascii_lowercase().as_bytes());
    format!("repo-v2-{:x}", digest.finalize())
}

struct Fixture {
    root_dir: PathBuf,
    work: PathBuf,
    root: String,
    tasks: BTreeMap<&'static str, String>,
    refs: BTreeMap<String, String>,
    activation: String,
    graph: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root_dir);
    }
}

impl Fixture {
    fn new(blocked_in_closure: bool, singleton: bool) -> Self {
        Self::new_with_activation_identity(blocked_in_closure, singleton, true)
    }
    fn new_legacy_activation(blocked_in_closure: bool, singleton: bool) -> Self {
        Self::new_with_activation_identity(blocked_in_closure, singleton, false)
    }
    fn new_with_activation_identity(
        blocked_in_closure: bool,
        singleton: bool,
        activation_identity: bool,
    ) -> Self {
        let root_dir = std::env::temp_dir().join(format!(
            "taskdag-migration-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root_dir).unwrap();
        let origin = root_dir.join("origin.git");
        let runtime_origin = root_dir.join("runtime-origin.git");
        ok(&root_dir, &["init", "--bare", origin.to_str().unwrap()]);
        ok(
            &root_dir,
            &["init", "--bare", runtime_origin.to_str().unwrap()],
        );
        let source = Path::new(env!("CARGO_MANIFEST_DIR"));
        let floor = commit(source, "fixture master", &[]);
        ok(
            source,
            &[
                "push",
                origin.to_str().unwrap(),
                &format!("{floor}:refs/heads/master"),
            ],
        );
        let work = root_dir.join("work");
        ok(
            &root_dir,
            &["clone", origin.to_str().unwrap(), work.to_str().unwrap()],
        );
        ok(&work, &["config", "user.name", "migration test"]);
        ok(&work, &["config", "user.email", "migration@test.invalid"]);
        let runtime = env!("TASKDAG_BUILD_COMMIT");
        ok(&work, &["fetch", source.to_str().unwrap(), runtime]);
        Self::run_raw(
            &work,
            &["runtime", "publish", "--commit", runtime],
            None,
            None,
        );
        if activation_identity {
            let source_id = repository_id("owner/repo");
            let peer_id = repository_id("peer/repo");
            let mut fleet = [source_id.as_str(), peer_id.as_str()];
            fleet.sort();
            Self::run_raw(
                &work,
                &[
                    "init",
                    "--trusted-floor",
                    &floor,
                    "--repository-id",
                    &source_id,
                    "--fleet-repository-id",
                    fleet[0],
                    "--fleet-repository-id",
                    fleet[1],
                ],
                None,
                None,
            );
        } else {
            Self::run_raw(
                &work,
                &["init", "--trusted-floor", &floor],
                Some(("TASKDAG_TEST_LEGACY_ACTIVATION", "1")),
                None,
            );
        }
        let root = commit(&work, "Root\n\nLegacy project context", &[]);
        let active = commit(&work, "Active child", &[&root]);
        let a = commit(&work, "Frontier A", &[&root, &active]);
        let b = commit(&work, "Frontier B", &[&root, &a]);
        let c = commit(&work, "Frontier C", &[&root, &b]);
        let sibling = commit(&work, "Active sibling", &[&root]);
        let other_root = commit(&work, "Other root", &[]);
        let other_frontier = commit(&work, "Other frontier", &[&other_root]);
        let other_active = commit(&work, "Other active", &[&other_root]);
        let other_blocked = commit(&work, "Other blocked", &[&other_root]);
        let claim_a = commit(&work, "Claim\n\nClaimer: worker-a", &[&active]);
        let claim_sibling = commit(&work, "Claim\n\nClaimer: worker-b", &[&sibling]);
        let claim_other = commit(&work, "Claim\n\nClaimer: unrelated", &[&other_active]);

        let record = commit(
            &work,
            r#"{"formatVersion":1,"state":"draining"}"#,
            &[&floor],
        );
        let digest = "a".repeat(64);
        let guard_message = format!(
            "Task-Dag-Activation-Guard: v1\nActivation-Epoch: 7\nActivation-Record-Digest: {digest}\nGuard-Version: 1\nActivation-Commit: {record}\nExpected-Authority-Tip: {record}\nWriter-Class: fixture\nOperation: seed\nActor: migration-test\nAuthoritative-Timestamp: 2026-07-28T00:00:00Z\nTarget-Updates: []"
        );
        let activation = commit(&work, &guard_message, &[&record]);
        let graph = Self::graph_commit(&work, &other_frontier, None);

        let mut refs = BTreeMap::new();
        refs.insert("refs/heads/tasks/pending/root".into(), root.clone());
        if !singleton {
            refs.insert("refs/heads/tasks/active/active".into(), claim_a);
            refs.insert("refs/heads/tasks/frontier/a".into(), a.clone());
            refs.insert("refs/heads/tasks/frontier/b".into(), b.clone());
            refs.insert("refs/heads/tasks/frontier/c".into(), c.clone());
            refs.insert("refs/heads/tasks/active/sibling".into(), claim_sibling);
        }
        refs.insert(
            "refs/heads/tasks/pending/other-root".into(),
            other_root.clone(),
        );
        refs.insert(
            "refs/heads/tasks/frontier/other-frontier".into(),
            other_frontier.clone(),
        );
        refs.insert("refs/heads/tasks/active/other-active".into(), claim_other);
        refs.insert(
            "refs/heads/tasks/blocked/other-blocked".into(),
            other_blocked.clone(),
        );
        refs.insert(
            "refs/heads/tasks/blocked-meta/other-blocked".into(),
            commit(&work, "blocked metadata", &[&other_blocked]),
        );
        if blocked_in_closure {
            refs.remove("refs/heads/tasks/frontier/c");
            refs.insert(format!("refs/heads/tasks/frontier/blocked-{c}"), c.clone());
            refs.insert(format!("refs/heads/tasks/blocked/{c}"), c.clone());
            refs.insert(
                format!("refs/heads/tasks/blocked-meta/{c}"),
                commit(
                    &work,
                    &format!("Blocked-Meta: Frontier C\n\nTask-Commit: {c}\nBlocker-Kind: manual\nReason: Waiting for reviewed input\nBlocked-At: 2026-07-28T00:00:00Z"),
                    &[&c],
                ),
            );
        }
        refs.insert("refs/heads/tasks/v1/activation".into(), activation.clone());
        refs.insert("refs/heads/tasks/v1/graph".into(), graph.clone());
        for (reference, oid) in &refs {
            ok(&work, &["push", "origin", &format!("{oid}:{reference}")]);
        }
        let tasks = BTreeMap::from([
            ("root", root.clone()),
            ("active", active),
            ("a", a),
            ("b", b),
            ("c", c),
            ("sibling", sibling),
            ("other_root", other_root),
            ("other_frontier", other_frontier),
            ("other_active", other_active),
            ("other_blocked", other_blocked),
        ]);
        Self {
            root_dir,
            work,
            root,
            tasks,
            refs,
            activation,
            graph,
        }
    }

    fn graph_commit(work: &Path, task: &str, parent: Option<&str>) -> String {
        let edge = json!({"from":format!("task:owner/repo@{task}"),"mode":"all","origin":{"repo-id":1,"witness":"fixture"},"relation":"requires","schema":1,"to":"issue:owner/repo#42"});
        Self::graph_commit_edge(work, &edge, parent)
    }

    fn graph_commit_edge(work: &Path, edge: &Value, parent: Option<&str>) -> String {
        let mut edge_id = Sha256::new();
        for (index, value) in [
            edge["from"].as_str().unwrap(),
            edge["to"].as_str().unwrap(),
            edge["relation"].as_str().unwrap(),
            edge["mode"].as_str().unwrap(),
        ]
        .into_iter()
        .enumerate()
        {
            edge_id.update(value.as_bytes());
            if index < 3 {
                edge_id.update([0]);
            }
        }
        let edge_id = format!("{:x}", edge_id.finalize());
        let blob: String = {
            let mut child = Command::new("git")
                .current_dir(work)
                .args(["hash-object", "-w", "--stdin"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(serde_json::to_string(&edge).unwrap().as_bytes())
                .unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .into()
        };
        let edges_tree: String = {
            let mut child = Command::new("git")
                .current_dir(work)
                .args(["mktree"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            writeln!(
                child.stdin.as_mut().unwrap(),
                "100644 blob {blob}\t{edge_id}.json"
            )
            .unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .into()
        };
        let tree: String = {
            let mut child = Command::new("git")
                .current_dir(work)
                .args(["mktree"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            writeln!(
                child.stdin.as_mut().unwrap(),
                "040000 tree {edges_tree}\tedges"
            )
            .unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .into()
        };
        match parent {
            Some(parent) => ok(work, &["commit-tree", &tree, "-p", parent, "-m", "graph"]),
            None => ok(work, &["commit-tree", &tree, "-m", "graph"]),
        }
    }

    fn run_raw(
        work: &Path,
        args: &[&str],
        extra: Option<(&str, &str)>,
        token: Option<&str>,
    ) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_task-dag"));
        cmd.current_dir(work)
            .args(args)
            .env("TASKDAG_TEST_TIME", "1785196800")
            .env("TASKDAG_TEST_CURRENT_REPOSITORY", "owner/repo")
            .env("TASKDAG_SESSION_ID", "migration-integration")
            .env(
                "TASKDAG_TEST_RUNTIME_REMOTE",
                work.parent().unwrap().join("runtime-origin.git"),
            );
        if let Some(token) = token {
            cmd.env("TASKDAG_TEST_TOKEN", token);
        }
        if let Some((key, value)) = extra {
            cmd.env(key, value);
        }
        cmd.output().unwrap()
    }
    fn migrate(&self, operation: &str, extra: Option<(&str, &str)>) -> Output {
        self.migrate_root(&self.root, operation, extra)
    }
    fn migrate_root(&self, root: &str, operation: &str, extra: Option<(&str, &str)>) -> Output {
        Self::run_raw(
            &self.work,
            &["migrate-v1", "--root", root, "--operation-id", operation],
            extra,
            Some("migration-token-0001"),
        )
    }
    fn census(&self) -> Output {
        Self::run_raw(&self.work, &["migrate-v1-census"], None, None)
    }
    fn census_with_update(&self, reference: &str, old: &str, new: &str) -> Output {
        Self::run_raw(
            &self.work,
            &["migrate-v1-census"],
            Some((
                "TASKDAG_TEST_CENSUS_UPDATE",
                &format!("{reference}|{old}|{new}"),
            )),
            None,
        )
    }
    fn remove_other_root(&self) {
        for reference in self
            .refs
            .keys()
            .filter(|reference| reference.contains("other"))
        {
            ok(&self.work, &["push", "origin", "--delete", reference]);
        }
    }
    fn replace_singleton_root(&mut self, parents: &[&str]) {
        assert_eq!(self.refs.get("refs/heads/tasks/frontier/a"), None);
        let replacement = commit(&self.work, "Root\n\nLegacy project context", parents);
        ok(
            &self.work,
            &[
                "push",
                &format!(
                    "--force-with-lease=refs/heads/tasks/pending/root:{}",
                    self.root
                ),
                "origin",
                &format!("{replacement}:refs/heads/tasks/pending/root"),
            ],
        );
        self.root = replacement.clone();
        self.tasks.insert("root", replacement.clone());
        self.refs
            .insert("refs/heads/tasks/pending/root".into(), replacement);
    }
    fn remove_graph(&self) {
        ok(
            &self.work,
            &["push", "origin", "--delete", "refs/heads/tasks/v1/graph"],
        );
    }
    fn add_v2_blocked_state(&self) {
        let task_id = format!("v2-{}", "1".repeat(64));
        let task = commit(
            &self.work,
            &serde_json::to_string(&json!({
                "description":"already native v2",
                "formatVersion":2,
                "operationId":"fixture-v2",
                "requirements":[],
                "structuralParent":null,
                "taskId":task_id,
                "title":"Native v2 task"
            }))
            .unwrap(),
            &[],
        );
        let blocked = commit(
            &self.work,
            &serde_json::to_string(&json!({
                "authorization":"fixture",
                "blockedAt":1785196800_u64,
                "claimTokenDigest":"a".repeat(64),
                "formatVersion":2,
                "operationId":"fixture-v2-block",
                "reason":"native v2 state",
                "taskId":task_id,
                "taskOid":task
            }))
            .unwrap(),
            &[&task],
        );
        ok(
            &self.work,
            &[
                "push",
                "origin",
                &format!("{blocked}:refs/heads/tasks/blocked/{task_id}"),
                &format!("{blocked}:refs/heads/tasks/blocked-meta/{task_id}"),
            ],
        );
    }
    fn add_malformed_v2_state(&self) {
        ok(
            &self.work,
            &[
                "push",
                "origin",
                &format!("{}:refs/heads/tasks/frontier/v2-short", self.root),
            ],
        );
    }
    fn add_delegation(
        &self,
        peer_repository: &str,
        peer_issue: u64,
        edge_peer_repository: Option<&str>,
        edge_peer_issue: u64,
        trailers: &[(&str, &str)],
    ) -> (String, String) {
        let mut message = format!(
            "kind: delegated\nrole: system\nintent: delegated-child\n\nissue:\n  repo: owner/repo\n  number: 1\n\ndelegated:\n  repo: {peer_repository}\n  number: {peer_issue}\n"
        );
        for (name, value) in trailers {
            message.push_str(&format!("\n{name}: {value}"));
        }
        let delegation = commit(&self.work, &message, &[&self.root]);
        let reference = format!("refs/heads/tasks/delegated/1/{peer_repository}/{peer_issue}");
        ok(
            &self.work,
            &["push", "origin", &format!("{delegation}:{reference}")],
        );
        if let Some(edge_repository) = edge_peer_repository {
            let edge = json!({"from":format!("task:owner/repo@{}",self.root),"mode":"all","origin":{"repo-id":1,"witness":"delegation fixture"},"relation":"requires","schema":1,"to":format!("issue:{edge_repository}#{edge_peer_issue}")});
            let graph = Self::graph_commit_edge(&self.work, &edge, None);
            ok(
                &self.work,
                &[
                    "push",
                    "--force",
                    "origin",
                    &format!("{graph}:refs/heads/tasks/v1/graph"),
                ],
            );
        }
        (reference, delegation)
    }
    fn migrate_with_terminal_edge(&self, operation: &str, edge: &str) -> Output {
        Self::run_raw(
            &self.work,
            &[
                "migrate-v1",
                "--root",
                &self.root,
                "--operation-id",
                operation,
                "--terminal-external-edge",
                edge,
                "--resolution-authorization",
                "operator-approved terminal legacy prerequisite",
                "--resolution-evidence",
                "https://example.invalid/closed-prerequisite",
            ],
            None,
            Some("migration-token-0001"),
        )
    }
    fn remote(&self, reference: &str) -> Option<String> {
        let line = ok(&self.work, &["ls-remote", "origin", reference]);
        line.split_whitespace().next().map(str::to_owned)
    }
    fn assert_graph_guard(&self, prior: &str) {
        let current = self.remote("refs/heads/tasks/v1/graph").unwrap();
        assert_ne!(current, prior);
        assert_eq!(
            ok(&self.work, &["show", "-s", "--format=%P", &current]),
            prior
        );
        assert_eq!(
            ok(&self.work, &["show", "-s", "--format=%T", &current]),
            ok(&self.work, &["show", "-s", "--format=%T", prior])
        );
    }
}

#[test]
fn census_reports_exact_bounded_roots_without_writes() {
    let f = Fixture::new_legacy_activation(false, false);
    f.remove_other_root();
    f.add_v2_blocked_state();
    let second = commit(&f.work, "Second root", &[]);
    ok(
        &f.work,
        &[
            "push",
            "origin",
            &format!("{second}:refs/heads/tasks/pending/second"),
        ],
    );
    let refs_before = ok(&f.work, &["ls-remote", "--refs", "origin"]);
    let out = f.census();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["formatVersion"], 1);
    assert_eq!(result["roots"].as_array().unwrap().len(), 2);
    let root = result["roots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["root"] == f.root)
        .unwrap();
    assert_eq!(root["pendingRef"], "refs/heads/tasks/pending/root");
    assert_eq!(root["taskCount"], 6);
    assert_eq!(root["terminalExternalEdges"], json!([]));
    assert_eq!(root["v1ActivationOid"], f.activation);
    assert_eq!(root["v1GraphOid"], f.graph);
    assert_eq!(ok(&f.work, &["ls-remote", "--refs", "origin"]), refs_before);
}

#[test]
fn paired_legacy_delegation_becomes_native_waiting_child_and_replays_exactly() {
    let f = Fixture::new(false, true);
    f.remove_other_root();
    let trailers = [
        ("Parent-Repo-Node-Id", "PR_parent"),
        ("Parent-Issue-Node-Id", "PI_1"),
        ("Peer-Repo-Node-Id", "PR_peer"),
        ("Peer-Issue-Node-Id", "PI_2"),
        ("Materialisation-Operation-Id", "legacy-operation"),
        (
            "Declaration-Digest",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    ];
    let (legacy_ref, _) = f.add_delegation("peer/repo", 2, Some("peer/repo"), 2, &trailers);
    let first = f.migrate("delegation-import", None);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let result: Value = serde_json::from_slice(&first.stdout).unwrap();
    let delegation = &result["delegations"][0];
    assert_ne!(delegation["syntheticTaskId"], delegation["targetTaskId"]);
    assert_eq!(delegation["disposition"], "native-delegation");
    assert!(f.remote(&legacy_ref).is_none());
    assert_eq!(
        f.remote(delegation["intentRef"].as_str().unwrap())
            .as_deref(),
        delegation["intentOid"].as_str()
    );
    let intent = body(&f.work, delegation["intentOid"].as_str().unwrap());
    assert_eq!(intent["sourceTaskId"], delegation["syntheticTaskId"]);
    assert_eq!(intent["targetTaskId"], delegation["targetTaskId"]);
    let root_waiting = f
        .remote(&format!(
            "refs/heads/tasks/waiting/{}",
            result["rootTaskId"].as_str().unwrap()
        ))
        .unwrap();
    crate_manifest_valid(
        &f.work,
        &root_waiting,
        result["rootTaskId"].as_str().unwrap(),
    );
    assert!(
        body(&f.work, &root_waiting)["children"]
            .as_array()
            .unwrap()
            .iter()
            .any(|child| child["taskId"] == delegation["syntheticTaskId"])
    );
    let replay = f.migrate("delegation-import", None);
    assert!(replay.status.success());
    assert_eq!(first.stdout, replay.stdout);
}

fn crate_manifest_valid(work: &Path, oid: &str, task_id: &str) {
    let out = Fixture::run_raw(work, &["show", task_id], None, None);
    assert!(
        out.status.success(),
        "manifest {oid}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn malformed_or_unpaired_legacy_delegation_fails_before_writes() {
    for (peer, edge_peer, edge_issue, trailers) in [
        (
            "peer/repo",
            Some("peer/repo"),
            2,
            vec![("Parent-Repo-Node-Id", "partial")],
        ),
        ("peer/repo", Some("peer/repo"), 3, Vec::new()),
        ("peer/repo", None, 2, Vec::new()),
        ("outside/repo", Some("outside/repo"), 2, Vec::new()),
    ] {
        let f = Fixture::new(false, true);
        f.remove_other_root();
        let (legacy_ref, legacy_oid) = f.add_delegation(peer, 2, edge_peer, edge_issue, &trailers);
        let out = f.migrate("invalid-delegation", None);
        assert!(!out.status.success());
        assert_eq!(f.remote(&legacy_ref).as_deref(), Some(legacy_oid.as_str()));
        assert!(
            ok(
                &f.work,
                &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
            )
            .is_empty()
        );
    }

    let blocked = Fixture::new(false, true);
    blocked.remove_other_root();
    ok(
        &blocked.work,
        &[
            "push",
            "origin",
            &format!("{}:refs/heads/tasks/blocked/{}", blocked.root, blocked.root),
        ],
    );
    let (legacy_ref, legacy_oid) =
        blocked.add_delegation("peer/repo", 2, Some("peer/repo"), 2, &[]);
    let out = blocked.migrate("blocked-root-delegation", None);
    assert!(!out.status.success());
    assert_eq!(
        blocked.remote(&legacy_ref).as_deref(),
        Some(legacy_oid.as_str())
    );
}

#[test]
fn census_rejects_pending_graph_and_lifecycle_races_without_import_writes() {
    let malformed_v2 = Fixture::new(false, true);
    malformed_v2.remove_other_root();
    malformed_v2.add_malformed_v2_state();
    let out = malformed_v2.census();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("malformed v2 lifecycle ref suffix"));
    assert!(
        ok(
            &malformed_v2.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );

    let pending = Fixture::new(false, true);
    pending.remove_other_root();
    let added = commit(&pending.work, "Concurrently added root", &[]);
    let out = pending.census_with_update("refs/heads/tasks/pending/added", "", &added);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("changed during readback"));
    assert!(
        ok(
            &pending.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );

    let graph = Fixture::new(false, true);
    graph.remove_other_root();
    let changed_graph = commit(&graph.work, "concurrent graph", &[&graph.graph]);
    let out = graph.census_with_update("refs/heads/tasks/v1/graph", &graph.graph, &changed_graph);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("changed during readback"));
    assert!(
        ok(
            &graph.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );

    let lifecycle = Fixture::new(false, false);
    lifecycle.remove_other_root();
    let reference = "refs/heads/tasks/active/active";
    let old = lifecycle.remote(reference).unwrap();
    let replacement = commit(
        &lifecycle.work,
        "Claim\n\nClaimer: replacement-worker",
        &[&lifecycle.tasks["active"]],
    );
    let out = lifecycle.census_with_update(reference, &old, &replacement);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("changed during readback"));
    assert!(
        ok(
            &lifecycle.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
}

#[test]
fn legacy_roots_allow_one_provenance_parent_but_reject_multiple_parents() {
    let mut modern = Fixture::new(false, true);
    modern.remove_other_root();
    modern.replace_singleton_root(&[env!("TASKDAG_BUILD_COMMIT")]);
    let census = modern.census();
    assert!(
        census.status.success(),
        "{}",
        String::from_utf8_lossy(&census.stderr)
    );
    let migrated = modern.migrate("modern-root", None);
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );

    let mut task_parent = Fixture::new(false, true);
    task_parent.remove_other_root();
    let old_root = task_parent.root.clone();
    task_parent.replace_singleton_root(&[&old_root]);
    let accepted = task_parent.census();
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );

    let mut multi_parent = Fixture::new(false, true);
    multi_parent.remove_other_root();
    let first = commit(&multi_parent.work, "first provenance", &[]);
    let second = commit(&multi_parent.work, "second provenance", &[]);
    multi_parent.replace_singleton_root(&[&first, &second]);
    let rejected = multi_parent.census();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("more than one provenance parent"));
}

#[test]
fn absent_graph_is_frozen_as_empty_and_concurrent_creation_aborts() {
    let migration = Fixture::new(false, true);
    migration.remove_other_root();
    migration.remove_graph();
    let census = migration.census();
    assert!(
        census.status.success(),
        "{}",
        String::from_utf8_lossy(&census.stderr)
    );
    let census: Value = serde_json::from_slice(&census.stdout).unwrap();
    assert!(census["roots"][0]["v1GraphOid"].is_null());
    let migrated = migration.migrate("absent-graph", None);
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    let initialized_graph = migration.remote("refs/heads/tasks/v1/graph").unwrap();
    assert_eq!(
        ok(
            &migration.work,
            &["show", "-s", "--format=%T", &initialized_graph]
        ),
        EMPTY_TREE
    );
    assert!(
        ok(
            &migration.work,
            &["show", "-s", "--format=%P", &initialized_graph]
        )
        .is_empty()
    );
    let result: Value = serde_json::from_slice(&migrated.stdout).unwrap();
    let mapping = migration
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            migration.root
        ))
        .unwrap();
    assert!(body(&migration.work, &mapping)["provenance"]["graph"].is_null());
    assert_eq!(result["terminalExternalEdges"], json!([]));

    let raced = Fixture::new(false, true);
    raced.remove_other_root();
    raced.remove_graph();
    let new_graph = Fixture::graph_commit(&raced.work, &raced.root, None);
    let failed = raced.migrate(
        "absent-graph-race",
        Some(("TASKDAG_TEST_RACE_V1_GRAPH", &new_graph)),
    );
    assert!(!failed.status.success());
    assert!(
        String::from_utf8_lossy(&failed.stderr).contains("conflicting or indeterminate"),
        "{}",
        String::from_utf8_lossy(&failed.stderr)
    );
    assert!(
        ok(
            &raced.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
}

#[test]
fn singleton_pending_root_becomes_open_frontier_with_preserved_context() {
    let f = Fixture::new_legacy_activation(false, true);
    let out = f.migrate("migration-singleton", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["mapping"].as_object().unwrap().len(), 1);
    assert!(result["claimTokens"].as_object().unwrap().is_empty());
    let root_id = result["rootTaskId"].as_str().unwrap();
    assert!(
        f.remote(&format!("refs/heads/tasks/frontier/{root_id}"))
            .is_some()
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/waiting/{root_id}"))
            .is_none()
    );
    assert!(f.remote("refs/heads/tasks/pending/root").is_none());
    let context = Fixture::run_raw(&f.work, &["context", root_id], None, None);
    assert!(context.status.success());
    let context: Value = serde_json::from_slice(&context.stdout).unwrap();
    assert_eq!(context["state"], "frontier");
    assert_eq!(
        context["task"]["description"],
        "Root Legacy project context"
    );
    let claim = Fixture::run_raw(
        &f.work,
        &[
            "claim",
            root_id,
            "--owner",
            "migrated-project-worker",
            "--operation-id",
            "claim-migrated-project",
        ],
        None,
        Some("migrated-project-token"),
    );
    assert!(
        claim.status.success(),
        "{}",
        String::from_utf8_lossy(&claim.stderr)
    );
}

#[test]
fn blocked_root_and_nested_scheduled_leaf_preserve_actionable_state() {
    let blocked = Fixture::new(false, true);
    blocked.remove_other_root();
    let blocked_at = "2026-07-28T00:00:00Z";
    let metadata = commit(
        &blocked.work,
        &format!(
            "Blocked-Meta: Root\n\nTask-Commit: {}\nBlocker-Kind: manual\nReason: Root-level pause\nBlocked-At: {blocked_at}",
            blocked.root
        ),
        &[&blocked.root],
    );
    ok(
        &blocked.work,
        &[
            "push",
            "origin",
            &format!("{}:refs/heads/tasks/blocked/{}", blocked.root, blocked.root),
            &format!("{metadata}:refs/heads/tasks/blocked-meta/{}", blocked.root),
        ],
    );
    let migrated = blocked.migrate("blocked-root", None);
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    let result: Value = serde_json::from_slice(&migrated.stdout).unwrap();
    let root_id = result["rootTaskId"].as_str().unwrap();
    assert_eq!(
        result["blockLeases"][root_id],
        blocked
            .remote(&format!("refs/heads/tasks/blocked/{root_id}"))
            .unwrap()
    );
    let mapping = blocked
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            blocked.root
        ))
        .unwrap();
    assert!(
        ok(&blocked.work, &["show", "-s", "--format=%P", &mapping])
            .split_whitespace()
            .any(|parent| parent == metadata)
    );

    let nested = Fixture::new(false, true);
    nested.remove_other_root();
    let intermediate = commit(&nested.work, "Intermediate", &[&nested.root]);
    let leaf = commit(&nested.work, "Nested scheduled leaf", &[&intermediate]);
    ok(
        &nested.work,
        &[
            "push",
            "origin",
            &format!("{leaf}:refs/heads/tasks/frontier/nested-leaf"),
        ],
    );
    let migrated = nested.migrate("nested-scheduled-leaf", None);
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    let result: Value = serde_json::from_slice(&migrated.stdout).unwrap();
    assert_eq!(result["mapping"].as_object().unwrap().len(), 2);
    assert!(result["mapping"].get(&leaf).is_some());
    assert!(result["mapping"].get(&intermediate).is_none());
}

#[test]
fn migrates_exact_closure_deterministically_and_preserves_unrelated_state() {
    let f = Fixture::new(false, false);
    let journal_before = f.remote("refs/heads/tasks/system/transitions").unwrap();
    let out = f.migrate("migration-main", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let raw = String::from_utf8(out.stdout).unwrap();
    let result: Value = serde_json::from_str(raw.trim()).unwrap();
    assert_eq!(result["mapping"].as_object().unwrap().len(), 6);
    assert_eq!(result["claimTokens"].as_object().unwrap().len(), 2);
    let tokens: Vec<_> = result["claimTokens"]
        .as_object()
        .unwrap()
        .values()
        .collect();
    assert_ne!(tokens[0], tokens[1]);
    assert_eq!(result["reclaimRequired"], true);

    let mapping = result["mapping"].as_object().unwrap();
    let root_id = result["rootTaskId"].as_str().unwrap();
    let root_map = f
        .remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{}", f.root))
        .unwrap();
    let root_oid = body(&f.work, &root_map)["taskOid"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(body(&f.work, &root_oid)["structuralParent"].is_null());
    for command in ["context", "deps"] {
        let out = Fixture::run_raw(&f.work, &[command, root_id], None, None);
        assert!(
            out.status.success(),
            "{command} migrated root: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["taskId"], root_id);
        assert_eq!(value["taskOid"], root_oid);
    }
    for name in ["active", "a", "b", "c", "sibling"] {
        let legacy = &f.tasks[name];
        let map_oid = f
            .remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{legacy}"))
            .unwrap();
        let task_oid = body(&f.work, &map_oid)["taskOid"]
            .as_str()
            .unwrap()
            .to_owned();
        let task = body(&f.work, &task_oid);
        assert_eq!(
            task["structuralParent"],
            json!({"taskId":root_id,"taskOid":root_oid})
        );
        let expected = match name {
            "a" => vec!["active"],
            "b" => vec!["a"],
            "c" => vec!["b"],
            _ => vec![],
        };
        let actual: Vec<_> = task["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["taskId"].as_str().unwrap())
            .collect();
        let wanted: Vec<_> = expected
            .iter()
            .map(|n| mapping[&f.tasks[n]].as_str().unwrap())
            .collect();
        assert_eq!(actual, wanted, "requirements for {name}");
        let parents = ok(&f.work, &["show", "-s", "--format=%P", &task_oid]);
        assert_eq!(parents.split_whitespace().next(), Some(root_oid.as_str()));
    }
    for name in ["active", "sibling"] {
        let id = mapping[&f.tasks[name]].as_str().unwrap();
        let state = f.remote(&format!("refs/heads/tasks/active/{id}")).unwrap();
        let claim = body(&f.work, &state);
        assert_eq!(
            claim["owner"],
            format!(
                "migration:worker-{}",
                if name == "active" { "a" } else { "b" }
            )
        );
        assert_eq!(claim["reclaimRequired"], true);
        assert_eq!(claim["claimToken"], result["claimTokens"][id]);
    }
    for reference in f
        .refs
        .keys()
        .filter(|r| !r.contains("tasks/v1/") && (r.contains("other-") || r.contains("other_")))
    {
        assert_eq!(f.remote(reference), f.refs.get(reference).cloned());
    }
    for reference in f
        .refs
        .keys()
        .filter(|r| !r.contains("other") && !r.contains("tasks/v1/"))
    {
        assert!(
            f.remote(reference).is_none(),
            "closure lifecycle ref survived: {reference}"
        );
    }
    f.assert_graph_guard(&f.graph);
    let replacement = f.remote("refs/heads/tasks/v1/activation").unwrap();
    assert_ne!(replacement, f.activation);
    let guard = ok(&f.work, &["show", "-s", "--format=%B", &replacement]);
    assert!(guard.contains("Task-Dag-Activation-Guard: v1\nActivation-Epoch: 7\n"));
    assert!(guard.contains(&format!("Expected-Authority-Tip: {}", f.activation)));
    let journal_after = f.remote("refs/heads/tasks/system/transitions").unwrap();
    assert_eq!(
        ok(&f.work, &["show", "-s", "--format=%P", &journal_after])
            .split_whitespace()
            .next(),
        Some(journal_before.as_str())
    );
    assert_eq!(
        String::from_utf8(f.migrate("migration-main", None).stdout).unwrap(),
        raw
    );
}

#[test]
fn ambiguous_success_replays_identical_result() {
    let f = Fixture::new(false, false);
    let failed = f.migrate(
        "migration-ambiguous",
        Some(("TASKDAG_TEST_FAIL_AFTER_PUSH", "1")),
    );
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("failure after push"));
    let first_receipt = f
        .remote("refs/heads/tasks/v2/imports/v1/operations/*")
        .unwrap();
    let replay = f.migrate("migration-ambiguous", None);
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    assert_eq!(
        f.remote("refs/heads/tasks/v2/imports/v1/operations/*")
            .unwrap(),
        first_receipt
    );
    let again = f.migrate("migration-ambiguous", None);
    assert_eq!(again.stdout, replay.stdout);
}

#[test]
fn touching_graph_fails_then_blocked_overlay_migrates() {
    let f = Fixture::new(true, false);
    let touching = Fixture::graph_commit(&f.work, &f.root, Some(&f.graph));
    ok(
        &f.work,
        &[
            "push",
            &format!("--force-with-lease=refs/heads/tasks/v1/graph:{}", f.graph),
            "origin",
            &format!("{touching}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = f.migrate("touching-graph", None);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("resolutions must exactly match graph edges")
    );
    ok(
        &f.work,
        &[
            "push",
            &format!("--force-with-lease=refs/heads/tasks/v1/graph:{touching}"),
            "origin",
            &format!("{}:refs/heads/tasks/v1/graph", f.graph),
        ],
    );
    let out = f.migrate("blocked-closure", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let id = result["mapping"][&f.tasks["c"]].as_str().unwrap();
    let lease = result["blockLeases"][id].as_str().unwrap();
    assert_eq!(
        f.remote(&format!("refs/heads/tasks/blocked/{id}"))
            .as_deref(),
        Some(lease)
    );
    let blocked = body(&f.work, lease);
    assert_eq!(blocked["reason"], "Waiting for reviewed input");
    assert_eq!(blocked["blockedAt"], 1_785_196_800_u64);
    let blocked_parents = ok(&f.work, &["show", "-s", "--format=%P", lease]);
    assert_eq!(blocked_parents.split_whitespace().count(), 2);
    let mapping = f
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            f.tasks["c"]
        ))
        .unwrap();
    let mapping_value = body(&f.work, &mapping);
    assert_eq!(
        mapping_value["provenance"]["legacyLifecycleRefs"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let metadata_oid = f.refs[&format!("refs/heads/tasks/blocked-meta/{}", f.tasks["c"])].clone();
    assert!(
        ok(&f.work, &["show", "-s", "--format=%P", &mapping])
            .split_whitespace()
            .any(|parent| parent == metadata_oid)
    );
    assert!(
        f.remote(&format!(
            "refs/heads/tasks/frontier/blocked-{}",
            f.tasks["c"]
        ))
        .is_none()
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/blocked/{}", f.tasks["c"]))
            .is_none()
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/blocked-meta/{}", f.tasks["c"]))
            .is_none()
    );
    let unblock = Fixture::run_raw(
        &f.work,
        &[
            "unblock",
            id,
            "--block-lease",
            lease,
            "--authorization",
            "reviewed migrated block",
            "--operation-id",
            "unblock-migrated-block",
        ],
        None,
        None,
    );
    assert!(!unblock.status.success());
    assert_eq!(
        f.remote(&format!("refs/heads/tasks/blocked/{id}"))
            .as_deref(),
        Some(lease)
    );
}

#[test]
fn local_graph_requirement_is_immutable_and_structural_root_cycle_is_rejected() {
    let f = Fixture::new(false, false);
    let edge = json!({
        "from":format!("task:owner/repo@{}", f.tasks["b"]),
        "mode":"all",
        "origin":{"repo-id":1,"witness":"local-requirement"},
        "relation":"requires",
        "schema":1,
        "to":format!("task:owner/repo@{}", f.tasks["sibling"])
    });
    let graph = Fixture::graph_commit_edge(&f.work, &edge, Some(&f.graph));
    ok(
        &f.work,
        &[
            "push",
            &format!("--force-with-lease=refs/heads/tasks/v1/graph:{}", f.graph),
            "origin",
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = f.migrate("local-graph-requirement", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let b_mapping = f
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            f.tasks["b"]
        ))
        .unwrap();
    let b_task = body(&f.work, &b_mapping)["taskOid"]
        .as_str()
        .unwrap()
        .to_owned();
    let requirement_ids: Vec<_> = body(&f.work, &b_task)["requirements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|requirement| requirement["taskId"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        requirement_ids.contains(
            &result["mapping"][&f.tasks["a"]]
                .as_str()
                .unwrap()
                .to_owned()
        )
    );
    assert!(
        requirement_ids.contains(
            &result["mapping"][&f.tasks["sibling"]]
                .as_str()
                .unwrap()
                .to_owned()
        )
    );

    let cross_root = Fixture::new(false, false);
    ok(
        &cross_root.work,
        &[
            "push",
            "origin",
            &format!(":refs/heads/tasks/blocked/other-blocked"),
            &format!(":refs/heads/tasks/blocked-meta/other-blocked"),
        ],
    );
    let edge = json!({
        "from":format!("task:owner/repo@{}", cross_root.tasks["b"]),
        "mode":"all",
        "origin":{"repo-id":1,"witness":"cross-root-graph-requirement"},
        "relation":"requires",
        "schema":1,
        "to":format!("task:owner/repo@{}", cross_root.tasks["other_frontier"])
    });
    let graph = Fixture::graph_commit_edge(&cross_root.work, &edge, Some(&cross_root.graph));
    ok(
        &cross_root.work,
        &[
            "push",
            &format!(
                "--force-with-lease=refs/heads/tasks/v1/graph:{}",
                cross_root.graph
            ),
            "origin",
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = cross_root.migrate("cross-root-graph-requirement", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let b_mapping = cross_root
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            cross_root.tasks["b"]
        ))
        .unwrap();
    let b_task = body(&cross_root.work, &b_mapping)["taskOid"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        body(&cross_root.work, &b_task)["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|requirement| requirement["taskId"]
                == result["mapping"][&cross_root.tasks["other_frontier"]])
    );

    let rejected = Fixture::new(false, false);
    let edge = json!({
        "from":format!("task:owner/repo@{}", rejected.tasks["c"]),
        "mode":"all",
        "origin":{"repo-id":1,"witness":"cycle"},
        "relation":"requires",
        "schema":1,
        "to":format!("task:owner/repo@{}", rejected.root)
    });
    let graph = Fixture::graph_commit_edge(&rejected.work, &edge, Some(&rejected.graph));
    ok(
        &rejected.work,
        &[
            "push",
            &format!(
                "--force-with-lease=refs/heads/tasks/v1/graph:{}",
                rejected.graph
            ),
            "origin",
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = rejected.migrate("structural-root-cycle", None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("structural root"));
    assert!(
        ok(
            &rejected.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
    assert_eq!(
        rejected.remote("refs/heads/tasks/frontier/c").as_deref(),
        rejected.refs["refs/heads/tasks/frontier/c"].as_str().into()
    );
}

#[test]
fn unsupported_structural_census_and_metadata_fail_before_writes() {
    let nested = Fixture::new(false, true);
    let pending_child = commit(&nested.work, "Nested pending", &[&nested.root]);
    ok(
        &nested.work,
        &[
            "push",
            "origin",
            &format!("{pending_child}:refs/heads/tasks/pending/nested"),
        ],
    );
    let out = nested.migrate("nested-pending", None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("nested legacy pending root"));
    assert!(
        ok(
            &nested.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );

    let cross = Fixture::new(false, false);
    cross.remove_graph();
    ok(
        &cross.work,
        &[
            "push",
            "origin",
            &format!(":refs/heads/tasks/blocked/other-blocked"),
            &format!(":refs/heads/tasks/blocked-meta/other-blocked"),
        ],
    );
    let crossing = commit(
        &cross.work,
        "Cross-boundary child",
        &[&cross.root, &cross.tasks["other_frontier"]],
    );
    let crossing_claim = commit(
        &cross.work,
        "Claim\n\nClaimer: cross-boundary-worker",
        &[&crossing],
    );
    ok(
        &cross.work,
        &[
            "push",
            "origin",
            &format!("{crossing_claim}:refs/heads/tasks/active/crossing"),
        ],
    );
    let out = cross.migrate("cross-boundary-parent", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let crossing_id = result["mapping"][&crossing].as_str().unwrap();
    let crossing_oid = cross
        .remote(&format!("refs/heads/tasks/blocked/{crossing_id}"))
        .unwrap();
    let crossing_task = body(&cross.work, &crossing_oid)["taskOid"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        body(&cross.work, &crossing_task)["requirements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let expected_target_oid = result["plannedTaskOids"][&cross.tasks["other_frontier"]]
        .as_str()
        .unwrap()
        .to_owned();
    let claim = Fixture::run_raw(
        &cross.work,
        &[
            "claim",
            crossing_id,
            "--owner",
            "not-ready-worker",
            "--operation-id",
            "claim-before-cross-root-target",
        ],
        None,
        None,
    );
    assert!(!claim.status.success());
    let target = cross.migrate_root(
        &cross.tasks["other_root"],
        "cross-boundary-target-different-operation",
        None,
    );
    assert!(
        target.status.success(),
        "{}",
        String::from_utf8_lossy(&target.stderr)
    );
    let target: Value = serde_json::from_slice(&target.stdout).unwrap();
    assert_eq!(
        target["plannedTaskOids"][&cross.tasks["other_frontier"]],
        expected_target_oid
    );

    let completed = Fixture::new(false, false);
    let crossing = commit(
        &completed.work,
        "Completed cross-boundary requirement child",
        &[&completed.root, &completed.tasks["other_frontier"]],
    );
    ok(
        &completed.work,
        &[
            "push",
            "origin",
            &format!("{crossing}:refs/heads/tasks/frontier/completed-crossing"),
        ],
    );
    let master = completed.remote("refs/heads/master").unwrap();
    let witness = commit(
        &completed.work,
        "Complete external prerequisite",
        &[&master, &completed.tasks["other_frontier"]],
    );
    ok(
        &completed.work,
        &[
            "push",
            &format!("--force-with-lease=refs/heads/master:{master}"),
            "origin",
            &format!("{witness}:refs/heads/master"),
        ],
    );
    let out = completed.migrate("completed-cross-boundary-parent", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let mapping = completed
        .remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{crossing}"))
        .unwrap();
    assert_eq!(
        body(&completed.work, &mapping)["provenance"]["completedParentRequirements"],
        json!([{"completionWitnessOid":witness,"taskOid":completed.tasks["other_frontier"]}])
    );

    let malformed = Fixture::new(true, false);
    let task = &malformed.tasks["c"];
    let metadata_ref = format!("refs/heads/tasks/blocked-meta/{task}");
    let prior = malformed.remote(&metadata_ref).unwrap();
    let replacement = commit(
        &malformed.work,
        "Blocked-Meta: Frontier C\n\nTask-Commit: wrong\nBlocker-Kind: manual\nBlocked-At: 2026-07-28T00:00:00Z",
        &[task],
    );
    ok(
        &malformed.work,
        &[
            "push",
            &format!("--force-with-lease={metadata_ref}:{prior}"),
            "origin",
            &format!("{replacement}:{metadata_ref}"),
        ],
    );
    let out = malformed.migrate("malformed-blocked-metadata", None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("wrong Task"));
    assert!(
        ok(
            &malformed.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
}

#[test]
fn exact_terminal_external_edge_is_preserved_as_immutable_provenance() {
    let f = Fixture::new(false, true);
    f.remove_other_root();
    let touching = Fixture::graph_commit(&f.work, &f.root, Some(&f.graph));
    ok(
        &f.work,
        &[
            "push",
            &format!("--force-with-lease=refs/heads/tasks/v1/graph:{}", f.graph),
            "origin",
            &format!("{touching}:refs/heads/tasks/v1/graph"),
        ],
    );
    let edge = ok(
        &f.work,
        &["ls-tree", "-r", "--format=%(objectname)", &touching],
    );
    let census = f.census();
    assert!(
        census.status.success(),
        "{}",
        String::from_utf8_lossy(&census.stderr)
    );
    let census: Value = serde_json::from_slice(&census.stdout).unwrap();
    let root = census["roots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["root"] == f.root)
        .unwrap();
    assert_eq!(root["terminalExternalEdges"], json!([edge]));
    let out = f.migrate_with_terminal_edge("terminal-edge", &edge);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["terminalExternalEdges"], json!([edge]));
    let mapping = f
        .remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{}", f.root))
        .unwrap();
    assert_eq!(
        body(&f.work, &mapping)["provenance"]["terminalExternalEdges"],
        json!({
            "authorization":"operator-approved terminal legacy prerequisite",
            "disposition":"terminal",
            "edgeBlobOids":[edge],
            "evidence":["https://example.invalid/closed-prerequisite"]
        })
    );
    assert!(
        ok(&f.work, &["show", "-s", "--format=%P", &mapping])
            .split_whitespace()
            .any(|parent| parent == touching),
        "root import mapping must retain the frozen graph and its exact edge blobs"
    );
    f.assert_graph_guard(&touching);
}

#[test]
fn activation_race_rejects_all_migration_updates() {
    let f = Fixture::new(false, false);
    let raced = commit(&f.work, "concurrent activation", &[&f.activation]);
    let out = f.migrate(
        "activation-race",
        Some(("TASKDAG_TEST_RACE_V1_ACTIVATION", &raced)),
    );
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("conflicting or indeterminate"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        f.remote("refs/heads/tasks/v1/activation").as_deref(),
        Some(raced.as_str())
    );
    assert!(
        ok(
            &f.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
    for (reference, oid) in &f.refs {
        if reference == "refs/heads/tasks/v1/activation" {
            continue;
        }
        assert_eq!(
            f.remote(reference).as_deref(),
            Some(oid.as_str()),
            "changed {reference}"
        );
    }
}

#[test]
fn graph_race_rejects_all_migration_updates() {
    let f = Fixture::new(false, false);
    let raced = commit(&f.work, "concurrent graph", &[]);
    let out = f.migrate("graph-race", Some(("TASKDAG_TEST_RACE_V1_GRAPH", &raced)));
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("conflicting or indeterminate"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        f.remote("refs/heads/tasks/v1/graph").as_deref(),
        Some(raced.as_str())
    );
    assert_eq!(
        f.remote("refs/heads/tasks/v1/activation").as_deref(),
        Some(f.activation.as_str())
    );
    assert!(
        ok(
            &f.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
    for (reference, oid) in &f.refs {
        if !reference.contains("tasks/v1/") {
            assert_eq!(f.remote(reference).as_deref(), Some(oid.as_str()));
        }
    }
}
