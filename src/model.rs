use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::{Result, git, repository::Snapshot};

pub(crate) const ACTIVATION: &str = "refs/heads/tasks/v2/activation";
pub(crate) const JOURNAL: &str = "refs/heads/tasks/system/transitions";
const STATES: [&str; 5] = ["frontier", "active", "blocked", "waiting", "done"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct BreakdownSpec {
    pub(crate) operation_id: String,
    pub(crate) children: Vec<ChildSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ChildSpec {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) requires: Vec<String>,
    pub(crate) claim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Update {
    pub(crate) semantic_ref: String,
    pub(crate) old: Option<String>,
    pub(crate) new: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimRecord {
    pub(crate) claim_token: String,
    pub(crate) owner: String,
    pub(crate) host: String,
    pub(crate) session_id: String,
    pub(crate) claimed_at: u64,
    pub(crate) expires_at: u64,
    pub(crate) task_id: String,
    pub(crate) task_oid: String,
}

pub(crate) fn canonical_updates(mut updates: Vec<Update>) -> Vec<Update> {
    updates.sort_by(|a, b| a.semantic_ref.cmp(&b.semantic_ref).then(a.new.cmp(&b.new)));
    updates
}

pub(crate) fn repository_id(value: &str) -> Result<()> {
    let digest = value
        .strip_prefix("repo-v2-")
        .ok_or("repository ID must start with repo-v2-")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("repository ID must end with 64 lowercase hex characters".into());
    }
    Ok(())
}

pub(crate) fn state_ref(state: &str, id: &str) -> String {
    format!("refs/heads/tasks/{state}/{id}")
}
pub(crate) fn delegation_intent_ref(operation: &str) -> String {
    format!(
        "refs/heads/tasks/delegations/intents/{}",
        framed_digest("delegation-operation-key", &[operation])
    )
}
pub(crate) fn delegation_admission_ref(source_repository_id: &str, operation: &str) -> String {
    format!(
        "refs/heads/tasks/delegations/admissions/{}",
        framed_digest(
            "delegation-admission-key",
            &[source_repository_id, operation]
        )
    )
}
pub(crate) fn delegation_export_ref(source_repository_id: &str, operation: &str) -> String {
    format!(
        "refs/heads/tasks/delegations/exports/{}",
        framed_digest(
            "delegation-admission-key",
            &[source_repository_id, operation]
        )
    )
}
pub(crate) fn delegation_accepted_ref(source_repository_id: &str, operation: &str) -> String {
    format!(
        "refs/heads/tasks/delegations/accepted/{}",
        framed_digest(
            "delegation-admission-key",
            &[source_repository_id, operation]
        )
    )
}
pub(crate) fn parse_state_ref<'a>(r: &'a str, state: &str) -> Option<&'a str> {
    r.strip_prefix(&format!("refs/heads/tasks/{state}/"))
}
pub(crate) fn lifecycle(s: &Snapshot, id: &str) -> Vec<(String, String, String)> {
    STATES
        .iter()
        .filter_map(|state| {
            let r = state_ref(state, id);
            s.refs.get(&r).map(|o| ((*state).into(), r, o.clone()))
        })
        .collect()
}
pub(crate) fn requirements(s: &Snapshot, ids: &[String]) -> Result<Vec<Value>> {
    let mut seen = BTreeSet::new();
    ids.iter()
        .map(|id| {
            valid_id(id)?;
            if !seen.insert(id) {
                return Err(format!("duplicate requirement {id}"));
            }
            let found = lifecycle(s, id);
            if found.len() != 1 {
                return Err(format!(
                    "requirement {id} must have exactly one advertised lifecycle ref"
                ));
            }
            Ok(json!({"taskId":id,"taskOid":git::lifecycle_task(&found[0].2)?}))
        })
        .collect()
}
pub(crate) fn breakdown_requirements(
    s: &Snapshot,
    ids: &[String],
    created: &BTreeMap<String, String>,
) -> Result<Vec<Value>> {
    let mut seen = BTreeSet::new();
    ids.iter().map(|id| {
        if !seen.insert(id) { return Err(format!("duplicate requirement {id}")); }
        let task = if let Some(task) = created.get(id) { task.clone() } else { let found = lifecycle(s,id); if found.len()!=1 { return Err(format!("requirement {id} must be an earlier child or have exactly one advertised lifecycle ref")); } git::lifecycle_task(&found[0].2)? };
        Ok(json!({"taskId":id,"taskOid":task}))
    }).collect()
}
pub(crate) fn requirement_oids(reqs: &[Value]) -> Vec<String> {
    reqs.iter()
        .map(|v| v["taskOid"].as_str().unwrap().into())
        .collect()
}
pub(crate) fn readiness(s: &Snapshot, reqs: &[Value]) -> Result<()> {
    for req in reqs {
        let id = req["taskId"]
            .as_str()
            .ok_or("requirement taskId malformed")?;
        valid_id(id)?;
        let found = lifecycle(s, id);
        if found.len() != 1 || found[0].0 != "done" {
            return Err(format!("requirement {id} is not done in the advertisement"));
        }
        let expected = req["taskOid"]
            .as_str()
            .ok_or("requirement taskOid malformed")?;
        oid(expected)?;
        crate::repository::materialize(std::slice::from_ref(&found[0].2))?;
        let evidence = crate::validators::lifecycle("done", &found[0].2, id)?;
        if evidence["taskId"] != id || evidence["taskOid"] != expected {
            return Err(format!(
                "requirement {id} done evidence has wrong immutable identity"
            ));
        }
    }
    Ok(())
}
pub(crate) fn validate_children(parent: &str, s: &BreakdownSpec) -> Result<()> {
    nonempty("operationId", &s.operation_id)?;
    if s.children.is_empty() {
        return Err("breakdown requires at least one child".into());
    }
    let mut keys = BTreeSet::new();
    for c in &s.children {
        nonempty("child key", &c.key)?;
        bounded("child key", &c.key, 128)?;
        bounded("title", &c.title, 512)?;
        bounded("description", &c.description, 16_384)?;
        if !keys.insert(&c.key) {
            return Err(format!("duplicate child key {}", c.key));
        }
        valid_id(&task_id("child", &[parent, &s.operation_id, &c.key]))?;
    }
    Ok(())
}
pub(crate) fn resolve_requirements(
    values: &[String],
    ids: &BTreeMap<String, String>,
) -> Result<Vec<String>> {
    values
        .iter()
        .map(|v| {
            if let Some(id) = ids.get(v) {
                Ok(id.clone())
            } else {
                valid_id(v)?;
                Ok(v.clone())
            }
        })
        .collect()
}
pub(crate) fn task_id(domain: &str, parts: &[&str]) -> String {
    format!("v2-{}", framed_digest(domain, parts))
}
pub(crate) fn framed_digest(domain: &str, parts: &[&str]) -> String {
    let mut h = Sha256::new();
    frame(&mut h, "task-dag-v2-framing-1");
    frame(&mut h, domain);
    h.update((parts.len() as u64).to_be_bytes());
    for p in parts {
        frame(&mut h, p);
    }
    format!("{:x}", h.finalize())
}
fn frame(h: &mut Sha256, value: &str) {
    h.update((value.len() as u64).to_be_bytes());
    h.update(value.as_bytes());
}
pub(crate) fn digest(value: &str) -> String {
    framed_digest("digest", &[value])
}
pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.len() == 67
        && id.starts_with("v2-")
        && id[3..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(format!(
            "invalid Task-ID {id}; expected v2- plus 64 lowercase hex characters"
        ))
    }
}
pub(crate) fn oid(value: &str) -> Result<()> {
    if value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(format!("invalid lowercase full Git OID: {value}"))
    }
}
pub(crate) fn nonempty(name: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(())
    }
}
pub(crate) fn bounded(name: &str, value: &str, max: usize) -> Result<()> {
    nonempty(name, value)?;
    if value.len() > max {
        Err(format!("{name} exceeds {max} bytes"))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_claim(value: Value, token: &str, id: &str, now: u64) -> Result<ClaimRecord> {
    let claim: ClaimRecord =
        serde_json::from_value(value).map_err(|e| format!("active claim malformed: {e}"))?;
    if claim.claim_token != token {
        return Err("claim token does not match active claim".into());
    }
    if claim.task_id != id || claim.expires_at <= now || claim.claimed_at > now {
        return Err("claim token identifies a wrong or expired claim".into());
    }
    oid(&claim.task_oid)?;
    bounded("claim owner", &claim.owner, 256)?;
    bounded("claim host", &claim.host, 256)?;
    bounded("claim session", &claim.session_id, 256)?;
    Ok(claim)
}

pub(crate) fn validate_reap_claim(value: Value, id: &str, now: u64) -> Result<ClaimRecord> {
    let claim: ClaimRecord =
        serde_json::from_value(value).map_err(|e| format!("active claim malformed: {e}"))?;
    valid_id(id)?;
    if claim.task_id != id || claim.claimed_at > claim.expires_at || claim.expires_at > now {
        return Err("reap requires a complete expired claim for the requested Task-ID".into());
    }
    oid(&claim.task_oid)?;
    bounded("claim token", &claim.claim_token, 256)?;
    bounded("claim owner", &claim.owner, 256)?;
    bounded("claim host", &claim.host, 256)?;
    bounded("claim session", &claim.session_id, 256)?;
    Ok(claim)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    proptest! {
        #[test] fn ids_are_deterministic_grammatical_and_domain_separated(a in "[a-zA-Z0-9_-]{1,40}", b in "[a-zA-Z0-9_-]{1,40}") { let root=task_id("root",&[&a]); let again=task_id("root",&[&a]); let child=task_id("child",&[&a,&b]); prop_assert_eq!(&root,&again); prop_assert!(valid_id(&root).is_ok()); prop_assert!(valid_id(&child).is_ok()); prop_assert_ne!(root,child); }
        #[test] fn update_sort_and_digest_are_stable(names in prop::collection::vec("refs/heads/tasks/(active|done)/v2-[a-f0-9]{64}",1..20)) { let updates:Vec<_>=names.into_iter().map(|n|Update{semantic_ref:n,old:None,new:Some("0123456789012345678901234567890123456789".into())}).collect(); let a=canonical_updates(updates.clone()); let b=canonical_updates(updates); prop_assert_eq!(digest(&serde_json::to_string(&a).unwrap()),digest(&serde_json::to_string(&b).unwrap())); prop_assert!(a.windows(2).all(|w|w[0].semantic_ref<=w[1].semantic_ref)); }
        #[test] fn lifecycle_parser_ignores_v1_and_exclusivity_is_exact(hex in "[a-f0-9]{64}") { let id=format!("v2-{hex}"); let mut refs=BTreeMap::new(); refs.insert(state_ref("frontier",&id),"0".repeat(40)); let s=Snapshot{refs}; prop_assert_eq!(lifecycle(&s,&id).len(),1); prop_assert!(parse_state_ref("refs/heads/tasks/frontier/abc","frontier").is_some()); prop_assert!(valid_id("abc").is_err()); }
        #[test] fn child_ids_unique_and_dependencies_resolve(parent in "v2-[a-f0-9]{64}", op in "[a-z]{1,20}", keys in prop::collection::btree_set("[a-z]{1,12}",1..10)) { let ids:BTreeMap<_,_>=keys.iter().map(|k|(k.clone(),task_id("child",&[&parent,&op,k]))).collect(); prop_assert_eq!(ids.values().collect::<BTreeSet<_>>().len(),ids.len()); for k in &keys { prop_assert_eq!(&resolve_requirements(std::slice::from_ref(k),&ids).unwrap()[0],&ids[k]); } }
        #[test] fn framing_separates_component_boundaries(a in "[a-z]{1,30}", b in "[a-z]{1,30}", c in "[a-z]{1,30}") { prop_assert_ne!(framed_digest("x", &[&format!("{a}{b}"), &c]), framed_digest("x", &[&a, &format!("{b}{c}")])); prop_assert_ne!(framed_digest("x", &[&a,&b]), framed_digest("y", &[&a,&b])); }
    }
}
