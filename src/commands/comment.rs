use super::{claim_token, default_owner, print_json, timestamp};
use crate::{
    Result,
    cli::{
        CommentAssociate, CommentForceDecide, CommentForceRequest, CommentForceSend, CommentPost,
        CommentReconcile,
    },
    git, journal,
    model::{self, ACTIVATION, JOURNAL, Update},
    repository,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const ANCESTOR_LIMIT: usize = 128;
// Ref validation currently invokes git check-ref-format per advertised ref.
// Keep reconciliation bounded tightly enough that one pass cannot amplify into
// an impractical number of subprocesses.
const RECONCILE_REF_LIMIT: usize = 1_000;
const RECONCILE_BYTE_LIMIT: usize = 2 * 1024 * 1024;
const PROVIDER_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
type BindingResolution = (repository::Snapshot, String, Option<(String, Value)>);

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| format!("validated comment record lacks {name}"))
}

fn commit_mutation(
    snap: &repository::Snapshot,
    operation: &str,
    updates: Vec<Update>,
    outputs: Vec<(String, String)>,
) -> Result<()> {
    let activation = snap
        .refs
        .get(ACTIVATION)
        .ok_or("snapshot lacks activation")?;
    let transition = journal::commit(
        snap.refs.get(JOURNAL).cloned(),
        activation,
        operation,
        &updates,
        &outputs,
    )?;
    repository::mutate(snap, updates, &transition)
}

fn structural_chain(task_id: &str, task_oid: &str) -> Result<Vec<(String, String)>> {
    let mut current_id = task_id.to_owned();
    let mut current_oid = task_oid.to_owned();
    let mut seen_oids = BTreeSet::new();
    let mut seen_ids = BTreeSet::new();
    let mut chain = Vec::new();
    for _ in 0..ANCESTOR_LIMIT {
        if !seen_oids.insert(current_oid.clone()) || !seen_ids.insert(current_id.clone()) {
            return Err("structural ancestor chain contains a cycle".into());
        }
        repository::materialize(std::slice::from_ref(&current_oid))?;
        let task = crate::validators::task(&current_oid, &current_id)?;
        chain.push((current_id.clone(), current_oid.clone()));
        if task["structuralParent"].is_null() {
            return Ok(chain);
        }
        current_id = field(&task["structuralParent"], "taskId")?.to_owned();
        current_oid = field(&task["structuralParent"], "taskOid")?.to_owned();
    }
    Err("structural ancestor chain exceeds hard limit".into())
}

fn find_binding(task_id: &str, intent_ref: &str) -> Result<BindingResolution> {
    model::valid_id(task_id)?;
    let first = repository::advertise(&repository::lifecycle_patterns(task_id))?;
    let lifecycle = model::lifecycle(&first, task_id);
    if lifecycle.len() != 1 {
        return Err("comment source must have exactly one advertised lifecycle ref".into());
    }
    repository::materialize(std::slice::from_ref(&lifecycle[0].2))?;
    let lifecycle_value = if lifecycle[0].0 == "waiting" {
        crate::validators::waiting(&lifecycle[0].2, task_id)?
    } else {
        crate::validators::lifecycle(&lifecycle[0].0, &lifecycle[0].2, task_id)?
    };
    let source_oid = field(&lifecycle_value, "taskOid")?.to_owned();
    let binding_refs: Vec<_> = structural_chain(task_id, &source_oid)?
        .into_iter()
        .map(|(id, oid)| (model::github_binding_task_ref(&id), oid))
        .collect();
    let mut patterns = repository::lifecycle_patterns(task_id);
    patterns.extend(binding_refs.iter().map(|(reference, _)| reference.clone()));
    patterns.extend([intent_ref.to_owned(), ACTIVATION.into(), JOURNAL.into()]);
    let snap = repository::advertise(&patterns)?;
    repository::validate_snapshot(&snap)?;
    let exact = model::lifecycle(&snap, task_id);
    if exact.len() != 1 || exact[0].2 != lifecycle[0].2 {
        return Err("comment source lifecycle raced during binding resolution".into());
    }
    for (reference, expected_task_oid) in binding_refs {
        if let Some(oid) = snap.refs.get(&reference) {
            let oid = oid.clone();
            repository::materialize(std::slice::from_ref(&oid))?;
            let id = reference
                .rsplit('/')
                .next()
                .ok_or("binding ref malformed")?;
            let binding = crate::validators::comment::issue_binding(&oid, id)?;
            if binding["taskOid"] != expected_task_oid {
                return Err(
                    "GitHub issue binding does not name the traversed structural ancestor".into(),
                );
            }
            let target_ref = model::github_binding_target_ref(
                field(&binding, "repositoryId")?,
                field(&binding, "issueId")?,
            );
            let mut paired_patterns = repository::lifecycle_patterns(task_id);
            paired_patterns.extend([
                reference.clone(),
                target_ref.clone(),
                intent_ref.to_owned(),
                ACTIVATION.into(),
                JOURNAL.into(),
            ]);
            let paired = repository::advertise(&paired_patterns)?;
            repository::validate_snapshot(&paired)?;
            if paired.refs.get(&reference) != Some(&oid)
                || paired.refs.get(&target_ref) != Some(&oid)
                || paired.refs.get(ACTIVATION) != snap.refs.get(ACTIVATION)
                || paired.refs.get(JOURNAL) != snap.refs.get(JOURNAL)
                || model::lifecycle(&paired, task_id) != exact
            {
                return Err(
                    "GitHub issue binding aliases or authoritative snapshot are inconsistent"
                        .into(),
                );
            }
            return Ok((paired, source_oid, Some((oid, binding))));
        }
    }
    Ok((snap, source_oid, None))
}

fn resolve(
    task_id: &str,
    intent_ref: &str,
) -> Result<(repository::Snapshot, String, String, Value)> {
    let (snap, source_oid, binding) = find_binding(task_id, intent_ref)?;
    let (binding_oid, binding) = binding.ok_or_else(|| {
        "no GitHub issue binding exists on the source task or a structural ancestor".to_owned()
    })?;
    Ok((snap, source_oid, binding_oid, binding))
}

fn validate_intent_binding(intent: &Value) -> Result<()> {
    let Some(binding_oid) = intent.get("bindingOid").and_then(Value::as_str) else {
        let decision_oid = field(intent, "forcedDecisionOid")?;
        let decision = git::object_json(decision_oid)?;
        let request_oid = field(&decision, "requestOid")?;
        repository::materialize(std::slice::from_ref(&request_oid.to_owned()))?;
        let request = crate::validators::comment::forced_request(request_oid)?;
        let request_ref = model::forced_comment_request_ref(field(&request, "operationId")?);
        let decision_ref = model::forced_comment_decision_ref(request_oid);
        let snap = repository::checked_snapshot(vec![
            request_ref.clone(),
            decision_ref.clone(),
            ACTIVATION.into(),
            JOURNAL.into(),
        ])?;
        if snap.refs.get(&request_ref).map(String::as_str) != Some(request_oid)
            || snap.refs.get(&decision_ref).map(String::as_str) != Some(decision_oid)
        {
            return Err(
                "forced comment intent no longer has its exact canonical authorization".into(),
            );
        }
        return Ok(());
    };
    let task_id = field(intent, "bindingTaskId")?;
    let task_ref = model::github_binding_task_ref(task_id);
    let target_ref =
        model::github_binding_target_ref(field(intent, "repositoryId")?, field(intent, "issueId")?);
    let snap = repository::checked_snapshot(vec![task_ref.clone(), target_ref.clone()])?;
    if snap.refs.get(&task_ref).map(String::as_str) != Some(binding_oid)
        || snap.refs.get(&target_ref).map(String::as_str) != Some(binding_oid)
    {
        return Err("GitHub issue binding aliases no longer match the comment intent".into());
    }
    repository::materialize(&[binding_oid.to_owned()])?;
    let binding = crate::validators::comment::issue_binding(binding_oid, task_id)?;
    let source_task_id = field(intent, "sourceTaskId")?;
    let source_task_oid = field(intent, "sourceTaskOid")?;
    if !structural_chain(source_task_id, source_task_oid)?
        .iter()
        .any(|(id, oid)| id == task_id && binding["taskOid"] == *oid)
    {
        return Err("comment intent binding is not on its exact source ancestry".into());
    }
    Ok(())
}

fn intended_semantics(
    args: &CommentPost,
    source_oid: &str,
    binding_oid: &str,
    binding: &Value,
    input: &str,
) -> String {
    model::framed_digest(
        "github-comment-intent-semantics",
        &[
            &args.task_id,
            source_oid,
            binding_oid,
            &args.kind,
            input,
            &args.operation_id,
            binding["repository"].as_str().unwrap_or(""),
            binding["issueId"].as_str().unwrap_or(""),
        ],
    )
}

fn replay_intent(oid: &str, semantic: &str) -> Result<Value> {
    repository::materialize(std::slice::from_ref(&oid.to_owned()))?;
    let value = crate::validators::comment::intent(oid)?;
    if value["semanticId"] != semantic {
        return Err("comment operation was already used with different semantics".into());
    }
    Ok(value)
}

fn create_intent(args: &CommentPost, input: &str) -> Result<(String, Value)> {
    let reference = model::comment_intent_ref(&args.operation_id);
    for _ in 0..3 {
        let (snap, source_oid, binding_oid, binding) = resolve(&args.task_id, &reference)?;
        let semantic = intended_semantics(args, &source_oid, &binding_oid, &binding, input);
        if let Some(oid) = snap.refs.get(&reference) {
            return Ok((oid.clone(), replay_intent(oid, &semantic)?));
        }
        let intent_id = model::framed_digest("github-comment-intent-id", &[&semantic]);
        let body = model::render_comment(&args.kind, input, &intent_id, false)?;
        let value = json!({
            "bindingOid":binding_oid,"bindingTaskId":binding["taskId"],"body":body,
            "bodyDigest":model::digest(&body),"createdAt":timestamp()?,"formatVersion":2,
            "inputBody":input,"inputBodyDigest":model::digest(input),"intentId":intent_id,
            "issueId":binding["issueId"],"issueNumber":binding["issueNumber"],"kind":args.kind,
            "marker":format!("<!-- task-dag:projection:{intent_id} -->"),"operationId":args.operation_id,
            "provider":"github","repository":binding["repository"],"repositoryId":binding["repositoryId"],
            "semanticId":semantic,"sourceTaskId":args.task_id,"sourceTaskOid":source_oid
        });
        let oid = git::commit(&value, &[])?;
        crate::validators::comment::intent(&oid)?;
        let updates = vec![Update {
            semantic_ref: reference.clone(),
            old: None,
            new: Some(oid.clone()),
        }];
        match commit_mutation(
            &snap,
            &args.operation_id,
            updates,
            vec![(reference.clone(), oid.clone())],
        ) {
            Ok(()) => return Ok((oid, value)),
            Err(error) => {
                let raced = repository::advertise(std::slice::from_ref(&reference))?;
                if let Some(raced_oid) = raced.refs.get(&reference) {
                    return Ok((raced_oid.clone(), replay_intent(raced_oid, &semantic)?));
                }
                if error
                    .to_string()
                    .contains("atomic push rejected; semantic refs remain")
                {
                    continue;
                }
                return Err(error);
            }
        }
    }
    let snap = repository::advertise(std::slice::from_ref(&reference))?;
    let oid = snap
        .refs
        .get(&reference)
        .ok_or("comment intent creation lost a bounded CAS race")?;
    let (_, source_oid, binding_oid, binding) = resolve(&args.task_id, &reference)?;
    let semantic = intended_semantics(args, &source_oid, &binding_oid, &binding, input);
    Ok((oid.clone(), replay_intent(oid, &semantic)?))
}

fn acquire_claim(intent_oid: &str, now: u64) -> Result<bool> {
    #[cfg(feature = "test-seam")]
    if let Ok(delay) = std::env::var("TASKDAG_TEST_COMMENT_CLAIM_DELAY_MS") {
        let delay = delay
            .parse::<u64>()
            .map_err(|_| "TASKDAG_TEST_COMMENT_CLAIM_DELAY_MS must be u64")?;
        thread::sleep(Duration::from_millis(delay));
    }
    let claim_ref = model::comment_delivery_claim_ref(intent_oid);
    let receipt_ref = model::comment_receipt_ref(intent_oid);
    let patterns = vec![
        claim_ref.clone(),
        receipt_ref.clone(),
        ACTIVATION.into(),
        JOURNAL.into(),
    ];
    for attempt in 0..3 {
        let snap = repository::advertise(&patterns)?;
        repository::validate_snapshot(&snap)?;
        if let Some(receipt) = snap.refs.get(&receipt_ref) {
            repository::materialize(std::slice::from_ref(receipt))?;
            crate::validators::comment::receipt(receipt, intent_oid)?;
            return Ok(false);
        }
        let old = if let Some(oid) = snap.refs.get(&claim_ref) {
            repository::materialize(std::slice::from_ref(oid))?;
            let claim = crate::validators::comment::delivery_claim(oid, intent_oid)?;
            if claim["expiresAt"]
                .as_u64()
                .ok_or("claim expiry malformed")?
                > now
            {
                return Err(
                    "comment delivery is already in progress under an unexpired claim".into(),
                );
            }
            Some(oid.clone())
        } else {
            None
        };
        let token = claim_token()?;
        let owner = default_owner();
        model::bounded("comment delivery owner", &owner, 256)?;
        let operation = format!("comment-delivery-claim:{intent_oid}:{token}");
        let claim = git::commit(
            &json!({"claimToken":token,"claimedAt":now,"expiresAt":now+360,"formatVersion":2,"intentOid":intent_oid,"operationId":operation,"owner":owner}),
            &[intent_oid.to_owned()],
        )?;
        crate::validators::comment::delivery_claim(&claim, intent_oid)?;
        let updates = vec![Update {
            semantic_ref: claim_ref.clone(),
            old,
            new: Some(claim.clone()),
        }];
        match commit_mutation(
            &snap,
            &operation,
            updates,
            vec![(claim_ref.clone(), claim.clone())],
        ) {
            Ok(()) => return Ok(true),
            Err(e) if e.contains("atomic push rejected; semantic refs remain") && attempt < 2 => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("comment delivery claim lost bounded contention retries".into())
}

struct ProviderOutput {
    success: bool,
    started: bool,
    stdout: String,
    stderr: String,
}

fn provider(args: &[String], timeout: Duration) -> ProviderOutput {
    let executable = if cfg!(feature = "test-seam") {
        std::env::var("TASKDAG_TEST_GH").unwrap_or_else(|_| "gh".into())
    } else {
        "gh".into()
    };
    let mut child = match Command::new(executable)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return provider_error(false, format!("start authenticated gh api adapter: {e}")),
    };
    let Some(stdout) = child.stdout.take() else {
        return provider_error(true, "open provider stdout".into());
    };
    let Some(stderr) = child.stderr.take() else {
        return provider_error(true, "open provider stderr".into());
    };
    let (tx, rx) = mpsc::channel();
    for (mut pipe, tag) in [
        (Box::new(stdout) as Box<dyn Read + Send>, 0_u8),
        (Box::new(stderr) as Box<dyn Read + Send>, 1_u8),
    ] {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut data = Vec::new();
            let result = pipe
                .by_ref()
                .take((PROVIDER_OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut data);
            let _ = tx.send((tag, result, data));
        });
    }
    drop(tx);
    let command_limit = if cfg!(feature = "test-seam") {
        Duration::from_millis(
            std::env::var("TASKDAG_TEST_GH_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000),
        )
    } else {
        Duration::from_secs(30)
    }
    .min(timeout);
    let start = Instant::now();
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status;
        }
        if start.elapsed() >= command_limit {
            let _ = child.kill();
            let _ = child.wait();
            return provider_error(true, "gh api exceeded hard time limit".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let mut values = [Vec::new(), Vec::new()];
    for _ in 0..2 {
        let Ok((tag, result, data)) = rx.recv() else {
            return provider_error(true, "read gh api output".into());
        };
        if let Err(e) = result {
            return provider_error(true, e.to_string());
        }
        if data.len() > PROVIDER_OUTPUT_LIMIT {
            return provider_error(true, "gh api output exceeds hard byte limit".into());
        }
        values[tag as usize] = data;
    }
    ProviderOutput {
        success: status.success(),
        started: true,
        stdout: match String::from_utf8(values[0].clone()) {
            Ok(v) => v,
            Err(_) => return provider_error(true, "gh api stdout is not UTF-8".into()),
        },
        stderr: String::from_utf8_lossy(&values[1]).trim().into(),
    }
}

fn provider_error(started: bool, stderr: String) -> ProviderOutput {
    ProviderOutput {
        success: false,
        started,
        stdout: String::new(),
        stderr,
    }
}

fn source_task(task_id: &str) -> Result<(repository::Snapshot, String)> {
    model::valid_id(task_id)?;
    let mut patterns = repository::lifecycle_patterns(task_id);
    patterns.extend([ACTIVATION.into(), JOURNAL.into()]);
    let snap = repository::advertise(&patterns)?;
    repository::validate_snapshot(&snap)?;
    let lifecycle = model::lifecycle(&snap, task_id);
    if lifecycle.len() != 1 {
        return Err("comment source must have exactly one advertised lifecycle ref".into());
    }
    repository::materialize(std::slice::from_ref(&lifecycle[0].2))?;
    let value = if lifecycle[0].0 == "waiting" {
        crate::validators::waiting(&lifecycle[0].2, task_id)?
    } else {
        crate::validators::lifecycle(&lifecycle[0].0, &lifecycle[0].2, task_id)?
    };
    Ok((snap, field(&value, "taskOid")?.to_owned()))
}

fn read_target(repository: &str, issue_number: &str) -> Result<Value> {
    let repository = model::github_repository(repository)?;
    model::positive_decimal_id("issue number", issue_number)?;
    let began = Instant::now();
    let repo_out = provider(
        &[
            "api".into(),
            format!("repos/{repository}"),
            "--hostname".into(),
            "github.com".into(),
        ],
        Duration::from_secs(30),
    );
    if !repo_out.success {
        return Err(format!(
            "GitHub repository identity read failed: {}",
            repo_out.stderr
        ));
    }
    let repo: Value = serde_json::from_str(&repo_out.stdout)
        .map_err(|e| format!("parse GitHub repository identity: {e}"))?;
    let repository_id = decimal(&repo["id"], "repository ID")?;
    if repo["full_name"]
        .as_str()
        .is_none_or(|v| v.to_ascii_lowercase() != repository)
    {
        return Err(
            "GitHub repository response does not match the canonical requested path".into(),
        );
    }
    let remaining = Duration::from_secs(30).saturating_sub(began.elapsed());
    if remaining.is_zero() {
        return Err("GitHub target identity read exceeded overall deadline".into());
    }
    let issue_out = provider(
        &[
            "api".into(),
            format!("repos/{repository}/issues/{issue_number}"),
            "--hostname".into(),
            "github.com".into(),
        ],
        remaining,
    );
    if !issue_out.success {
        return Err(format!(
            "GitHub issue identity read failed: {}",
            issue_out.stderr
        ));
    }
    let issue: Value = serde_json::from_str(&issue_out.stdout)
        .map_err(|e| format!("parse GitHub issue identity: {e}"))?;
    let issue_id = decimal(&issue["id"], "issue ID")?;
    let canonical_number = decimal(&issue["number"], "issue number")?;
    let issue_title = issue["title"]
        .as_str()
        .ok_or("GitHub issue title is malformed")?;
    model::bounded("GitHub issue title", issue_title, 4_096)?;
    if issue_title.contains('\r')
        || issue_title
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err("GitHub issue title contains unsupported control characters".into());
    }
    if canonical_number != issue_number
        || issue["repository_url"] != format!("https://api.github.com/repos/{repository}")
    {
        return Err("GitHub issue response does not match the canonical requested target".into());
    }
    Ok(
        json!({"provider":"github","repository":repository,"repositoryId":repository_id,"issueId":issue_id,"issueNumber":canonical_number,"issueTitle":issue_title}),
    )
}

fn decimal(value: &Value, name: &str) -> Result<String> {
    let result = match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return Err(format!("provider {name} is not numeric")),
    };
    model::positive_decimal_id(&format!("provider {name}"), &result)?;
    Ok(result)
}

fn comments(value: Value) -> Result<Vec<Value>> {
    let pages = value
        .as_array()
        .ok_or("GitHub comment listing is not an array")?;
    let mut result = Vec::new();
    for page in pages {
        result.extend(
            page.as_array()
                .ok_or("GitHub comment listing page is not an array")?
                .iter()
                .cloned(),
        );
    }
    Ok(result)
}

fn http_status(error: &str) -> Option<u16> {
    error
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|pair| {
            (pair[0].eq_ignore_ascii_case("HTTP") && pair[1].len() == 3)
                .then(|| pair[1].parse().ok())
                .flatten()
        })
}

fn permanent(error: &str) -> bool {
    match http_status(error) {
        Some(403) => !["rate limit", "rate-limit", "abuse", "secondary rate"]
            .iter()
            .any(|hint| error.to_ascii_lowercase().contains(hint)),
        Some(code @ 400..=499) => !matches!(code, 408 | 409 | 425 | 429),
        _ => false,
    }
}

fn retry_after(error: &str) -> Option<Duration> {
    let lower = error.to_ascii_lowercase();
    ["retry-after:", "retry after "].iter().find_map(|prefix| {
        let tail = lower.split_once(prefix)?.1.trim_start();
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        let seconds = digits.parse::<u64>().ok()?.min(300);
        Some(Duration::from_secs(seconds))
    })
}

enum TargetVerification {
    Verified,
    Retryable(String),
    Permanent(String),
}

fn verify_provider_target(intent: &Value, timeout: Duration) -> TargetVerification {
    let began = Instant::now();
    let repo = match field(intent, "repository") {
        Ok(value) => value,
        Err(error) => return TargetVerification::Permanent(error),
    };
    let repository = provider(
        &[
            "api".into(),
            format!("repos/{repo}"),
            "--hostname".into(),
            "github.com".into(),
        ],
        timeout,
    );
    if !repository.success {
        let error = format!(
            "GitHub repository identity read failed: {}",
            repository.stderr
        );
        return if permanent(&repository.stderr) {
            TargetVerification::Permanent(error)
        } else {
            TargetVerification::Retryable(error)
        };
    }
    let repository: Value = match serde_json::from_str(&repository.stdout) {
        Ok(value) => value,
        Err(error) => {
            return TargetVerification::Retryable(format!(
                "parse GitHub repository identity: {error}"
            ));
        }
    };
    let repository_id = match decimal(&repository["id"], "repository ID") {
        Ok(value) => value,
        Err(error) => return TargetVerification::Retryable(error),
    };
    if repository_id != intent["repositoryId"]
        || repository["full_name"]
            .as_str()
            .is_none_or(|value| value.to_ascii_lowercase() != repo)
    {
        return TargetVerification::Permanent(
            "GitHub repository path no longer resolves to the intent's stable identity".into(),
        );
    }
    let remaining = timeout.saturating_sub(began.elapsed());
    if remaining.is_zero() {
        return TargetVerification::Retryable(
            "delivery deadline elapsed while verifying GitHub target identity".into(),
        );
    }
    let number = match field(intent, "issueNumber") {
        Ok(value) => value,
        Err(error) => return TargetVerification::Permanent(error),
    };
    let issue = provider(
        &[
            "api".into(),
            format!("repos/{repo}/issues/{number}"),
            "--hostname".into(),
            "github.com".into(),
        ],
        remaining,
    );
    if !issue.success {
        let error = format!("GitHub issue identity read failed: {}", issue.stderr);
        return if permanent(&issue.stderr) {
            TargetVerification::Permanent(error)
        } else {
            TargetVerification::Retryable(error)
        };
    }
    let issue: Value = match serde_json::from_str(&issue.stdout) {
        Ok(value) => value,
        Err(error) => {
            return TargetVerification::Retryable(format!("parse GitHub issue identity: {error}"));
        }
    };
    let issue_id = match decimal(&issue["id"], "issue ID") {
        Ok(value) => value,
        Err(error) => return TargetVerification::Retryable(error),
    };
    let issue_number = match decimal(&issue["number"], "issue number") {
        Ok(value) => value,
        Err(error) => return TargetVerification::Retryable(error),
    };
    if issue_id != intent["issueId"]
        || issue_number != intent["issueNumber"]
        || issue["repository_url"] != format!("https://api.github.com/repos/{repo}")
    {
        return TargetVerification::Permanent(
            "GitHub issue path no longer resolves to the intent's stable identity".into(),
        );
    }
    TargetVerification::Verified
}

fn readback(intent: &Value, comment_id: &str, timeout: Duration) -> Result<Value> {
    let repo = field(intent, "repository")?;
    let number = field(intent, "issueNumber")?;
    let out = provider(
        &[
            "api".into(),
            format!("repos/{repo}/issues/comments/{comment_id}"),
            "--hostname".into(),
            "github.com".into(),
        ],
        timeout,
    );
    if !out.success {
        return Err(format!("GitHub comment readback failed: {}", out.stderr));
    }
    let value: Value = serde_json::from_str(&out.stdout)
        .map_err(|e| format!("parse GitHub comment readback: {e}"))?;
    if decimal(&value["id"], "comment ID")? != comment_id
        || value["body"] != intent["body"]
        || value["html_url"]
            != format!("https://github.com/{repo}/issues/{number}#issuecomment-{comment_id}")
        || value["issue_url"] != format!("https://api.github.com/repos/{repo}/issues/{number}")
    {
        return Err("GitHub comment readback does not exactly match intent and target".into());
    }
    Ok(value)
}

fn record_receipt(intent_oid: &str, intent: &Value, observed: &Value) -> Result<Value> {
    let reference = model::comment_receipt_ref(intent_oid);
    let patterns = vec![reference.clone(), ACTIVATION.into(), JOURNAL.into()];
    let expected_id = decimal(&observed["id"], "comment ID")?;
    for attempt in 0..3 {
        let snap = repository::advertise(&patterns)?;
        repository::validate_snapshot(&snap)?;
        if let Some(oid) = snap.refs.get(&reference) {
            repository::materialize(std::slice::from_ref(oid))?;
            let winner = crate::validators::comment::receipt(oid, intent_oid)?;
            if winner["commentId"] != expected_id || winner["commentUrl"] != observed["html_url"] {
                return Err("comment receipt contention produced a conflicting winner".into());
            }
            return Ok(winner);
        }
        let value = json!({"bodyDigest":intent["bodyDigest"],"commentId":expected_id,"commentUrl":observed["html_url"],"formatVersion":2,"intentOid":intent_oid,"issueId":intent["issueId"],"observedAt":timestamp()?,"provider":"github","repositoryId":intent["repositoryId"]});
        let oid = git::commit(&value, &[intent_oid.to_owned()])?;
        crate::validators::comment::receipt(&oid, intent_oid)?;
        let operation = format!("comment-receipt:{intent_oid}");
        match commit_mutation(
            &snap,
            &operation,
            vec![Update {
                semantic_ref: reference.clone(),
                old: None,
                new: Some(oid.clone()),
            }],
            vec![(reference.clone(), oid)],
        ) {
            Ok(()) => return Ok(value),
            Err(e) if e.contains("atomic push rejected; semantic refs remain") && attempt < 2 => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("comment receipt creation lost bounded contention retries".into())
}

fn deliver(intent_oid: &str, intent: &Value) -> Result<Value> {
    let began = Instant::now();
    let delay = if cfg!(feature = "test-seam") {
        Duration::from_millis(
            std::env::var("TASKDAG_TEST_COMMENT_RETRY_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10_000),
        )
    } else {
        Duration::from_secs(10)
    };
    let deadline = if cfg!(feature = "test-seam") {
        Duration::from_millis(
            std::env::var("TASKDAG_TEST_COMMENT_DEADLINE_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300_000),
        )
    } else {
        Duration::from_secs(300)
    };
    let receipt_ref = model::comment_receipt_ref(intent_oid);
    let existing = repository::advertise(std::slice::from_ref(&receipt_ref))?;
    if let Some(oid) = existing.refs.get(&receipt_ref) {
        repository::materialize(std::slice::from_ref(oid))?;
        return crate::validators::comment::receipt(oid, intent_oid);
    }
    validate_intent_binding(intent)?;
    if !acquire_claim(intent_oid, timestamp()?)? {
        let refreshed = repository::advertise(std::slice::from_ref(&receipt_ref))?;
        let receipt = refreshed
            .refs
            .get(&receipt_ref)
            .ok_or("comment receipt disappeared after validated read")?;
        repository::materialize(std::slice::from_ref(receipt))?;
        return crate::validators::comment::receipt(receipt, intent_oid);
    }
    let repo = field(intent, "repository")?;
    let number = field(intent, "issueNumber")?;
    let marker = field(intent, "marker")?;
    let body = field(intent, "body")?;
    let mut last = "delivery not attempted".to_owned();
    let mut next_delay = delay;
    let mut post_uncertain = false;
    for round in 0..6 {
        if round > 0 {
            thread::sleep(next_delay.min(deadline.saturating_sub(began.elapsed())));
            next_delay = delay;
        }
        if began.elapsed() >= deadline {
            break;
        }
        match verify_provider_target(intent, deadline.saturating_sub(began.elapsed())) {
            TargetVerification::Verified => {}
            TargetVerification::Permanent(error) => return Err(error),
            TargetVerification::Retryable(error) => {
                last = error;
                continue;
            }
        }
        let list = provider(
            &[
                "api".into(),
                format!("repos/{repo}/issues/{number}/comments"),
                "--paginate".into(),
                "--slurp".into(),
                "--hostname".into(),
                "github.com".into(),
            ],
            deadline.saturating_sub(began.elapsed()),
        );
        if !list.success {
            last = format!("GitHub comment listing failed: {}", list.stderr);
            if permanent(&list.stderr) {
                return Err(last);
            }
            next_delay = retry_after(&list.stderr).unwrap_or(delay).max(delay);
            continue;
        }
        let listed = match serde_json::from_str(&list.stdout)
            .map_err(|e| format!("parse GitHub comment listing: {e}"))
            .and_then(comments)
        {
            Ok(value) => value,
            Err(e) => {
                last = e;
                continue;
            }
        };
        let found: Vec<_> = listed
            .into_iter()
            .filter(|v| v["body"].as_str().is_some_and(|b| b.contains(marker)))
            .collect();
        if found.len() > 1 {
            return Err("multiple GitHub comments contain the projection marker".into());
        }
        if let Some(comment) = found.first() {
            if comment["body"] != body {
                return Err("GitHub projection marker exists with a different body".into());
            }
            let id = decimal(&comment["id"], "comment ID")?;
            let remaining = deadline.saturating_sub(began.elapsed());
            if remaining.is_zero() {
                break;
            }
            match readback(intent, &id, remaining) {
                Ok(value) => return record_receipt(intent_oid, intent, &value),
                Err(e) => {
                    last = e.to_string();
                    if permanent(&last) {
                        return Err(last);
                    }
                    continue;
                }
            }
        }
        if post_uncertain {
            last = "prior comment POST remains uncertain and marker is not yet visible".into();
            continue;
        }
        let remaining = deadline.saturating_sub(began.elapsed());
        if remaining.is_zero() {
            break;
        }
        let post = provider(
            &[
                "api".into(),
                format!("repos/{repo}/issues/{number}/comments"),
                "--method".into(),
                "POST".into(),
                "-f".into(),
                format!("body={body}"),
                "--hostname".into(),
                "github.com".into(),
            ],
            remaining,
        );
        post_uncertain = post.started;
        if !post.success {
            last = format!("GitHub comment POST failed: {}", post.stderr);
            if permanent(&post.stderr) {
                return Err(last);
            }
            next_delay = retry_after(&post.stderr).unwrap_or(delay).max(delay);
            continue;
        }
        let posted: Value = match serde_json::from_str(&post.stdout) {
            Ok(v) => v,
            Err(e) => {
                last = format!("parse GitHub comment POST response: {e}");
                continue;
            }
        };
        let id = match decimal(&posted["id"], "comment ID") {
            Ok(id) => id,
            Err(e) => {
                last = e;
                continue;
            }
        };
        let remaining = deadline.saturating_sub(began.elapsed());
        if remaining.is_zero() {
            last =
                "comment POST succeeded but the delivery deadline elapsed before readback".into();
            continue;
        }
        match readback(intent, &id, remaining) {
            Ok(value) => return record_receipt(intent_oid, intent, &value),
            Err(e) => {
                last = e.to_string();
                if permanent(&last) {
                    return Err(last);
                }
            }
        }
    }
    Err(format!(
        "comment intent {intent_oid} remains pending after bounded delivery: {last}"
    ))
}

pub(crate) fn associate(args: CommentAssociate) -> Result<()> {
    model::bounded("operation-id", &args.operation_id, 256)?;
    let target = read_target(&args.repository, &args.issue_number)?;
    for _ in 0..3 {
        let (base, task_oid) = source_task(&args.task_id)?;
        let task_ref = model::github_binding_task_ref(&args.task_id);
        let target_ref = model::github_binding_target_ref(
            field(&target, "repositoryId")?,
            field(&target, "issueId")?,
        );
        let mut patterns = repository::lifecycle_patterns(&args.task_id);
        patterns.extend([
            task_ref.clone(),
            target_ref.clone(),
            ACTIVATION.into(),
            JOURNAL.into(),
        ]);
        let snap = repository::advertise(&patterns)?;
        repository::validate_snapshot(&snap)?;
        if model::lifecycle(&snap, &args.task_id) != model::lifecycle(&base, &args.task_id) {
            continue;
        }
        let semantic = model::framed_digest(
            "github-issue-binding-semantics",
            &[
                &args.task_id,
                &task_oid,
                field(&target, "repository")?,
                field(&target, "repositoryId")?,
                field(&target, "issueId")?,
                field(&target, "issueNumber")?,
                &args.operation_id,
            ],
        );
        if let Some(oid) = snap
            .refs
            .get(&task_ref)
            .or_else(|| snap.refs.get(&target_ref))
        {
            if snap.refs.get(&task_ref) != Some(oid) || snap.refs.get(&target_ref) != Some(oid) {
                return Err(
                    "GitHub issue binding task or target is already associated differently".into(),
                );
            }
            repository::materialize(std::slice::from_ref(oid))?;
            let value = crate::validators::comment::issue_binding(oid, &args.task_id)?;
            if value["semanticId"] != semantic {
                return Err("GitHub issue binding conflicts with requested semantics".into());
            }
            return print_json(
                &json!({"bindingOid":oid,"taskRef":task_ref,"targetRef":target_ref}),
            );
        }
        let value = json!({"formatVersion":2,"issueId":target["issueId"],"issueNumber":target["issueNumber"],"operationId":args.operation_id,"provider":"github","repository":target["repository"],"repositoryId":target["repositoryId"],"semanticId":semantic,"taskId":args.task_id,"taskOid":task_oid});
        let oid = git::commit(&value, &[])?;
        crate::validators::comment::issue_binding(&oid, &args.task_id)?;
        let updates = [task_ref.clone(), target_ref.clone()]
            .into_iter()
            .map(|semantic_ref| Update {
                semantic_ref,
                old: None,
                new: Some(oid.clone()),
            })
            .collect();
        match commit_mutation(
            &snap,
            &args.operation_id,
            updates,
            vec![
                (task_ref.clone(), oid.clone()),
                (target_ref.clone(), oid.clone()),
            ],
        ) {
            Ok(()) => {
                return print_json(
                    &json!({"bindingOid":oid,"taskRef":task_ref,"targetRef":target_ref}),
                );
            }
            Err(e) if e.contains("atomic push rejected; semantic refs remain") => continue,
            Err(e) => return Err(e),
        }
    }
    Err("GitHub issue association lost bounded contention retries".into())
}

fn request_packet(oid: &str, request: &Value, token: Option<&str>) -> Value {
    let markdown_inline = |value: &str| {
        value
            .chars()
            .flat_map(|character| {
                if matches!(character, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>') {
                    vec!['\\', character]
                } else {
                    vec![character]
                }
            })
            .collect::<String>()
    };
    let literal_body = request["body"]
        .as_str()
        .unwrap_or("")
        .lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let markdown = format!(
        "# Choose how to post this GitHub comment\n\n**Nothing has been posted.** Decide whether [{} issue #{}: {}](https://github.com/{}/issues/{}) should become the lasting GitHub issue for **{}**, or permit only the exact comment shown below.\n\n## Exact proposed comment\n\nType: **{}**\n\n{}\n\n## Choose one\n\n1. **Associate normally (preferred if this issue is the task’s ongoing home):** Create a lasting association with this issue, then allow the fleet to post the exact comment above normally.\n2. **Authorize only this exact comment:** Allow the fleet to post only the displayed comment to this issue, without creating an ongoing association. The comment will include a warning that the task may not be associated with the issue.\n\nBoth choices permit a GitHub-visible comment. The recorded choice cannot be changed; the second choice applies only to this one comment. Optional context may explain the choice but cannot alter the target, type, or body.\n\n[Open the current Amp work thread]({}).",
        request["repository"].as_str().unwrap_or(""),
        request["issueNumber"].as_str().unwrap_or(""),
        markdown_inline(request["issueTitle"].as_str().unwrap_or("")),
        request["repository"].as_str().unwrap_or(""),
        request["issueNumber"].as_str().unwrap_or(""),
        markdown_inline(request["sourceTaskTitle"].as_str().unwrap_or("")),
        request["kind"].as_str().unwrap_or(""),
        literal_body,
        request["ampThreadUrl"].as_str().unwrap_or(""),
    );
    json!({"profile":"task-dag-forced-comment-target-v1","markdown":markdown,"requestOid":oid,"requestRef":model::forced_comment_request_ref(field(request,"operationId").unwrap_or("")),"requestId":request["requestId"],"sourceTaskId":request["sourceTaskId"],"sourceTaskOid":request["sourceTaskOid"],"sourceTaskTitle":request["sourceTaskTitle"],"target":{"repository":request["repository"],"repositoryId":request["repositoryId"],"issueId":request["issueId"],"issueNumber":request["issueNumber"],"issueTitle":request["issueTitle"]},"kind":request["kind"],"body":request["body"],"ampThreadUrl":request["ampThreadUrl"],"decisionToken":token,"decisionTokenAvailable":token.is_some(),"decisionTokenInstruction":if token.is_some(){"Pass decisionToken separately to comment force-decide."}else{"The one-time token is not recoverable; create a fresh force-request operation if the first packet was lost."}})
}

pub(crate) fn force_request(args: CommentForceRequest) -> Result<()> {
    model::bounded("operation-id", &args.operation_id, 256)?;
    model::amp_thread_url(&args.amp_thread_url)?;
    let input = model::normalize_comment_input(
        std::str::from_utf8(
            &fs::read(&args.body_file).map_err(|e| format!("read comment body file: {e}"))?,
        )
        .map_err(|_| "comment body file is not UTF-8")?,
    )?;
    let target = read_target(&args.repository, &args.issue_number)?;
    let reference = model::forced_comment_request_ref(&args.operation_id);
    let (snap, task_oid, binding) = find_binding(&args.task_id, &reference)?;
    if binding.as_ref().is_some_and(|(_, binding)| {
        binding["repositoryId"] == target["repositoryId"] && binding["issueId"] == target["issueId"]
    }) {
        return Err("requested target is already authorized by a normal GitHub issue binding; use comment post".into());
    }
    repository::materialize(std::slice::from_ref(&task_oid))?;
    let source_task = crate::validators::task(&task_oid, &args.task_id)?;
    let source_task_title = field(&source_task, "title")?;
    let semantic = model::framed_digest(
        "forced-comment-request-semantics",
        &[
            &args.task_id,
            &task_oid,
            field(&target, "repository")?,
            field(&target, "repositoryId")?,
            field(&target, "issueId")?,
            field(&target, "issueNumber")?,
            &args.kind,
            &input,
            &args.operation_id,
            &args.amp_thread_url,
        ],
    );
    if let Some(oid) = snap.refs.get(&reference) {
        repository::materialize(std::slice::from_ref(oid))?;
        let value = crate::validators::comment::forced_request(oid)?;
        if value["semanticId"] != semantic {
            return Err(
                "forced comment operation was already used with different semantics".into(),
            );
        }
        return print_json(&request_packet(oid, &value, None));
    }
    let token = claim_token()?;
    let request_id = model::framed_digest("forced-comment-request-id", &[&semantic]);
    let value = json!({"ampThreadUrl":args.amp_thread_url,"body":input,"bodyDigest":model::digest(&input),"createdAt":timestamp()?,"formatVersion":2,"issueId":target["issueId"],"issueNumber":target["issueNumber"],"issueTitle":target["issueTitle"],"kind":args.kind,"operationId":args.operation_id,"provider":"github","repository":target["repository"],"repositoryId":target["repositoryId"],"requestId":request_id,"semanticId":semantic,"sourceTaskId":args.task_id,"sourceTaskOid":task_oid,"sourceTaskTitle":source_task_title,"tokenDigest":model::digest(&token)});
    let oid = git::commit(&value, &[])?;
    crate::validators::comment::forced_request(&oid)?;
    commit_mutation(
        &snap,
        &args.operation_id,
        vec![Update {
            semantic_ref: reference.clone(),
            old: None,
            new: Some(oid.clone()),
        }],
        vec![(reference, oid.clone())],
    )?;
    print_json(&request_packet(&oid, &value, Some(&token)))
}

pub(crate) fn force_decide(args: CommentForceDecide) -> Result<()> {
    model::oid(&args.request_oid)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    model::bounded("evidence", &args.evidence, 4096)?;
    repository::materialize(std::slice::from_ref(&args.request_oid))?;
    let request = crate::validators::comment::forced_request(&args.request_oid)?;
    let request_ref = model::forced_comment_request_ref(field(&request, "operationId")?);
    let advertised = repository::advertise(std::slice::from_ref(&request_ref))?;
    if advertised.refs.get(&request_ref) != Some(&args.request_oid) {
        return Err("forced comment request is not the canonical published request".into());
    }
    if request["tokenDigest"] != model::digest(&args.decision_token) {
        return Err("decision token does not authorize this forced comment request".into());
    }
    let raw =
        fs::read(&args.context_file).map_err(|e| format!("read decision context file: {e}"))?;
    let context = std::str::from_utf8(&raw)
        .map_err(|_| "decision context file is not UTF-8")?
        .replace("\r\n", "\n");
    if context.contains('\r')
        || context.len() > 4096
        || context
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err("decision context is invalid or exceeds 4096 bytes".into());
    }
    let context = context.trim_matches('\n').to_owned();
    let reference = model::forced_comment_decision_ref(&args.request_oid);
    let semantic = model::framed_digest(
        "forced-comment-decision-semantics",
        &[
            &args.request_oid,
            &args.choice,
            &args.evidence_kind,
            &args.evidence,
            &context,
            &args.operation_id,
        ],
    );
    let snap =
        repository::checked_snapshot(vec![reference.clone(), ACTIVATION.into(), JOURNAL.into()])?;
    if let Some(oid) = snap.refs.get(&reference) {
        repository::materialize(std::slice::from_ref(oid))?;
        let value = crate::validators::comment::forced_decision(oid, &args.request_oid)?;
        if value["semanticId"] != semantic {
            return Err("forced comment decision already exists with different semantics".into());
        }
        return print_json(&json!({"decisionOid":oid,"decisionRef":reference,"decision":value}));
    }
    let value = json!({"choice":args.choice,"context":context,"decidedAt":timestamp()?,"evidence":args.evidence,"evidenceKind":args.evidence_kind,"formatVersion":2,"operationId":args.operation_id,"requestOid":args.request_oid,"semanticId":semantic});
    let oid = git::commit(&value, std::slice::from_ref(&args.request_oid))?;
    crate::validators::comment::forced_decision(&oid, &args.request_oid)?;
    commit_mutation(
        &snap,
        &args.operation_id,
        vec![Update {
            semantic_ref: reference.clone(),
            old: None,
            new: Some(oid.clone()),
        }],
        vec![(reference.clone(), oid.clone())],
    )?;
    print_json(&json!({"decisionOid":oid,"decisionRef":reference,"decision":value}))
}

pub(crate) fn force_send(args: CommentForceSend) -> Result<()> {
    model::oid(&args.request_oid)?;
    model::bounded("operation-id", &args.operation_id, 256)?;
    repository::materialize(std::slice::from_ref(&args.request_oid))?;
    let request = crate::validators::comment::forced_request(&args.request_oid)?;
    let request_ref = model::forced_comment_request_ref(field(&request, "operationId")?);
    let decision_ref = model::forced_comment_decision_ref(&args.request_oid);
    let intent_ref = model::comment_intent_ref(&args.operation_id);
    let snap = repository::checked_snapshot(vec![
        request_ref.clone(),
        decision_ref.clone(),
        intent_ref.clone(),
        ACTIVATION.into(),
        JOURNAL.into(),
    ])?;
    if snap.refs.get(&request_ref) != Some(&args.request_oid) {
        return Err("forced comment request is not the canonical published request".into());
    }
    let decision_oid = snap
        .refs
        .get(&decision_ref)
        .ok_or("forced comment request has no canonical decision")?;
    repository::materialize(std::slice::from_ref(decision_oid))?;
    let decision = crate::validators::comment::forced_decision(decision_oid, &args.request_oid)?;
    if decision["choice"] == "associate" {
        return Err("decision chose associate: run comment associate, then normal comment post; force-send will not post".into());
    }
    let semantic = model::framed_digest(
        "forced-comment-intent-semantics",
        &[&args.request_oid, decision_oid, &args.operation_id],
    );
    let (oid, intent) = if let Some(oid) = snap.refs.get(&intent_ref) {
        repository::materialize(std::slice::from_ref(oid))?;
        let v = crate::validators::comment::intent(oid)?;
        if v["semanticId"] != semantic {
            return Err("forced send operation was already used with different semantics".into());
        }
        (oid.clone(), v)
    } else {
        let intent_id = model::framed_digest("github-comment-intent-id", &[&semantic]);
        let input = field(&request, "body")?;
        let body = model::render_comment(field(&request, "kind")?, input, &intent_id, true)?;
        let v = json!({"body":body,"bodyDigest":model::digest(&body),"createdAt":timestamp()?,"forcedDecisionOid":decision_oid,"formatVersion":2,"inputBody":input,"inputBodyDigest":model::digest(input),"intentId":intent_id,"issueId":request["issueId"],"issueNumber":request["issueNumber"],"kind":request["kind"],"marker":format!("<!-- task-dag:projection:{intent_id} -->"),"operationId":args.operation_id,"provider":"github","repository":request["repository"],"repositoryId":request["repositoryId"],"semanticId":semantic,"sourceTaskId":request["sourceTaskId"],"sourceTaskOid":request["sourceTaskOid"]});
        let oid = git::commit(&v, &[])?;
        crate::validators::comment::intent(&oid)?;
        commit_mutation(
            &snap,
            &args.operation_id,
            vec![Update {
                semantic_ref: intent_ref.clone(),
                old: None,
                new: Some(oid.clone()),
            }],
            vec![(intent_ref.clone(), oid.clone())],
        )?;
        (oid, v)
    };
    let receipt = deliver(&oid, &intent)?;
    print_json(
        &json!({"commentId":receipt["commentId"],"commentUrl":receipt["commentUrl"],"intentOid":oid,"intentRef":intent_ref}),
    )
}

pub(crate) fn post(args: CommentPost) -> Result<()> {
    model::bounded("operation-id", &args.operation_id, 256)?;
    let bytes = fs::read(&args.body_file).map_err(|e| format!("read comment body file: {e}"))?;
    let input = model::normalize_comment_input(
        std::str::from_utf8(&bytes).map_err(|_| "comment body file is not UTF-8")?,
    )?;
    let (oid, intent) = create_intent(&args, &input)?;
    let receipt = deliver(&oid, &intent)?;
    print_json(
        &json!({"commentId":receipt["commentId"],"commentUrl":receipt["commentUrl"],"intentOid":oid,"intentRef":model::comment_intent_ref(&args.operation_id)}),
    )
}

fn duration(value: &str) -> Result<u64> {
    let split = value
        .find(|c: char| !c.is_ascii_digit())
        .ok_or("duration requires a unit: s, m, h, or d")?;
    let (n, unit) = value.split_at(split);
    let n: u64 = n.parse().map_err(|_| "duration value is invalid")?;
    if n == 0 {
        return Err("duration must be positive".into());
    }
    let factor = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return Err("duration unit must be s, m, h, or d".into()),
    };
    n.checked_mul(factor)
        .filter(|v| *v <= 31_536_000)
        .ok_or_else(|| "duration exceeds one year".into())
}

pub(crate) fn reconcile(args: CommentReconcile) -> Result<()> {
    if !(1..=100).contains(&args.max) {
        return Err("comment reconciliation --max must be between 1 and 100".into());
    }
    let age = duration(&args.older_than)?;
    let now = timestamp()?;
    let patterns = vec![
        "refs/heads/tasks/comments/intents/*".into(),
        "refs/heads/tasks/comments/delivery-claims/*".into(),
        "refs/heads/tasks/comments/receipts/*".into(),
        ACTIVATION.into(),
        JOURNAL.into(),
    ];
    let snap = repository::advertise_bounded(&patterns, RECONCILE_REF_LIMIT, RECONCILE_BYTE_LIMIT)?;
    repository::validate_snapshot(&snap)?;
    for (reference, oid) in snap
        .refs
        .iter()
        .filter(|(r, _)| r.starts_with("refs/heads/tasks/comments/delivery-claims/"))
    {
        repository::materialize(std::slice::from_ref(oid))?;
        let raw = git::object_json(oid)?;
        let intent_oid = field(&raw, "intentOid")?;
        crate::validators::comment::delivery_claim(oid, intent_oid)?;
        if reference != &model::comment_delivery_claim_ref(intent_oid) {
            return Err("comment delivery claim ref does not match its intent identity".into());
        }
    }
    for (reference, oid) in snap
        .refs
        .iter()
        .filter(|(r, _)| r.starts_with("refs/heads/tasks/comments/receipts/"))
    {
        repository::materialize(std::slice::from_ref(oid))?;
        let raw = git::object_json(oid)?;
        let intent_oid = field(&raw, "intentOid")?;
        crate::validators::comment::receipt(oid, intent_oid)?;
        if reference != &model::comment_receipt_ref(intent_oid) {
            return Err("comment receipt ref does not match its intent identity".into());
        }
    }
    let mut pending = Vec::new();
    for (reference, oid) in snap
        .refs
        .iter()
        .filter(|(r, _)| r.starts_with("refs/heads/tasks/comments/intents/"))
    {
        repository::materialize(std::slice::from_ref(oid))?;
        let intent = crate::validators::comment::intent(oid)?;
        if reference != &model::comment_intent_ref(field(&intent, "operationId")?) {
            return Err("comment intent ref does not match its operation identity".into());
        }
        let receipt = model::comment_receipt_ref(oid);
        if let Some(receipt_oid) = snap.refs.get(&receipt) {
            repository::materialize(std::slice::from_ref(receipt_oid))?;
            crate::validators::comment::receipt(receipt_oid, oid)?;
            continue;
        }
        let claim_ref = model::comment_delivery_claim_ref(oid);
        if let Some(claim_oid) = snap.refs.get(&claim_ref) {
            repository::materialize(std::slice::from_ref(claim_oid))?;
            let claim = crate::validators::comment::delivery_claim(claim_oid, oid)?;
            if claim["expiresAt"]
                .as_u64()
                .ok_or("claim expiry malformed")?
                > now
            {
                continue;
            }
        }
        let created = intent["createdAt"]
            .as_u64()
            .ok_or("intent createdAt malformed")?;
        if created <= now.saturating_sub(age) {
            pending.push((created, reference.clone(), oid.clone(), intent));
        }
    }
    pending.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let selected = pending.len().min(args.max);
    for (_, reference, oid, intent) in pending.into_iter().take(args.max) {
        match deliver(&oid, &intent) {
            Ok(receipt) => results.push(
                json!({"commentId":receipt["commentId"],"intentOid":oid,"intentRef":reference}),
            ),
            Err(e) => errors.push(format!("{oid}: {e}")),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "comment reconciliation left selected intents pending: {}",
            errors.join("; ")
        ));
    }
    print_json(&json!({"delivered":results,"selected":selected}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_duration_parser_is_strict() {
        assert_eq!(duration("10s").ok(), Some(10));
        assert_eq!(duration("5m").ok(), Some(300));
        assert_eq!(duration("2h").ok(), Some(7_200));
        assert_eq!(duration("1d").ok(), Some(86_400));
        for invalid in ["0s", "1", "1ms", "366d", "-1s", "1S"] {
            assert!(duration(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn paginated_comment_parser_preserves_large_ids() {
        let parsed = comments(json!([[{"id":9_007_199_254_740_993_u64,"body":"a"}], [{"id":"18446744073709551615","body":"b"}]])).unwrap();
        assert_eq!(
            decimal(&parsed[0]["id"], "comment ID").unwrap(),
            "9007199254740993"
        );
        assert_eq!(
            decimal(&parsed[1]["id"], "comment ID").unwrap(),
            "18446744073709551615"
        );
        assert!(comments(json!([{"id":1}])).is_err());
    }

    #[test]
    fn provider_failure_classification_is_conservative() {
        assert!(permanent("gh: validation failed (HTTP 422)"));
        assert!(permanent("HTTP 401"));
        assert!(permanent("HTTP 403 forbidden"));
        assert!(!permanent("HTTP 403 secondary rate limit"));
        assert!(!permanent("HTTP 408"));
        assert!(!permanent("HTTP 409"));
        assert!(!permanent("HTTP 429"));
        assert!(!permanent("HTTP 503"));
        assert!(!permanent("connection reset"));
        assert_eq!(
            retry_after("gh: wait (Retry-After: 42)"),
            Some(Duration::from_secs(42))
        );
        assert_eq!(
            retry_after("retry after 999 seconds"),
            Some(Duration::from_secs(300))
        );
    }
}
