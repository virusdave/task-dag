fn main() {
    if let Err(error) = task_dag::run() {
        eprintln!(
            "{}",
            serde_json::to_string(&serde_json::json!({"error":error}))
                .expect("error JSON serialization is infallible")
        );
        std::process::exit(1);
    }
}
