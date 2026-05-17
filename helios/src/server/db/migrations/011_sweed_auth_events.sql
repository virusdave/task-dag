-- Migration 011: Sweed Auth Event Log
-- Adds the sweed_auth_events table workers append to whenever they
-- touch a Sweed auth-related JSON-RPC (login / logout / dealer-set /
-- initial-data / any RPC that returned an auth error).

\echo 'Running migration 011: Sweed Auth Event Log...'

\i ../schema/sweedAuthEvents.sql

\echo 'Migration 011 complete.'
