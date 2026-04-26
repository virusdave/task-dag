# AGENTS

Before doing any work under this directory, read and follow `AGENTS_MUST_KNOW.md`.

The sales-reconciliation database has been cut over to the new production Tiger Data / Timescale service and the old local Postgres container is now shut down. For any upcoming code, SQL, or configuration work that touches that database, migrate to the production service immediately, stop using localhost assumptions or the retired local password file, and load the current connection details from the local secret material under `~amp-local/.secret/tigerdata/`.

This directory keeps a structured knowledgebase. Start with `docs/README.md` for the full map or `HOW_KNOWLEDGEBASE_WORKS.md` for the canonical organization and maintenance rules. When the domain is already clear, you can start from the matching short `HOW_<DOMAIN>_WORKS.md` entry index and then load only the linked `docs/<domain>/README.md` or narrower task doc.

Before using any LLM path in this workspace - including Oracle, Painter, Bedrock Mantle, LibreChat-backed model access, or a proposed new backend/model - consult `HOW_PRIVATE_LLM_ACCESS_WORKS.md` and `config/llm_use/registry.yaml` first. If the intended model/backend is not already approved or explicitly recorded as a limited trial for that use case, update the registry before proceeding.

If a task touches functionality Helios has already subsumed, work in `bulk_additions/catalog_curation/` rather than extending or reviving a bespoke webapp. Use `HOW_HELIOS_WORKS.md` to confirm what is already migrated. Standalone scripts may still remain as worker adapters or underlying execution engines, but new operator-facing behavior for migrated workflows belongs in Helios unless the user explicitly asks otherwise.

When the user says "handoff", update `AGENT_TODO.md` in the current working directory with the current state, the immediate next steps, and the larger goal so the work is ready for agent handoff. If `AGENT_TODO.md` does not exist in the current working directory yet, create it there instead of using a parent-directory handoff file.

When the user says "resume", treat it as a standing instruction to proceed with implementation instead of stopping at planning, and use `page-dave` on completion or on unrecoverable failure. Continue following the required Sweed dealer-reset and site-scoped verification rules from `AGENTS_MUST_KNOW.md` and the relevant `docs/sweed/` task doc.

If you learn something durable about Sweed, update the relevant `docs/sweed/` task doc and keep the `HOW_SWEED_WORKS.md` index accurate; if the learning is especially important, update `AGENTS_MUST_KNOW.md` as well. Apply the same pattern for Lit Alerts findings under `docs/litalerts/` and `HOW_LITALERTS_WORKS.md`.

Do not ignore `AGENTS_MUST_KNOW.md`. It is required reading for agents working here.
