mod cli;
mod commands;
mod git;
mod journal;
mod model;
mod receipts;
mod repository;
mod validators;

pub type Result<T> = std::result::Result<T, String>;

pub fn run() -> Result<()> {
    cli::run()
}

pub(crate) fn runtime() -> Result<String> {
    let value = env!("TASKDAG_BUILD_COMMIT").to_owned();
    model::oid(&value)?;
    Ok(value)
}
