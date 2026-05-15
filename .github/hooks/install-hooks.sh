#!/usr/bin/env bash
# Install git hooks from .github/hooks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR="$(git rev-parse --git-dir)"

echo "Installing git hooks..."

# Link pre-commit hook
if [ -f "$SCRIPT_DIR/pre-commit" ]; then
    ln -sf "$SCRIPT_DIR/pre-commit" "$GIT_DIR/hooks/pre-commit"
    chmod +x "$GIT_DIR/hooks/pre-commit"
    echo "✓ Installed pre-commit hook"
fi

echo "✓ Git hooks installed successfully"
echo ""
echo "Note: The pre-commit hook validates workflow references using 'gh' CLI."
echo "Make sure you have GitHub CLI installed: https://cli.github.com/"
