-- WarmBuddy Supabase Schema
-- Run this in Supabase SQL Editor after creating your project

-- Table 1: Per-project API configs + desire state (for cron wake-up)
CREATE TABLE IF NOT EXISTS project_configs (
  project_id  TEXT PRIMARY KEY,
  config      JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Key-value store for app-level state (push subscription, etc.)
CREATE TABLE IF NOT EXISTS app_state (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Disable RLS (backend-only access via service_role key)
ALTER TABLE project_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_state DISABLE ROW LEVEL SECURITY;

-- Table 3: Atomic partial update of desire state fields within project_configs JSONB
-- This function only touches _desireState, _lastBackendGrowth, _lastTriggerTime, _lastTriggerDrive
-- without affecting other keys (apiKey, endpoint, etc.) — eliminating read-modify-write races.
-- NOTE: Single JSONB payload avoids Supabase RPC alphabetic parameter reordering bug.
CREATE OR REPLACE FUNCTION atomic_update_desire_state(
  payload JSONB
) RETURNS VOID AS $$
DECLARE
  p_project_id         TEXT   := payload->>'p_project_id';
  p_desire_state       JSONB  := payload->'p_desire_state';
  p_last_backend_growth TEXT  := payload->>'p_last_backend_growth';
  p_last_trigger_time  TEXT   := payload->>'p_last_trigger_time';
  p_last_trigger_drive TEXT   := payload->>'p_last_trigger_drive';
BEGIN
  UPDATE project_configs
  SET config = config
    || jsonb_build_object('_desireState', p_desire_state)
    || jsonb_build_object('_lastBackendGrowth', to_jsonb(p_last_backend_growth))
    || CASE WHEN p_last_trigger_time IS NOT NULL AND p_last_trigger_time != ''
       THEN jsonb_build_object('_lastTriggerTime', to_jsonb(p_last_trigger_time))
       ELSE '{}'::jsonb END
    || CASE WHEN p_last_trigger_drive IS NOT NULL AND p_last_trigger_drive != ''
       THEN jsonb_build_object('_lastTriggerDrive', to_jsonb(p_last_trigger_drive))
       ELSE '{}'::jsonb END,
    updated_at = NOW()
  WHERE project_id = p_project_id;
END;
$$ LANGUAGE plpgsql;

-- Grant access
GRANT ALL ON project_configs TO PUBLIC;
GRANT ALL ON app_state TO PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
