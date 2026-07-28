use crate::Result;

pub(crate) fn fail(command: &str) -> Result<()> {
    Err(format!(
        "unsupported in minimal v2: {command}; use task-dag create, breakdown, block, unblock, deps, context, frontier, or blocked as appropriate; no network or mutation was attempted"
    ))
}
