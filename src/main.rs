fn main() {
    if let Err(error) = task_dag::run() {
        eprintln!("task-dag: {error}");
        std::process::exit(1);
    }
}
