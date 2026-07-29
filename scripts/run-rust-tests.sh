#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/run-rust-tests.sh [CARGO_TEST_ARGUMENT ...]

Run every native Rust test through the repository's pinned Nix development
environment. Additional arguments are forwarded to `cargo test`, so the same
command runs selected tests, for example:

  scripts/run-rust-tests.sh property_name
  scripts/run-rust-tests.sh -- --list
EOF
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
nix develop --command cargo build --locked
export TASKDAG_TEST_COMPILED_COMMIT=${TASKDAG_TEST_COMPILED_COMMIT:-$(git rev-parse HEAD)}
exec nix develop --command cargo test --locked --features test-seam "$@"
