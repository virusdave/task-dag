# Git Hooks

This directory contains git hooks to prevent common workflow errors.

## Installation

Run the install script:

```bash
.github/hooks/install-hooks.sh
```

## Hooks

### pre-commit

Validates GitHub Actions workflow references before commit:

- Checks that referenced external workflows use valid branches/tags/commits
- Prevents committing workflows that reference non-existent branches (e.g., `@main` when repo uses `@master`)
- Requires GitHub CLI (`gh`) to be installed and authenticated

## Requirements

- [GitHub CLI](https://cli.github.com/) installed and authenticated
- Network access to validate references against GitHub API
