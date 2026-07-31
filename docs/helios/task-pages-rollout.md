# Helios task pages rollout

Issue: [automation#89](https://github.com/FreshlyBakedNYC/automation/issues/89)

## Production evidence

- Completion deployed: [`8d095394`](https://github.com/FreshlyBakedNYC/automation/commit/8d095394cdacc30b503c4a955849ab2b0c29c1f9)
- Deployment: `self-deploy-helios` completed its mirror-aware peer and local rollout on 2026-07-24; `helios-server` and `helios-worker` were active and the public `/healthzz` endpoint returned HTTP 200 afterward.
- CI: [CI run 30139569128](https://github.com/FreshlyBakedNYC/automation/actions/runs/30139569128) and [Task-DAG run 30139569249](https://github.com/FreshlyBakedNYC/automation/actions/runs/30139569249) passed for the deployed completion.
- Oracle: approved the final task overview, queue, detail, and plan implementation after review of task semantics, accessibility, mobile controls, and capture readiness.
- Served review: the [operator's final desktop capture](https://vpn-helios.freshlybaked.us/one-offs/FSnMWdCB__wvUMBiln7pu1goNj4/capture.png) (captured 2026-07-25 at 02:22 UTC; expires 2026-07-26 at 02:22 UTC) passed visual review. It shows the compact navigation and summaries, wrapped non-colliding titles, consistent statuses, and scoped actions. The black area after the content is an `html-to-image` serializer artifact rather than browser layout.

## Remaining capture-workflow finding

The served page itself passed review, but the operator's narrower mobile capture exceeded the capture workflow's size limit. The [operator report](https://github.com/FreshlyBakedNYC/automation/issues/89#issuecomment-5076396996) also notes that the current `too_big` error offers neither useful guidance nor a compression fallback. This is capture-workflow follow-up work, not evidence of a task-page rendering failure.

## Native task-dag v2 activation, 2026-07-31

- Application revision: [`6e7e3b74`](https://github.com/FreshlyBakedNYC/automation/commit/6e7e3b74429478791a2d3926e9d308934dfbd968).
- Fleet configuration revision: [`ad13a7fc`](https://github.com/Nicponskis/nixos-sbc/commit/ad13a7fced9ca0bc6b52645e9aa73439988475cd).
- Runtime: both the primary and backend-only `helios-server` units use `/nix/store/jyxgygnsndf18srd8fa71md594il09pc-task-dag-0.1.0/bin/task-dag`, the immutable package for canonical runtime commit `da154d3be58a7d1a7ca602bbad49271d403339b2`.
- Activation: the configured eight-repository fleet advertised digest `0ce345181e6be88e122738262a54ee112c6e1eb8790f68ced67c689f1ce5a07b`. Representative activation/journal OIDs were automation `3db377e3`/`90a16457`, nixos-sbc `0ccd3313`/`a88d1931`, task-dag `3b582168`/`f5e29703`, and top-level `3b401dd8`/`9ed4f966`.
- Deployment: the revision-pinned `self-deploy-helios-system` controller activated the NixOS revision on vps-nixos-2 and vps-nixos-3 while preserving healthy mirror routing. `self-deploy-helios` then deployed the application artifact to both peers and returned both to local serving mode.
- Service readback: `helios-prep` exited successfully on both peers; both `helios-server` units and the primary `helios-worker` were active. `https://helios.freshlybaked.us/healthzz` returned HTTP 200 with `X-Helios-Served-From: local`.
- Refresh readback: a server-owned `git fetch --prune --filter=blob:none origin +refs/heads/*:refs/heads/*` was observed at `2026-07-31T06:27:02-05:00`, inside the configured 60-second refresh cadence, without a service restart.
- Representative native identities: automation `v2-e02fd68a392788cef9d71763c5a72cc21ca825946eac53b657fb1c5b6d634d2c`, task-dag `v2-b0bc9903ee2465afb95ea556c2fce4c18d7c052fb97803de710b1f788a01b410`, and top-level `v2-803c5266a4715be5ce9b449f6668abb0ce1275a38291a3dee0c94cd4a649539e` were returned by the canonical v2 frontier reader. The production bundle's overview, queue, detail, and plan routes use repository plus full Task-ID; focused route tests cover copied IDs, lifecycle evidence, root exclusion, navigation refresh, stale data, malformed state, partial repository coverage, and rejection of v1-only refs.
- Quality gates: Helios `npm run check` passed 2,746 tests with 28 skips, the production client/server build passed with 8 GiB Node heap, focused post-rebase v2 tests passed, `nix flake check --no-build` passed, both production host evaluations contained the same immutable runtime, and final critical-infrastructure and UI reviews approved the changes.
- Rollback boundary: roll the application back with the canonical `self-deploy-helios` wrapper after reverting the automation commits. Roll the packaged runtime back only through a revision-pinned `self-deploy-helios-system` activation of the prior nixos-sbc revision. No database or task-dag lifecycle mutation is required for either rollback.
