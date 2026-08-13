use tracing_flame::FlameLayer;
use tracing_subscriber::{prelude::*, registry::Registry};

use crate::Result;

pub(crate) fn init() -> Result<()> {
    let layer = FlameLayer::new(std::io::stderr())
        .with_empty_samples(false)
        .with_threads_collapsed(true)
        .with_module_path(false)
        .with_file_and_line(false);
    tracing::subscriber::set_global_default(Registry::default().with(layer))
        .map_err(|error| format!("initialize timing subscriber: {error}"))
}
