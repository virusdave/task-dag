# ⚠️ TEMPORARY — move `.github2/workflows/` → `.github/workflows/`

These reusable workflow YAMLs were staged under `.github2/workflows/`
because GitHub refuses to let a deploy key (or a `workflow`-scope-less
token) push files under `.github/workflows/`. **Action required:** move
the four files in `.github2/workflows/` to `.github/workflows/` (web UI,
or a push from a credential with `workflow` scope), then delete this
`.github2/` directory. Until then the reusable workflows are inert — no
peer references them yet, so nothing is affected.
