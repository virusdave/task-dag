use super::{digest, object};
use crate::{Result, git, model};
use serde_json::Value;

fn string<'a>(value: &'a Value, key: &str, kind: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("{kind} {key} malformed"))
}

fn timestamp(value: &Value, key: &str, kind: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("{kind} {key} malformed"))
}

fn optional_text(value: &Value, key: &str, kind: &str, limit: usize) -> Result<()> {
    let text = string(value, key, kind)?;
    if text.len() > limit
        || text.contains('\r')
        || text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(format!("{kind} {key} is invalid or exceeds {limit} bytes"));
    }
    Ok(())
}

fn github_target(value: &Value, kind: &str) -> Result<()> {
    if value["provider"] != "github" {
        return Err(format!("{kind} provider must be github"));
    }
    let repository = string(value, "repository", kind)?;
    if model::github_repository(repository)? != repository {
        return Err(format!("{kind} repository is not normalized"));
    }
    model::positive_decimal_id(
        &format!("{kind} repositoryId"),
        string(value, "repositoryId", kind)?,
    )?;
    model::positive_decimal_id(&format!("{kind} issueId"), string(value, "issueId", kind)?)?;
    model::positive_decimal_id(
        &format!("{kind} issueNumber"),
        string(value, "issueNumber", kind)?,
    )?;
    Ok(())
}

pub(crate) fn issue_binding(oid: &str, expected_task_id: &str) -> Result<Value> {
    let value = object(
        oid,
        "GitHub issue binding",
        &[
            "formatVersion",
            "issueId",
            "issueNumber",
            "operationId",
            "provider",
            "repository",
            "repositoryId",
            "semanticId",
            "taskId",
            "taskOid",
        ],
        &[&[]],
    )?;
    if !git::parents(oid)?.is_empty() {
        return Err("GitHub issue binding must be parentless".into());
    }
    github_target(&value, "GitHub issue binding")?;
    let task_id = string(&value, "taskId", "GitHub issue binding")?;
    model::valid_id(task_id)?;
    if task_id != expected_task_id {
        return Err("GitHub issue binding taskId does not match ref identity".into());
    }
    model::oid(string(&value, "taskOid", "GitHub issue binding")?)?;
    super::task(string(&value, "taskOid", "GitHub issue binding")?, task_id)?;
    model::bounded(
        "GitHub issue binding operationId",
        string(&value, "operationId", "GitHub issue binding")?,
        256,
    )?;
    digest("GitHub issue binding semanticId", &value["semanticId"])?;
    Ok(value)
}

pub(crate) fn intent(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "GitHub comment intent",
        &[
            "body",
            "bodyDigest",
            "createdAt",
            "formatVersion",
            "inputBody",
            "inputBodyDigest",
            "intentId",
            "issueId",
            "issueNumber",
            "kind",
            "marker",
            "operationId",
            "provider",
            "repository",
            "repositoryId",
            "semanticId",
            "sourceTaskId",
            "sourceTaskOid",
        ],
        &[&["bindingOid", "bindingTaskId"], &["forcedDecisionOid"]],
    )?;
    if !git::parents(oid)?.is_empty() {
        return Err("GitHub comment intent must be parentless".into());
    }
    github_target(&value, "GitHub comment intent")?;
    let source_task_id = string(&value, "sourceTaskId", "GitHub comment intent")?;
    model::valid_id(source_task_id)?;
    let source_task_oid = string(&value, "sourceTaskOid", "GitHub comment intent")?;
    model::oid(source_task_oid)?;
    super::task(source_task_oid, source_task_id)?;
    if let Some(binding) = value.get("bindingOid") {
        let binding_oid = binding
            .as_str()
            .ok_or("GitHub comment intent bindingOid malformed")?;
        model::oid(binding_oid)?;
        let binding_task_id = string(&value, "bindingTaskId", "GitHub comment intent")?;
        let binding = issue_binding(binding_oid, binding_task_id)?;
        if [
            "provider",
            "repository",
            "repositoryId",
            "issueId",
            "issueNumber",
        ]
        .iter()
        .any(|field| binding[*field] != value[*field])
        {
            return Err("GitHub comment intent target does not match binding".into());
        }
    } else {
        let decision_oid = string(&value, "forcedDecisionOid", "GitHub comment intent")?;
        model::oid(decision_oid)?;
        let decision = git::object_json(decision_oid)?;
        let request_oid = string(
            &decision,
            "requestOid",
            "forced GitHub comment target decision",
        )?;
        forced_decision(decision_oid, request_oid)?;
        let request = forced_request(request_oid)?;
        if decision["choice"] != "force"
            || request["sourceTaskId"] != source_task_id
            || request["sourceTaskOid"] != source_task_oid
            || request["body"] != value["inputBody"]
            || request["bodyDigest"] != value["inputBodyDigest"]
            || [
                "provider",
                "repository",
                "repositoryId",
                "issueId",
                "issueNumber",
                "kind",
            ]
            .iter()
            .any(|field| request[*field] != value[*field])
        {
            return Err("forced GitHub comment intent does not match its authorization".into());
        }
    }
    let kind = string(&value, "kind", "GitHub comment intent")?;
    if !matches!(kind, "status" | "operator-decision") {
        return Err("GitHub comment intent kind is unsupported".into());
    }
    let body = string(&value, "body", "GitHub comment intent")?;
    let input_body = string(&value, "inputBody", "GitHub comment intent")?;
    let normalized_input = model::normalize_comment_input(input_body)?;
    if normalized_input != input_body {
        return Err("GitHub comment intent inputBody is not normalized".into());
    }
    if value["bodyDigest"] != model::digest(body) {
        return Err("GitHub comment intent bodyDigest does not match body".into());
    }
    if value.get("forcedDecisionOid").is_some()
        && !body
            .lines()
            .any(|line| line == model::FORCED_COMMENT_TARGET_WARNING)
    {
        return Err("forced GitHub comment intent lacks its tooling warning".into());
    }
    digest(
        "GitHub comment intent inputBodyDigest",
        &value["inputBodyDigest"],
    )?;
    if value["inputBodyDigest"] != model::digest(input_body) {
        return Err("GitHub comment intent inputBodyDigest does not match inputBody".into());
    }
    let intent_id = string(&value, "intentId", "GitHub comment intent")?;
    digest("GitHub comment intent intentId", &value["intentId"])?;
    let marker = string(&value, "marker", "GitHub comment intent")?;
    if marker != format!("<!-- task-dag:projection:{intent_id} -->") {
        return Err("GitHub comment intent projection marker is malformed".into());
    }
    let expected_body = model::render_comment(
        kind,
        input_body,
        intent_id,
        value.get("forcedDecisionOid").is_some(),
    )?;
    if body != expected_body {
        return Err("GitHub comment intent body is not the canonical rendering".into());
    }
    model::bounded(
        "GitHub comment intent operationId",
        string(&value, "operationId", "GitHub comment intent")?,
        256,
    )?;
    digest("GitHub comment intent semanticId", &value["semanticId"])?;
    timestamp(&value, "createdAt", "GitHub comment intent")?;
    Ok(value)
}

pub(crate) fn delivery_claim(oid: &str, expected_intent_oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "GitHub comment delivery claim",
        &[
            "claimToken",
            "claimedAt",
            "expiresAt",
            "formatVersion",
            "intentOid",
            "operationId",
            "owner",
        ],
        &[&[]],
    )?;
    model::oid(expected_intent_oid)?;
    if git::parents(oid)? != [expected_intent_oid] || value["intentOid"] != expected_intent_oid {
        return Err("GitHub comment delivery claim does not bind its intent parent".into());
    }
    let claimed_at = timestamp(&value, "claimedAt", "GitHub comment delivery claim")?;
    let expires_at = timestamp(&value, "expiresAt", "GitHub comment delivery claim")?;
    if expires_at <= claimed_at || expires_at - claimed_at > 360 {
        return Err("GitHub comment delivery claim lifetime exceeds six minutes".into());
    }
    intent(expected_intent_oid)?;
    for (field, limit) in [("claimToken", 256), ("operationId", 256), ("owner", 256)] {
        model::bounded(
            &format!("GitHub comment delivery claim {field}"),
            string(&value, field, "GitHub comment delivery claim")?,
            limit,
        )?;
    }
    Ok(value)
}

pub(crate) fn receipt(oid: &str, expected_intent_oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "GitHub comment receipt",
        &[
            "bodyDigest",
            "commentId",
            "commentUrl",
            "formatVersion",
            "intentOid",
            "issueId",
            "observedAt",
            "provider",
            "repositoryId",
        ],
        &[&[]],
    )?;
    model::oid(expected_intent_oid)?;
    if git::parents(oid)? != [expected_intent_oid] || value["intentOid"] != expected_intent_oid {
        return Err("GitHub comment receipt does not bind its intent parent".into());
    }
    if value["provider"] != "github" {
        return Err("GitHub comment receipt provider must be github".into());
    }
    for field in ["repositoryId", "issueId", "commentId"] {
        model::positive_decimal_id(
            &format!("GitHub comment receipt {field}"),
            string(&value, field, "GitHub comment receipt")?,
        )?;
    }
    digest("GitHub comment receipt bodyDigest", &value["bodyDigest"])?;
    model::bounded(
        "GitHub comment receipt commentUrl",
        string(&value, "commentUrl", "GitHub comment receipt")?,
        2_048,
    )?;
    timestamp(&value, "observedAt", "GitHub comment receipt")?;
    let intent = intent(expected_intent_oid)?;
    if ["provider", "repositoryId", "issueId", "bodyDigest"]
        .iter()
        .any(|field| value[*field] != intent[*field])
    {
        return Err("GitHub comment receipt does not match intent".into());
    }
    let expected_url = format!(
        "https://github.com/{}/issues/{}#issuecomment-{}",
        string(&intent, "repository", "GitHub comment intent")?,
        string(&intent, "issueNumber", "GitHub comment intent")?,
        string(&value, "commentId", "GitHub comment receipt")?
    );
    if value["commentUrl"] != expected_url {
        return Err("GitHub comment receipt URL is not canonical".into());
    }
    Ok(value)
}

pub(crate) fn forced_request(oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "forced GitHub comment target request",
        &[
            "ampThreadUrl",
            "body",
            "bodyDigest",
            "createdAt",
            "formatVersion",
            "issueId",
            "issueNumber",
            "issueTitle",
            "kind",
            "operationId",
            "provider",
            "repository",
            "repositoryId",
            "requestId",
            "semanticId",
            "sourceTaskId",
            "sourceTaskOid",
            "sourceTaskTitle",
            "tokenDigest",
        ],
        &[&[]],
    )?;
    if !git::parents(oid)?.is_empty() {
        return Err("forced GitHub comment target request must be parentless".into());
    }
    github_target(&value, "forced GitHub comment target request")?;
    model::amp_thread_url(string(
        &value,
        "ampThreadUrl",
        "forced GitHub comment target request",
    )?)?;
    optional_text(
        &value,
        "issueTitle",
        "forced GitHub comment target request",
        4_096,
    )?;
    let source_task_id = string(
        &value,
        "sourceTaskId",
        "forced GitHub comment target request",
    )?;
    let source_task_oid = string(
        &value,
        "sourceTaskOid",
        "forced GitHub comment target request",
    )?;
    model::oid(source_task_oid)?;
    let source_task = super::task(source_task_oid, source_task_id)?;
    optional_text(
        &value,
        "sourceTaskTitle",
        "forced GitHub comment target request",
        4_096,
    )?;
    if value["sourceTaskTitle"] != source_task["title"] {
        return Err("forced GitHub comment target request sourceTaskTitle is stale".into());
    }
    let kind = string(&value, "kind", "forced GitHub comment target request")?;
    if !matches!(kind, "status" | "operator-decision") {
        return Err("forced GitHub comment target request kind is unsupported".into());
    }
    let body = string(&value, "body", "forced GitHub comment target request")?;
    if model::normalize_comment_input(body)? != body {
        return Err("forced GitHub comment target request body is not normalized".into());
    }
    if value["bodyDigest"] != model::digest(body) {
        return Err("forced GitHub comment target request bodyDigest does not match body".into());
    }
    model::bounded(
        "forced GitHub comment target request operationId",
        string(
            &value,
            "operationId",
            "forced GitHub comment target request",
        )?,
        256,
    )?;
    for field in ["requestId", "semanticId", "tokenDigest"] {
        digest(
            &format!("forced GitHub comment target request {field}"),
            &value[field],
        )?;
    }
    timestamp(&value, "createdAt", "forced GitHub comment target request")?;
    Ok(value)
}

pub(crate) fn forced_decision(oid: &str, expected_request_oid: &str) -> Result<Value> {
    let value = object(
        oid,
        "forced GitHub comment target decision",
        &[
            "choice",
            "context",
            "decidedAt",
            "evidence",
            "evidenceKind",
            "formatVersion",
            "operationId",
            "requestOid",
            "semanticId",
        ],
        &[&[]],
    )?;
    model::oid(expected_request_oid)?;
    if git::parents(oid)? != [expected_request_oid] || value["requestOid"] != expected_request_oid {
        return Err(
            "forced GitHub comment target decision does not bind its request parent".into(),
        );
    }
    let choice = string(&value, "choice", "forced GitHub comment target decision")?;
    if !matches!(choice, "associate" | "force") {
        return Err("forced GitHub comment target decision choice is unsupported".into());
    }
    let evidence_kind = string(
        &value,
        "evidenceKind",
        "forced GitHub comment target decision",
    )?;
    if !matches!(evidence_kind, "amp-thread" | "one-offs-submission") {
        return Err("forced GitHub comment target decision evidenceKind is unsupported".into());
    }
    if evidence_kind == "amp-thread" {
        model::amp_thread_url(string(
            &value,
            "evidence",
            "forced GitHub comment target decision",
        )?)?;
    }
    optional_text(
        &value,
        "context",
        "forced GitHub comment target decision",
        4_096,
    )?;
    for (field, limit) in [("evidence", 4_096), ("operationId", 256)] {
        model::bounded(
            &format!("forced GitHub comment target decision {field}"),
            string(&value, field, "forced GitHub comment target decision")?,
            limit,
        )?;
    }
    digest(
        "forced GitHub comment target decision semanticId",
        &value["semanticId"],
    )?;
    timestamp(&value, "decidedAt", "forced GitHub comment target decision")?;
    forced_request(expected_request_oid)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn github_targets_require_canonical_provider_identity() {
        let valid = json!({
            "provider": "github",
            "repository": "owner/repository",
            "repositoryId": "123",
            "issueId": "456",
            "issueNumber": "7"
        });
        assert!(github_target(&valid, "target").is_ok());
        let mut mixed_case = valid.clone();
        mixed_case["repository"] = json!("Owner/Repository");
        assert!(github_target(&mixed_case, "target").is_err());
        let mut leading_zero = valid.clone();
        leading_zero["issueId"] = json!("0456");
        assert!(github_target(&leading_zero, "target").is_err());
        let mut other_provider = valid;
        other_provider["provider"] = json!("gitlab");
        assert!(github_target(&other_provider, "target").is_err());
    }

    #[test]
    fn optional_operator_context_accepts_empty_but_rejects_controls() {
        assert!(optional_text(&json!({"context":""}), "context", "decision", 8).is_ok());
        assert!(optional_text(&json!({"context":"a\nnote"}), "context", "decision", 8).is_ok());
        assert!(optional_text(&json!({"context":"bad\rtext"}), "context", "decision", 8).is_err());
    }
}
