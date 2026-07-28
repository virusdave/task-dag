pub(crate) mod blocked;
pub(crate) mod bootstrap;
pub(crate) mod breakdown;
pub(crate) mod claim;
pub(crate) mod claim_lifecycle;
pub(crate) mod completion;
pub(crate) mod readers;
pub(crate) mod unsupported;

use crate::Result;
use serde_json::Value;
use std::{
    fs::File,
    io::Read,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(feature = "test-seam")]
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn timestamp() -> Result<u64> {
    #[cfg(feature = "test-seam")]
    if let Ok(value) = std::env::var("TASKDAG_TEST_TIME") {
        return value
            .parse()
            .map_err(|_| "TASKDAG_TEST_TIME must be u64".into());
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|e| e.to_string())
}
pub(crate) fn claim_token() -> Result<String> {
    #[cfg(feature = "test-seam")]
    if let Ok(value) = std::env::var("TASKDAG_TEST_TOKEN") {
        static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
        model_token(&value)?;
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        return if n == 0 {
            Ok(value)
        } else {
            Ok(crate::model::framed_digest(
                "test-claim-token",
                &[&value, &n.to_string()],
            ))
        };
    }
    let mut bytes = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("secure claim token generation from /dev/urandom failed: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
#[cfg(feature = "test-seam")]
fn model_token(value: &str) -> Result<String> {
    if value.len() >= 16
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        Ok(value.into())
    } else {
        Err("test token is invalid".into())
    }
}
pub(crate) fn identity() -> (String, String) {
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-host".into());
    let session =
        std::env::var("TASKDAG_SESSION_ID").unwrap_or_else(|_| format!("pid-{}", process::id()));
    (host, session)
}

pub(crate) fn checked_identity(owner: &str) -> Result<(String, String)> {
    crate::model::bounded("claim owner", owner, 256)?;
    let (host, session) = identity();
    crate::model::bounded("claim host", &host, 256)?;
    crate::model::bounded("claim session", &session, 256)?;
    Ok((host, session))
}
pub(crate) fn default_owner() -> String {
    std::env::var("USER").unwrap_or_else(|_| "task-dag-bootstrap".into())
}
pub(crate) fn print_json(value: &Value) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|e| e.to_string())?
    );
    Ok(())
}
