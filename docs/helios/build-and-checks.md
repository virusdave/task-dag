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

`check` is the decided "master always green" mechanism for now (design
decision 5; a hosted-CI backstop + branch protection is deferred Phase 4,
`virusdave/top-level#23`). It runs, in order:

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

## Related scripts

- `npm run typecheck` / `npm run typecheck:client` — run a single
  typecheck in isolation.
- `npm run test` / `npm run test:db` — unit suite, with the latter
  enabling DB-backed tests (`HELIOS_TEST_DB=1`).
- `npm run build` / `build:server` / `build:client` — production build.
