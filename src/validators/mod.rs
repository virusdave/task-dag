mod delegation;
mod delegation_completion;
mod lifecycle;
mod system;
mod task;

pub(crate) use delegation::{admission, intent};
pub(crate) use delegation_completion::{accepted, export};
pub(crate) use lifecycle::{current_lifecycle, lifecycle, waiting};
pub(crate) use system::{activation, activation_identity, current_system, journal};
pub(crate) use task::task;

use crate::{Result, git, model};
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) fn object(
    object: &str,
    kind: &str,
    required: &[&str],
    variants: &[&[&str]],
) -> Result<Value> {
    model::oid(object)?;
    let value = git::object_json(object)?;
    let map = value
        .as_object()
        .ok_or_else(|| format!("{kind} record is not an object"))?;
    let keys: BTreeSet<&str> = map.keys().map(String::as_str).collect();
    let valid = variants.iter().any(|extra| {
        required
            .iter()
            .chain(extra.iter())
            .copied()
            .collect::<BTreeSet<_>>()
            == keys
    });
    if !valid {
        return Err(format!("{kind} record has missing or unknown fields"));
    }
    if value["formatVersion"] != 2 {
        return Err(format!("{kind} formatVersion is not 2"));
    }
    Ok(value)
}

pub(super) fn digest(name: &str, value: &Value) -> Result<()> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{name} is not a string"))?;
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(format!("{name} is not 64 lowercase hex"));
    }
    Ok(())
}

pub(super) fn id_oid(value: &Value, id_key: &str, oid_key: &str, expected: &str) -> Result<String> {
    let id = value[id_key]
        .as_str()
        .ok_or_else(|| format!("{id_key} malformed"))?;
    model::valid_id(id)?;
    if id != expected {
        return Err(format!("{id_key} does not match ref identity"));
    }
    let oid = value[oid_key]
        .as_str()
        .ok_or_else(|| format!("{oid_key} malformed"))?;
    model::oid(oid)?;
    Ok(oid.into())
}
