-- Down for 082: no-op. We do not restore the old "Seeded with
-- migration 079." boilerplate; reverting a copy reword has no value and
-- could clobber a hand-edited note.

\set ON_ERROR_STOP on

\echo 'Migration 082 down: intentional no-op (reworded note is not restored).'
