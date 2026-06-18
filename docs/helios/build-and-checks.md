# Helios build & check scripts

Phase 3 build-hygiene reference for the Helios app (`helios/`). Tracks
[FreshlyBakedNYC/automation#50](https://github.com/FreshlyBakedNYC/automation/issues/50)
(child of `virusdave/top-level#22`).

## `npm run check` — the required pre-push gate

Run from `helios/` before every `git push` that touches `helios/`:

```sh
cd helios
npm run check
```

`check` is what the CI `helios` job runs (`.github/workflows/ci.yml`)
on every push to `master` and on PRs, and what you run locally before a
`helios/`-touching push. The hosted-CI backstop has since landed; branch
protection / a *blocking* required status is still unavailable on this
repo (GitHub free-plan 403), so CI is advisory and the pre-commit hook
remains the only pre-master enforcement — see the AGENTS.md "Dev-loop
checks" / "Interim CI-enforcement exception" sections for the full
two-gate picture and the focused/targeted local commands. `check` runs,
in order:

| Step | Script | What it does |
| --- | --- | --- |
| 1 | `typecheck` | `tsc -p tsconfig.server.json --noEmit` — strict server typecheck (also the artifact prod runs). |
| 2 | `typecheck:client` | `tsc -p tsconfig.client.json --noEmit` — strict browser-bundle typecheck. |
| 3 | `test` | `vitest run` — the full unit suite. |

Both typechecks are **incremental** (`tsconfig.json` sets
`incremental` + `composite`, and each project config names a
`tsBuildInfoFile`), so warm runs reuse the on-box `.tsbuildinfo` and only
re-check what changed. The `.tsbuildinfo` files are git-ignored and
persist between runs on the box.

`check` deliberately does **not** run `vite build` (the client bundle is
OOM-prone and slow — see `helios/AGENTS.md`); a full build is a Phase 4
CI concern. When you do need a full client build locally, use the heap
flag documented in `helios/AGENTS.md`:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run build
```

## `ensure-build-env` — idempotent, self-prerequisite build env

`scripts/ensure-build-env.sh` (`npm run ensure-build-env`) owns the build
prerequisites and is safe to run cold (fresh checkout) or warm:

- `npm install` (against the on-box `~/.npm` cache) when `node_modules`
  is absent, a dangling symlink, or stale relative to `package.json`.
  Helios deliberately does **not** track a `package-lock.json` and the
  host deploy uses `npm install` (not `npm ci`) — see `.gitignore` — so
  `ensure-build-env` mirrors that.
- `mkdir -p` every output dir the build / asset-copy steps assume
  (`dist/server`, `dist/server/worker/scheduling`, `dist/client`).

It is wired in so no build step fails on a missing dependency or dir:

- `build` runs it first (via the `prebuild` lifecycle hook),
- `test` runs it first (via the `pretest` lifecycle hook),
- `check` runs it explicitly before the typechecks.

When warm it is a fast no-op (`…present and current; skipping install`).

## `check:idempotence` — reproducible-build matrix (nightly / manual)

`scripts/idempotence-matrix.sh` (`npm run check:idempotence`) proves the
build is reproducible across the artifact states that bite in practice —
cold checkout, warm `node_modules`, stale `dist`, and post-`git clean
-xfd` — running the verification command twice where it matters. It works
in a **throwaway local clone** (it runs `git clean -xfd`, which would
otherwise nuke your in-tree `node_modules`/`dist`).

This is a heavy nightly/manual gate, **not** part of the default `vitest`
suite. Run it under the shared large-action-lock:

```sh
large-action-lock -- bash helios/scripts/idempotence-matrix.sh
```

The verification command defaults to the full `npm run check`; override
it for a fast harness smoke: `IDEMPOTENCE_VERIFY='npm run ensure-build-env && npm run typecheck'`.

## `nix develop` — reproducible toolchain (flake.nix)

The repo-root `flake.nix` exposes a devShell that pins the build
toolchain (node + npm via `nodejs_22`) so the same versions are available
locally, on the box, and in any future off-prod builder:

```sh
nix develop          # drops you into a shell with node 22 + npm pinned
cd helios && npm run check
```

`nixpkgs` is pinned (see `flake.lock`) to the revision the production box
already runs, so `nix develop` reuses the on-box Nix store rather than
fetching a different toolchain. The devShell provides the **toolchain**;
`ensure-build-env` provides the **project prerequisites** — together they
give an identical, declarative build environment.

## Related scripts

- `npm run typecheck` / `npm run typecheck:client` — run a single
  typecheck in isolation.
- `npm run test` / `npm run test:db` — unit suite, with the latter
  enabling DB-backed tests (`HELIOS_TEST_DB=1`).
- `npm run build` / `build:server` / `build:client` — production build.
