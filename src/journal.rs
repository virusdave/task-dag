use crate::{
    Result, git,
    model::{Update, digest},
    runtime,
};
use serde_json::json;

pub(crate) fn commit(
    prior: Option<String>,
    activation: &str,
    operation: &str,
    updates: &[Update],
    outputs: &[(String, String)],
) -> Result<String> {
    let update_json = serde_json::to_string(updates).map_err(|e| e.to_string())?;
    let result = digest(&update_json);
    let logical = crate::model::framed_digest(
        "journal-logical",
        &["transition", operation, activation, &update_json],
    );
    let attempt = crate::model::framed_digest(
        "journal-attempt",
        &["transition", &logical, prior.as_deref().unwrap_or("")],
    );
    let mut sorted = outputs.to_vec();
    sorted.sort();
    let canonical_outputs: Vec<_> = sorted
        .iter()
        .map(|(semantic_ref, oid)| json!({"semanticRef":semantic_ref,"oid":oid}))
        .collect();
    let record = json!({"activation":activation,"attemptId":attempt,"formatVersion":2,"logicalId":logical,"operationId":operation,"outputs":canonical_outputs,"resultDigest":result,"runtimeCommit":runtime()?,"updates":updates});
    let mut parents = Vec::new();
    if let Some(p) = prior {
        parents.push(p)
    }
    parents.extend(sorted.into_iter().map(|(_, o)| o));
    git::commit(&record, &parents)
}
