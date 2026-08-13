use std::{process::Command, time::Instant};

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_task-dag"))
        .args(args)
        .output()
        .expect("run task-dag")
}

fn folded_samples(stderr: &[u8]) -> Vec<(&str, u128)> {
    std::str::from_utf8(stderr)
        .expect("timings are UTF-8")
        .lines()
        .map(|line| {
            let (stack, nanos) = line.rsplit_once(' ').expect("folded stack sample");
            let nanos = nanos.parse().expect("nanosecond sample");
            (stack, nanos)
        })
        .collect()
}

#[test]
fn timings_are_opt_in_and_preserve_stdout() {
    let plain = run(&["runtime", "identity"]);
    assert!(plain.status.success());
    assert!(plain.stderr.is_empty());

    let started = Instant::now();
    let timed = run(&["--timings", "runtime", "identity"]);
    let wall_nanos = started.elapsed().as_nanos();
    assert!(timed.status.success());
    assert_eq!(timed.stdout, plain.stdout);

    let samples = folded_samples(&timed.stderr);
    assert!(!samples.is_empty());
    assert!(
        samples
            .iter()
            .all(|(stack, _)| stack.starts_with("all-threads; invocation"))
    );
    assert!(
        samples
            .iter()
            .any(|(stack, _)| stack.contains("command.runtime-identity"))
    );
    assert!(
        samples
            .iter()
            .any(|(stack, _)| stack.contains("runtime.identity"))
    );

    let root_self = samples
        .iter()
        .filter(|(stack, _)| *stack == "all-threads; invocation")
        .try_fold(0_u128, |total, (_, nanos)| total.checked_add(*nanos))
        .expect("root timing sum");
    let descendants = samples
        .iter()
        .filter(|(stack, _)| *stack != "all-threads; invocation")
        .try_fold(0_u128, |total, (_, nanos)| total.checked_add(*nanos))
        .expect("descendant timing sum");
    let invocation_nanos = samples
        .iter()
        .try_fold(0_u128, |total, (_, nanos)| total.checked_add(*nanos))
        .expect("invocation timing sum");
    assert_eq!(root_self.checked_add(descendants), Some(invocation_nanos));
    assert!(descendants > 0);
    assert!(invocation_nanos <= wall_nanos);
}

#[test]
fn timings_are_global_and_help_remains_effect_free() {
    let timed = run(&["runtime", "--timings", "identity"]);
    assert!(timed.status.success());
    assert!(!folded_samples(&timed.stderr).is_empty());

    for args in [
        &["--timings", "--help"][..],
        &["runtime", "--timings", "--help"][..],
    ] {
        let help = run(args);
        assert!(help.status.success());
        assert!(help.stderr.is_empty());
        assert!(String::from_utf8_lossy(&help.stdout).contains("Usage:"));
    }
}
