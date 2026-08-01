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
        .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
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
fn non_task_commit(cwd: &Path, message: &str, parent: &str) -> String {
    let blob = ok(cwd, &["hash-object", "-w", "--stdin"]);
    let tree_input = format!("100644 blob {blob}\tdata\n");
    let mut tree = Command::new("git")
        .current_dir(cwd)
        .args(["mktree"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    tree.stdin
        .take()
        .unwrap()
        .write_all(tree_input.as_bytes())
        .unwrap();
    let tree = String::from_utf8(tree.wait_with_output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    ok(cwd, &["commit-tree", &tree, "-p", parent, "-m", message])
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
        let hooks = work.join(".githooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::copy(source.join(".githooks/pre-push"), hooks.join("pre-push")).unwrap();
        let mut permissions = fs::metadata(hooks.join("pre-push")).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
        }
        fs::set_permissions(hooks.join("pre-push"), permissions).unwrap();
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
            .env("TASK_DAG_BIN", env!("CARGO_BIN_EXE_task-dag"))
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
    fn add_legacy_close(&self, declaration_ref: &str, declaration: &str) -> (String, String) {
        let close_ref = declaration_ref.replacen(
            "refs/heads/tasks/delegated/",
            "refs/heads/tasks/delegated-close/v1/",
            1,
        );
        let close = commit(
            &self.work,
            &format!(
                "Record delegated close\n\nTask-Dag-Delegated-Close: v1\nParent-Repo: owner/repo\nParent-Issue: #1\nPeer-Repo: peer/repo\nPeer-Issue: #2\nLegacy-Delegation: {declaration}\nPeer-Tip: {}\nPeer-Close: {}\nPeer-Epic: {}",
                "1".repeat(40),
                "2".repeat(40),
                "3".repeat(40)
            ),
            &[declaration],
        );
        ok(
            &self.work,
            &["push", "origin", &format!("{close}:{close_ref}")],
        );
        (close_ref, close)
    }
    fn add_completed_issue(&self, issue: u64, title: &str) -> (String, String) {
        let task = commit(&self.work, title, &[]);
        let master = self.remote("refs/heads/master").unwrap();
        let completion = commit(
            &self.work,
            &format!(
                "Complete {title}\n\nIssue: #{issue}\nStatus: completed\n\nRelated: migration fixture"
            ),
            &[&master, &task],
        );
        ok(
            &self.work,
            &["push", "origin", &format!("{completion}:refs/heads/master")],
        );
        (task, completion)
    }
    fn add_issue_close(&self, issue: u64, root: &str) -> String {
        ok(
            &self.work,
            &[
                "push",
                "origin",
                &format!("{root}:refs/heads/gh/issues/{issue}"),
            ],
        );
        let master = self.remote("refs/heads/master").unwrap();
        let close = commit(
            &self.work,
            &format!("Close epic\n\nCloses-Epic: #{issue}"),
            &[&master, root],
        );
        ok(
            &self.work,
            &["push", "origin", &format!("{close}:refs/heads/master")],
        );
        close
    }
    fn add_closed_issue(&self, issue: u64, title: &str) -> (String, String) {
        let root = commit(&self.work, title, &[]);
        let close = self.add_issue_close(issue, &root);
        (root, close)
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

#[test]
fn unpaired_declaration_imports_waiting_and_exact_close_imports_done() {
    let waiting = Fixture::new(false, true);
    waiting.remove_other_root();
    let (declaration_ref, _) = waiting.add_delegation("peer/repo", 2, None, 2, &[]);
    let out = waiting.migrate("no-edge-delegation", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(value["delegations"][0]["pairedEdgeBlobOid"].is_null());
    assert!(waiting.remote(&declaration_ref).is_none());

    let completed = Fixture::new(false, true);
    completed.remove_other_root();
    let (declaration_ref, declaration) = completed.add_delegation("peer/repo", 2, None, 2, &[]);
    let (close_ref, close) = completed.add_legacy_close(&declaration_ref, &declaration);
    let out = completed.migrate("closed-delegation", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    let imported = &value["delegations"][0];
    assert_eq!(imported["disposition"], "completed-delegation");
    assert_eq!(imported["legacyCloseOid"], close);
    assert!(imported["doneOid"].as_str().is_some());
    assert!(imported["doneRef"].as_str().is_some());
    assert!(imported["intentOid"].is_null());
    assert!(completed.remote(&declaration_ref).is_none());
    assert!(completed.remote(&close_ref).is_none());
    assert!(
        completed
            .remote(&format!(
                "refs/heads/tasks/done/{}",
                imported["syntheticTaskId"].as_str().unwrap()
            ))
            .is_some()
    );
    assert!(
        completed
            .remote(&format!(
                "refs/heads/tasks/reconcile/{}",
                value["rootTaskId"].as_str().unwrap()
            ))
            .is_some()
    );
    let root_waiting = completed
        .remote(&format!(
            "refs/heads/tasks/waiting/{}",
            value["rootTaskId"].as_str().unwrap()
        ))
        .unwrap();
    let children = body(&completed.work, &root_waiting)["children"]
        .as_array()
        .unwrap()
        .clone();
    let historical = children
        .iter()
        .find(|child| child["taskId"] == imported["syntheticTaskId"])
        .unwrap();
    assert!(historical["ref"].as_str().unwrap().contains("/active/"));
    assert_eq!(historical["owner"], "migration:v1-delegation");
    assert!(historical["claimToken"].as_str().is_some());
    assert!(
        completed
            .remote(historical["ref"].as_str().unwrap())
            .is_none()
    );

    // A semantically identical root Task with different Git identity must not
    // be accepted as the structural parent of historical migration evidence.
    let done_ref = imported["doneRef"].as_str().unwrap();
    let done_oid = imported["doneOid"].as_str().unwrap();
    let done_value = body(&completed.work, done_oid);
    let parents = ok(&completed.work, &["show", "-s", "--format=%P", done_oid]);
    let parents: Vec<_> = parents.split_whitespace().collect();
    let task_oid = done_value["taskOid"].as_str().unwrap();
    let task_value = body(&completed.work, task_oid);
    let root_task_oid = task_value["structuralParent"]["taskOid"].as_str().unwrap();
    let forged_root = commit(
        &completed.work,
        &serde_json::to_string(&body(&completed.work, root_task_oid)).unwrap(),
        &[],
    );
    assert_ne!(forged_root, root_task_oid);
    let mut forged_task_value = task_value;
    forged_task_value["structuralParent"]["taskOid"] = json!(forged_root);
    let forged_task = commit(
        &completed.work,
        &serde_json::to_string(&forged_task_value).unwrap(),
        &[&forged_root],
    );
    let mut forged_active_value = body(&completed.work, parents[0]);
    forged_active_value["taskOid"] = json!(forged_task);
    let forged_active = commit(
        &completed.work,
        &serde_json::to_string(&forged_active_value).unwrap(),
        &[&forged_task],
    );
    let mut forged_done_value = done_value;
    forged_done_value["taskOid"] = json!(forged_task);
    let forged_done = commit(
        &completed.work,
        &serde_json::to_string(&forged_done_value).unwrap(),
        &[&forged_active, &forged_task, parents[2]],
    );
    ok(
        &completed.work,
        &[
            "push",
            "--force",
            "origin",
            &format!("{forged_done}:{done_ref}"),
        ],
    );
    let rejected = Fixture::run_raw(
        &completed.work,
        &["show", imported["syntheticTaskId"].as_str().unwrap()],
        None,
        None,
    );
    assert!(!rejected.status.success());
    let error = String::from_utf8_lossy(&rejected.stderr);
    assert!(
        error.contains("migration done historical active identity is malformed"),
        "{error}"
    );
}

#[test]
fn same_repository_delegation_becomes_a_conjunctive_local_child() {
    let f = Fixture::new(false, true);
    let target_root = commit(&f.work, "Same-repository target", &[]);
    ok(
        &f.work,
        &[
            "push",
            "origin",
            &format!("{target_root}:refs/heads/tasks/pending/2"),
        ],
    );
    let (declaration_ref, _) = f.add_delegation("owner/repo", 2, None, 2, &[]);
    let out = f.migrate("same-repository-delegation", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let delegation = &result["delegations"][0];
    assert_eq!(delegation["disposition"], "open-local-requirement");
    assert_eq!(
        delegation["normalization"],
        "same-repository delegation->requires/all"
    );
    assert!(f.remote(&declaration_ref).is_none());
    assert!(delegation["intentOid"].is_null());
    let synthetic = body(&f.work, delegation["syntheticTaskOid"].as_str().unwrap());
    assert_eq!(synthetic["requirements"].as_array().unwrap().len(), 1);
    assert_eq!(
        synthetic["requirements"][0]["taskId"],
        delegation["targetTaskId"]
    );
    let root_waiting = f
        .remote(&format!(
            "refs/heads/tasks/waiting/{}",
            result["rootTaskId"].as_str().unwrap()
        ))
        .unwrap();
    assert!(
        body(&f.work, &root_waiting)["children"]
            .as_array()
            .unwrap()
            .iter()
            .any(|child| child["taskId"] == delegation["syntheticTaskId"])
    );
    let claim = Fixture::run_raw(
        &f.work,
        &[
            "claim",
            delegation["syntheticTaskId"].as_str().unwrap(),
            "--owner",
            "premature-worker",
            "--operation-id",
            "premature-local-dependency-claim",
        ],
        None,
        Some("premature-local-dependency-token"),
    );
    assert!(!claim.status.success());
    let error = String::from_utf8_lossy(&claim.stderr);
    assert!(error.contains("is not done"), "{error}");
}

#[test]
fn completed_same_repository_delegation_preserves_exact_witness() {
    let f = Fixture::new(false, true);
    f.remove_other_root();
    let (target, witness) = f.add_closed_issue(2, "Completed same-repository target");
    let (declaration_ref, _) = f.add_delegation("owner/repo", 2, None, 2, &[]);
    let out = f.migrate("completed-same-repository-delegation", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let delegation = &result["delegations"][0];
    assert_eq!(delegation["disposition"], "completed-local-requirement");
    assert_eq!(delegation["targetLegacyTaskOid"], target);
    assert_eq!(delegation["targetCompletionWitnessOid"], witness);
    assert!(delegation["syntheticTaskId"].is_null());
    assert!(f.remote(&declaration_ref).is_none());
}

#[test]
fn missing_or_ambiguous_same_repository_target_fails_before_writes() {
    let missing = Fixture::new(false, true);
    missing.remove_other_root();
    let (missing_ref, missing_oid) = missing.add_delegation("owner/repo", 2, None, 2, &[]);
    let out = missing.migrate("missing-local-target", None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no authoritative root"));
    assert_eq!(
        missing.remote(&missing_ref).as_deref(),
        Some(missing_oid.as_str())
    );

    let child_only = Fixture::new(false, true);
    child_only.remove_other_root();
    let historical_root = commit(&child_only.work, "Historical issue root", &[]);
    ok(
        &child_only.work,
        &[
            "push",
            "origin",
            &format!("{historical_root}:refs/heads/gh/issues/2"),
        ],
    );
    child_only.add_completed_issue(2, "Completed child, not issue root");
    let (child_only_ref, _) = child_only.add_delegation("owner/repo", 2, None, 2, &[]);
    let out = child_only.migrate("child-completion-is-not-issue-close", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let delegation = &result["delegations"][0];
    assert_eq!(delegation["disposition"], "unresolved-local-requirement");
    assert_eq!(delegation["targetHistoricalRootOid"], historical_root);
    assert!(child_only.remote(&child_only_ref).is_none());
    let synthetic = body(
        &child_only.work,
        delegation["syntheticTaskOid"].as_str().unwrap(),
    );
    assert!(synthetic["requirements"].as_array().unwrap().is_empty());

    let ambiguous = Fixture::new(false, true);
    ambiguous.remove_other_root();
    let target = commit(&ambiguous.work, "Ambiguously closed target", &[]);
    ambiguous.add_issue_close(2, &target);
    ambiguous.add_issue_close(2, &target);
    let (ambiguous_ref, ambiguous_oid) = ambiguous.add_delegation("owner/repo", 2, None, 2, &[]);
    let out = ambiguous.migrate("ambiguous-local-target", None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("completion is ambiguous"));
    assert_eq!(
        ambiguous.remote(&ambiguous_ref).as_deref(),
        Some(ambiguous_oid.as_str())
    );
    assert!(
        ok(
            &ambiguous.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
}

#[test]
fn expired_root_claim_is_preserved_as_provenance_and_retired() {
    let f = Fixture::new(false, true);
    let digest = "a".repeat(64);
    let pending_ref = format!("refs/heads/tasks/pending/epic-v1/{digest}");
    let claim_ref = format!("refs/heads/tasks/root-active/epic-v1/{digest}");
    ok(
        &f.work,
        &[
            "push",
            "origin",
            "--delete",
            "refs/heads/tasks/pending/root",
        ],
    );
    ok(
        &f.work,
        &["push", "origin", &format!("{}:{pending_ref}", f.root)],
    );
    let claim = commit(
        &f.work,
        &format!(
            "Claim: Root\n\nClaim-Kind: root\nEpic-ID: epic-v1:{digest}\nRoot-Ref: {pending_ref}\nClaim-ID: fixture-claim\nTask-Commit: {}\nClaimer: old-worker\nClaimer-Host: test\nClaimer-PID: 1\nClaimed-At: 2026-07-27T00:00:00Z\nTTL-Hours: 12",
            f.root
        ),
        &[&f.root],
    );
    ok(
        &f.work,
        &["push", "origin", &format!("{claim}:{claim_ref}")],
    );
    let out = f.migrate("expired-root-claim", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(f.remote(&claim_ref).is_none());
    let mapping = f
        .remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{}", f.root))
        .unwrap();
    assert!(
        body(&f.work, &mapping)["provenance"]["legacyLifecycleRefs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["ref"] == claim_ref && entry["oid"] == claim)
    );
}

#[test]
fn invalid_root_claims_fail_before_writes() {
    for (claim_ref, parent, task, claimed_at, expected) in [
        (
            "refs/heads/tasks/root-active/1",
            "root",
            "root",
            "2026-07-29T00:00:00Z",
            "still live",
        ),
        (
            "refs/heads/tasks/root-active/2",
            "root",
            "root",
            "2026-07-27T00:00:00Z",
            "identity or object shape is malformed",
        ),
        (
            "refs/heads/tasks/root-active/1",
            "other_root",
            "root",
            "2026-07-27T00:00:00Z",
            "identity or object shape is malformed",
        ),
        (
            "refs/heads/tasks/root-active/1",
            "root",
            "other_root",
            "2026-07-27T00:00:00Z",
            "does not bind its pending root",
        ),
    ] {
        let f = Fixture::new(false, true);
        ok(
            &f.work,
            &[
                "push",
                "origin",
                "--delete",
                "refs/heads/tasks/pending/root",
            ],
        );
        ok(
            &f.work,
            &[
                "push",
                "origin",
                &format!("{}:refs/heads/tasks/pending/1", f.root),
            ],
        );
        let parent = &f.tasks[parent];
        let task = &f.tasks[task];
        let claim = commit(
            &f.work,
            &format!(
                "Claim: Root\n\nClaim-Kind: root\nIssue: #1\nClaim-ID: fixture-claim\nTask-Commit: {task}\nClaimer: old-worker\nClaimer-Host: test\nClaimer-PID: 1\nClaimed-At: {claimed_at}\nTTL-Hours: 12"
            ),
            &[parent],
        );
        ok(
            &f.work,
            &["push", "origin", &format!("{claim}:{claim_ref}")],
        );
        let out = f.migrate("invalid-root-claim", None);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains(expected));
        assert_eq!(f.remote(claim_ref).as_deref(), Some(claim.as_str()));
        assert!(
            ok(
                &f.work,
                &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
            )
            .is_empty()
        );
    }
}

#[test]
fn root_claim_expiry_honors_v1_grace_and_same_host_pid() {
    for (index, (claimed_at, expired)) in [
        ("2026-07-27T23:00:00Z", false),
        ("2026-07-27T22:55:00Z", false),
        ("2026-07-27T22:54:59Z", true),
    ]
    .into_iter()
    .enumerate()
    {
        let f = Fixture::new(false, true);
        ok(
            &f.work,
            &[
                "push",
                "origin",
                "--delete",
                "refs/heads/tasks/pending/root",
            ],
        );
        ok(
            &f.work,
            &[
                "push",
                "origin",
                &format!("{}:refs/heads/tasks/pending/1", f.root),
            ],
        );
        let claim = commit(
            &f.work,
            &format!(
                "Claim: Root\n\nClaim-Kind: root\nIssue: #1\nClaim-ID: boundary-claim\nTask-Commit: {}\nClaimer: old-worker\nClaimer-Host: remote-host\nClaimed-At: {claimed_at}\nTTL-Hours: 1",
                f.root
            ),
            &[&f.root],
        );
        let claim_ref = "refs/heads/tasks/root-active/1";
        ok(
            &f.work,
            &["push", "origin", &format!("{claim}:{claim_ref}")],
        );
        let out = f.migrate(&format!("root-claim-boundary-{index}"), None);
        assert_eq!(
            out.status.success(),
            expired,
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(f.remote(claim_ref).is_none(), expired);
    }

    let f = Fixture::new(false, true);
    ok(
        &f.work,
        &[
            "push",
            "origin",
            "--delete",
            "refs/heads/tasks/pending/root",
        ],
    );
    ok(
        &f.work,
        &[
            "push",
            "origin",
            &format!("{}:refs/heads/tasks/pending/1", f.root),
        ],
    );
    let claim = commit(
        &f.work,
        &format!(
            "Claim: Root\n\nClaim-Kind: root\nIssue: #1\nClaim-ID: live-pid-claim\nTask-Commit: {}\nClaimer: live-worker\nClaimer-Host: migration-test-host\nClaimer-PID: {}\nClaimed-At: 2026-07-20T00:00:00Z\nTTL-Hours: 1",
            f.root,
            std::process::id()
        ),
        &[&f.root],
    );
    let claim_ref = "refs/heads/tasks/root-active/1";
    ok(
        &f.work,
        &["push", "origin", &format!("{claim}:{claim_ref}")],
    );
    let out = f.migrate(
        "same-host-live-root-claim",
        Some(("TASK_DAG_CLAIMER_HOST", "migration-test-host")),
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("same-host PID evidence"));
    assert_eq!(f.remote(claim_ref).as_deref(), Some(claim.as_str()));
}

#[test]
fn noncanonical_root_claim_fields_fail_before_writes() {
    let uppercase = "A".repeat(64);
    for (suffix, identity, pid, ttl, expected) in [
        (
            "1".to_owned(),
            "Issue: #1".to_owned(),
            "Claimer-PID:  123".to_owned(),
            "12",
            "Claimer-PID field is malformed",
        ),
        (
            "1".to_owned(),
            "Issue: #1".to_owned(),
            "Claimer-PID: 1".to_owned(),
            "1e-9",
            "TTL is malformed",
        ),
        (
            format!("epic-v1/{uppercase}"),
            format!(
                "Epic-ID: epic-v1:{uppercase}\nRoot-Ref: refs/heads/tasks/pending/epic-v1/{uppercase}"
            ),
            "Claimer-PID: 1".to_owned(),
            "12",
            "path dialect is malformed",
        ),
    ] {
        let f = Fixture::new(false, true);
        ok(
            &f.work,
            &[
                "push",
                "origin",
                "--delete",
                "refs/heads/tasks/pending/root",
            ],
        );
        let pending_ref = format!("refs/heads/tasks/pending/{suffix}");
        let claim_ref = format!("refs/heads/tasks/root-active/{suffix}");
        ok(
            &f.work,
            &["push", "origin", &format!("{}:{pending_ref}", f.root)],
        );
        let claim = commit(
            &f.work,
            &format!(
                "Claim: Root\n\nClaim-Kind: root\n{identity}\nClaim-ID: malformed-claim\nTask-Commit: {}\nClaimer: old-worker\nClaimer-Host: remote-host\n{pid}\nClaimed-At: 2026-07-20T00:00:00Z\nTTL-Hours: {ttl}",
                f.root
            ),
            &[&f.root],
        );
        ok(
            &f.work,
            &["push", "origin", &format!("{claim}:{claim_ref}")],
        );
        let out = f.migrate("noncanonical-root-claim", None);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains(expected));
        assert_eq!(f.remote(&claim_ref).as_deref(), Some(claim.as_str()));
    }
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
fn recursive_approximation_preserves_nested_hierarchy_and_required_leaf() {
    let f = Fixture::new(false, true);
    f.remove_other_root();
    let schema = commit(&f.work, "Lifecycle-less schema parent", &[&f.root]);
    let implementation = commit(&f.work, "Scheduled implementation", &[&schema]);
    let gated = commit(&f.work, "Lifecycle-less gated leaf", &[&f.root]);
    let rollout = commit(&f.work, "Scheduled rollout", &[&f.root, &gated]);
    let edge = json!({
        "from":format!("task:owner/repo@{gated}"),
        "mode":"all",
        "origin":{"repo-id":1,"witness":"automation-79-schema-gate"},
        "relation":"requires",
        "schema":1,
        "to":format!("task:owner/repo@{schema}")
    });
    let graph = Fixture::graph_commit_edge(&f.work, &edge, Some(&f.graph));
    ok(
        &f.work,
        &[
            "push",
            "origin",
            &format!("{implementation}:refs/heads/tasks/frontier/recursive-implementation"),
            &format!("{rollout}:refs/heads/tasks/frontier/recursive-rollout"),
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = Fixture::run_raw(
        &f.work,
        &[
            "migrate-v1",
            "--root",
            &f.root,
            "--operation-id",
            "recursive-nested",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["mapping"].as_object().unwrap().len(), 5);
    assert_eq!(
        result["recursiveApproximationPolicy"],
        "legacy-v1-recursive-approximation-v1"
    );
    let root_id = result["rootTaskId"].as_str().unwrap();
    let schema_id = result["mapping"][&schema].as_str().unwrap();
    let gated_id = result["mapping"][&gated].as_str().unwrap();
    let root_waiting = body(
        &f.work,
        &f.remote(&format!("refs/heads/tasks/waiting/{root_id}"))
            .unwrap(),
    );
    let schema_waiting = body(
        &f.work,
        &f.remote(&format!("refs/heads/tasks/waiting/{schema_id}"))
            .unwrap(),
    );
    assert_eq!(root_waiting["children"].as_array().unwrap().len(), 3);
    assert_eq!(schema_waiting["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        schema_waiting["children"][0]["taskId"],
        result["mapping"][&implementation]
    );
    assert!(
        root_waiting["children"]
            .as_array()
            .unwrap()
            .iter()
            .all(|child| child["taskId"] != result["mapping"][&implementation])
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/blocked/{gated_id}"))
            .is_some()
    );
    let implementation_value = body(
        &f.work,
        result["plannedTaskOids"][&implementation].as_str().unwrap(),
    );
    assert_eq!(
        implementation_value["structuralParent"]["taskOid"],
        result["plannedTaskOids"][&schema]
    );
    let gated_value = body(&f.work, result["plannedTaskOids"][&gated].as_str().unwrap());
    assert!(
        gated_value["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|requirement| requirement["taskOid"] == result["plannedTaskOids"][&schema])
    );
    let gated_mapping = body(
        &f.work,
        &f.remote(&format!("refs/heads/tasks/v2/imports/v1/by-sha/{gated}"))
            .unwrap(),
    );
    assert_eq!(
        gated_mapping["provenance"]["graphNormalizations"],
        json!([])
    );
    let replay = Fixture::run_raw(
        &f.work,
        &[
            "migrate-v1",
            "--root",
            &f.root,
            "--operation-id",
            "recursive-nested",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0002"),
    );
    assert!(replay.status.success());
    assert_eq!(out.stdout, replay.stdout);
}

#[test]
fn recursive_graph_only_lifecycle_less_requirement_is_included_and_non_task_fails_closed() {
    let valid = Fixture::new(false, true);
    valid.remove_other_root();
    let source = commit(&valid.work, "Scheduled graph source", &[&valid.root]);
    let requirement = commit(
        &valid.work,
        "Graph-only dormant requirement",
        &[&valid.root],
    );
    let edge = json!({"from":format!("task:owner/repo@{source}"),"mode":"all","origin":{"repo-id":1,"witness":"graph-only"},"relation":"requires","schema":1,"to":format!("task:owner/repo@{requirement}")});
    let graph = Fixture::graph_commit_edge(&valid.work, &edge, Some(&valid.graph));
    ok(
        &valid.work,
        &[
            "push",
            "origin",
            &format!("{source}:refs/heads/tasks/frontier/graph-source"),
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = Fixture::run_raw(
        &valid.work,
        &[
            "migrate-v1",
            "--root",
            &valid.root,
            "--operation-id",
            "graph-only-recursive",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(result["mapping"].get(&requirement).is_some());
    let source_task = body(
        &valid.work,
        result["plannedTaskOids"][&source].as_str().unwrap(),
    );
    assert!(
        source_task["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["taskOid"] == result["plannedTaskOids"][&requirement])
    );

    let malformed = Fixture::new(false, true);
    malformed.remove_other_root();
    let source = commit(
        &malformed.work,
        "Scheduled graph source",
        &[&malformed.root],
    );
    let target = non_task_commit(&malformed.work, "Not a Task", &malformed.root);
    let edge = json!({"from":format!("task:owner/repo@{source}"),"mode":"all","origin":{"repo-id":1,"witness":"non-task"},"relation":"requires","schema":1,"to":format!("task:owner/repo@{target}")});
    let graph = Fixture::graph_commit_edge(&malformed.work, &edge, Some(&malformed.graph));
    ok(
        &malformed.work,
        &[
            "push",
            "origin",
            &format!("{source}:refs/heads/tasks/frontier/graph-source"),
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = Fixture::run_raw(
        &malformed.work,
        &[
            "migrate-v1",
            "--root",
            &malformed.root,
            "--operation-id",
            "graph-non-task",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("non-Task object"));
    assert!(
        ok(
            &malformed.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
}

#[test]
fn recursive_blocked_root_keeps_decomposed_nodes_waiting_and_blocks_runnable_leaves() {
    let f = Fixture::new(false, true);
    f.remove_other_root();
    let schema = commit(&f.work, "Lifecycle-less schema", &[&f.root]);
    let implementation = commit(&f.work, "Scheduled implementation", &[&schema]);
    ok(
        &f.work,
        &[
            "push",
            "origin",
            &format!("{implementation}:refs/heads/tasks/frontier/implementation"),
            &format!("{}:refs/heads/tasks/blocked/{}", f.root, f.root),
        ],
    );
    let out = Fixture::run_raw(
        &f.work,
        &[
            "migrate-v1",
            "--root",
            &f.root,
            "--operation-id",
            "recursive-blocked-root",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let schema_id = result["mapping"][&schema].as_str().unwrap();
    let implementation_id = result["mapping"][&implementation].as_str().unwrap();
    assert!(
        f.remote(&format!("refs/heads/tasks/waiting/{schema_id}"))
            .is_some()
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/blocked/{schema_id}"))
            .is_none()
    );
    assert!(
        f.remote(&format!("refs/heads/tasks/blocked/{implementation_id}"))
            .is_some()
    );
}

#[test]
fn recursive_approximation_preserves_decomposed_requirements_and_rejects_ancestor_cycles() {
    let decomposed_requirement = Fixture::new(false, true);
    decomposed_requirement.remove_other_root();
    let prerequisite = commit(
        &decomposed_requirement.work,
        "Lifecycle-less prerequisite",
        &[&decomposed_requirement.root],
    );
    let parent = commit(
        &decomposed_requirement.work,
        "Lifecycle-less decomposed parent",
        &[&decomposed_requirement.root, &prerequisite],
    );
    let child = commit(&decomposed_requirement.work, "Scheduled child", &[&parent]);
    ok(
        &decomposed_requirement.work,
        &[
            "push",
            "origin",
            &format!("{child}:refs/heads/tasks/frontier/decomposed-requirement"),
        ],
    );
    let out = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "migrate-v1",
            "--root",
            &decomposed_requirement.root,
            "--operation-id",
            "preserve-decomposed-requirement",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let parent_id = result["mapping"][&parent].as_str().unwrap();
    let prerequisite_id = result["mapping"][&prerequisite].as_str().unwrap();
    let parent_task = body(
        &decomposed_requirement.work,
        result["plannedTaskOids"][&parent].as_str().unwrap(),
    );
    assert_eq!(parent_task["requirements"].as_array().unwrap().len(), 1);
    assert_eq!(
        parent_task["requirements"][0]["taskOid"],
        result["plannedTaskOids"][&prerequisite]
    );
    assert!(
        decomposed_requirement
            .remote(&format!("refs/heads/tasks/waiting/{parent_id}"))
            .is_some()
    );
    assert!(
        decomposed_requirement
            .remote(&format!("refs/heads/tasks/blocked/{prerequisite_id}"))
            .is_some()
    );
    let child_id = result["mapping"][&child].as_str().unwrap();
    let claim_child = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "claim",
            child_id,
            "--owner",
            "fixture",
            "--operation-id",
            "claim-decomposed-child",
        ],
        None,
        Some("decomposed-child-token"),
    );
    assert!(claim_child.status.success());
    let claim_child: Value = serde_json::from_slice(&claim_child.stdout).unwrap();
    let complete_child = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "complete-ops",
            child_id,
            "--description",
            "fixture child completion",
            "--authorization",
            "fixture",
            "--claim-token",
            claim_child["claimToken"].as_str().unwrap(),
        ],
        None,
        Some("unused-token"),
    );
    assert!(complete_child.status.success());
    let journal_before = decomposed_requirement
        .remote("refs/heads/tasks/system/transitions")
        .unwrap();
    let premature = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "converge",
            parent_id,
            "--operation-id",
            "converge-decomposed-parent",
        ],
        None,
        Some("unused-token"),
    );
    assert!(!premature.status.success());
    assert!(String::from_utf8_lossy(&premature.stderr).contains("requirement"));
    assert_eq!(
        decomposed_requirement
            .remote("refs/heads/tasks/system/transitions")
            .unwrap(),
        journal_before
    );
    let unblock = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "unblock",
            prerequisite_id,
            "--block-lease",
            result["blockLeases"][prerequisite_id].as_str().unwrap(),
            "--authorization",
            "fixture",
            "--operation-id",
            "unblock-decomposed-requirement",
        ],
        None,
        Some("unused-token"),
    );
    assert!(unblock.status.success());
    let claim_requirement = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "claim",
            prerequisite_id,
            "--owner",
            "fixture",
            "--operation-id",
            "claim-decomposed-requirement",
        ],
        None,
        Some("decomposed-requirement-token"),
    );
    assert!(claim_requirement.status.success());
    let claim_requirement: Value = serde_json::from_slice(&claim_requirement.stdout).unwrap();
    let complete_requirement = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "complete-ops",
            prerequisite_id,
            "--description",
            "fixture requirement completion",
            "--authorization",
            "fixture",
            "--claim-token",
            claim_requirement["claimToken"].as_str().unwrap(),
        ],
        None,
        Some("unused-token"),
    );
    assert!(complete_requirement.status.success());
    let converge = Fixture::run_raw(
        &decomposed_requirement.work,
        &[
            "converge",
            parent_id,
            "--operation-id",
            "converge-decomposed-parent",
        ],
        None,
        Some("unused-token"),
    );
    assert!(
        converge.status.success(),
        "{}",
        String::from_utf8_lossy(&converge.stderr)
    );
    let done_oid = decomposed_requirement
        .remote(&format!("refs/heads/tasks/done/{parent_id}"))
        .unwrap();
    let done = body(&decomposed_requirement.work, &done_oid);
    assert_eq!(done["requirements"].as_array().unwrap().len(), 1);
    assert_eq!(
        done["requirements"][0][0],
        format!("refs/heads/tasks/done/{prerequisite_id}")
    );

    let ancestor_requirement = Fixture::new(false, true);
    ancestor_requirement.remove_other_root();
    let ancestor = commit(
        &ancestor_requirement.work,
        "Lifecycle-less ancestor",
        &[&ancestor_requirement.root],
    );
    let parent = commit(
        &ancestor_requirement.work,
        "Lifecycle-less parent",
        &[&ancestor],
    );
    let child = commit(
        &ancestor_requirement.work,
        "Scheduled child requiring ancestor",
        &[&parent, &ancestor],
    );
    ok(
        &ancestor_requirement.work,
        &[
            "push",
            "origin",
            &format!("{child}:refs/heads/tasks/frontier/ancestor-requirement"),
        ],
    );
    let out = Fixture::run_raw(
        &ancestor_requirement.work,
        &[
            "migrate-v1",
            "--root",
            &ancestor_requirement.root,
            "--operation-id",
            "reject-ancestor-requirement",
            "--recursive-approximation",
        ],
        None,
        Some("migration-token-0001"),
    );
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .contains("cannot require one of its structural ancestors")
    );
    assert!(
        ok(
            &ancestor_requirement.work,
            &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
        )
        .is_empty()
    );
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
fn satisfies_any_normalizes_to_open_or_completed_conjunctive_provenance() {
    let open = Fixture::new(false, false);
    let edge = json!({
        "from":format!("task:owner/repo@{}", open.tasks["b"]),
        "mode":"any",
        "origin":{"repo-id":1,"witness":"obsolete-or-edge"},
        "relation":"satisfies",
        "schema":1,
        "to":format!("task:owner/repo@{}", open.tasks["sibling"])
    });
    let graph = Fixture::graph_commit_edge(&open.work, &edge, Some(&open.graph));
    ok(
        &open.work,
        &[
            "push",
            "--force",
            "origin",
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = open.migrate("open-satisfies-normalization", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    let mapping = open
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            open.tasks["b"]
        ))
        .unwrap();
    let mapping = body(&open.work, &mapping);
    let task = body(&open.work, mapping["taskOid"].as_str().unwrap());
    assert!(
        task["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|requirement| {
                requirement["taskId"] == result["mapping"][&open.tasks["sibling"]]
            })
    );
    assert_eq!(
        mapping["provenance"]["graphNormalizations"],
        json!(["satisfies/any->requires/all"])
    );

    let completed = Fixture::new(false, false);
    let (target, witness) = completed.add_completed_issue(99, "Completed graph target");
    let edge = json!({
        "from":format!("task:owner/repo@{}", completed.tasks["b"]),
        "mode":"any",
        "origin":{"repo-id":1,"witness":"obsolete-completed-or-edge"},
        "relation":"satisfies",
        "schema":1,
        "to":format!("task:owner/repo@{target}")
    });
    let graph = Fixture::graph_commit_edge(&completed.work, &edge, Some(&completed.graph));
    ok(
        &completed.work,
        &[
            "push",
            "--force",
            "origin",
            &format!("{graph}:refs/heads/tasks/v1/graph"),
        ],
    );
    let out = completed.migrate("completed-satisfies-normalization", None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let mapping = completed
        .remote(&format!(
            "refs/heads/tasks/v2/imports/v1/by-sha/{}",
            completed.tasks["b"]
        ))
        .unwrap();
    let mapping = body(&completed.work, &mapping);
    assert_eq!(
        mapping["provenance"]["completedParentRequirements"],
        json!([{"completionWitnessOid":witness,"taskOid":target}])
    );
    assert_eq!(
        mapping["provenance"]["graphNormalizations"],
        json!(["satisfies/any->requires/all"])
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
