use serde_json::{Value, json};
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
    command.current_dir(cwd).args(["commit-tree", EMPTY_TREE]);
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

struct Fixture {
    root_dir: PathBuf,
    work: PathBuf,
    root: String,
    tasks: BTreeMap<&'static str, String>,
    refs: BTreeMap<String, String>,
    activation: String,
    graph: String,
    journal: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root_dir);
    }
}

impl Fixture {
    fn new(blocked_in_closure: bool, singleton: bool) -> Self {
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
        Self::run_raw(&work, &["init", "--trusted-floor", &floor], None, None);
        let journal = ok(
            &work,
            &["ls-remote", "origin", "refs/heads/tasks/system/transitions"],
        )
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();

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
        let graph = Self::graph_commit(&work, &other_frontier);

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
            refs.insert("refs/heads/tasks/blocked/c".into(), c.clone());
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
            journal,
        }
    }

    fn graph_commit(work: &Path, task: &str) -> String {
        let edge = json!({"from":format!("task:owner/repo@{task}"),"mode":"all","origin":{"repo-id":1,"witness":"fixture"},"relation":"requires","schema":1,"to":"issue:owner/repo#42"});
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
                "100644 blob {blob}\tedge.json"
            )
            .unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .into()
        };
        ok(work, &["commit-tree", &tree, "-m", "graph"])
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
            .env("TASKDAG_TEST_LEGACY_ACTIVATION", "1")
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
        Self::run_raw(
            &self.work,
            &[
                "migrate-v1",
                "--root",
                &self.root,
                "--operation-id",
                operation,
            ],
            extra,
            Some("migration-token-0001"),
        )
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
    fn assert_failure_untouched(&self, out: &Output) {
        assert!(!out.status.success(), "migration unexpectedly succeeded");
        assert_eq!(
            self.remote("refs/heads/tasks/system/transitions").unwrap(),
            self.journal
        );
        assert_eq!(
            self.remote("refs/heads/tasks/v1/activation").as_deref(),
            Some(self.activation.as_str())
        );
        for (reference, oid) in &self.refs {
            if reference.contains("tasks/v1/") {
                continue;
            }
            assert_eq!(
                self.remote(reference).as_deref(),
                Some(oid.as_str()),
                "changed {reference}"
            );
        }
        assert!(
            ok(
                &self.work,
                &["ls-remote", "origin", "refs/heads/tasks/v2/imports/v1/*"]
            )
            .is_empty()
        );
    }
}

#[test]
fn singleton_pending_root_becomes_open_frontier_with_preserved_context() {
    let f = Fixture::new(false, true);
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
    assert_eq!(
        f.remote("refs/heads/tasks/v1/graph").as_deref(),
        Some(f.graph.as_str())
    );
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
fn malformed_closure_and_touching_graph_fail_without_mutation() {
    let f = Fixture::new(true, false);
    let touching = Fixture::graph_commit(&f.work, &f.root);
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
    assert!(String::from_utf8_lossy(&out.stderr).contains("blocked legacy state"));
    f.assert_failure_untouched(&out);
}

#[test]
fn exact_terminal_external_edge_is_preserved_as_immutable_provenance() {
    let f = Fixture::new(false, true);
    let touching = Fixture::graph_commit(&f.work, &f.root);
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
    assert_eq!(
        f.remote("refs/heads/tasks/v1/graph").as_deref(),
        Some(touching.as_str())
    );
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
