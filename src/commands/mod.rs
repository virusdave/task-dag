pub(crate) mod blocked;
pub(crate) mod bootstrap;
pub(crate) mod breakdown;
pub(crate) mod claim;
pub(crate) mod claim_lifecycle;
pub(crate) mod claim_recovery;
pub(crate) mod comment;
pub(crate) mod completion;
pub(crate) mod delegation;
pub(crate) mod delegation_accept;
pub(crate) mod delegation_admit;
pub(crate) mod delegation_export;
pub(crate) mod delegation_status;
pub(crate) mod guards;
pub(crate) mod readers;
pub(crate) mod unsupported;

use crate::Result;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use rustix::fs::{Mode, OFlags};

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

pub(crate) fn release_claim_token(argument: Option<String>, path: Option<&Path>) -> Result<String> {
    let token = match (argument, path) {
        (Some(value), None) => value,
        (None, Some(path)) => {
            let before = fs::symlink_metadata(path)
                .map_err(|e| format!("cannot inspect claim-token file: {e}"))?;
            let effective_uid = rustix::process::geteuid().as_raw();
            if !before.file_type().is_file()
                || before.permissions().mode() & 0o7777 != 0o600
                || before.uid() != effective_uid
                || before.len() > 256
            {
                return Err(
                    "claim-token file must be an owner-private mode-0600 regular file of at most 256 bytes"
                        .into(),
                );
            }
            let descriptor = rustix::fs::open(
                path,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|e| format!("cannot open claim-token file: {e}"))?;
            let mut file = File::from(descriptor);
            let opened = file
                .metadata()
                .map_err(|e| format!("cannot inspect opened claim-token file: {e}"))?;
            if !opened.is_file()
                || opened.permissions().mode() & 0o7777 != 0o600
                || opened.uid() != effective_uid
                || (before.dev(), before.ino()) != (opened.dev(), opened.ino())
            {
                return Err("claim-token file changed before it was opened".into());
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(257)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("cannot read claim-token file: {e}"))?;
            if bytes.len() > 256 {
                return Err("claim-token file exceeds 256 bytes".into());
            }
            String::from_utf8(bytes).map_err(|_| "claim-token file is not UTF-8")?
        }
        _ => return Err("exactly one claim-token input is required".into()),
    };
    crate::model::bounded("claim token", &token, 256)?;
    Ok(token)
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
