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

-- Table 3: Per-project To-Do items (for cron todo wake-up)
CREATE TABLE IF NOT EXISTS project_todos (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  chat_id     TEXT DEFAULT '',
  title       TEXT NOT NULL,
  time        TIMESTAMPTZ,
  creator     TEXT DEFAULT 'user',
  triggered   BOOLEAN DEFAULT false,
  done        BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todos_wake ON project_todos(project_id, triggered, time);

-- Disable RLS (backend-only access via service_role key)
ALTER TABLE project_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_state DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_todos DISABLE ROW LEVEL SECURITY;

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

-- Table 4: Chat messages for cloud-synced conversation history
-- Frontend syncs messages after each round; Cron pulls real messages for proactive context.
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,  -- frontend-generated msg id, dedup key
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  token_usage INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_window ON chat_messages(project_id, window_id, created_at);
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;
GRANT ALL ON chat_messages TO PUBLIC;

-- RPC: Atomic partial update of daily-count fields within project_configs JSONB.
-- Touches only _dailyWakeCount, _dailyDesireCount, _dailyEmailCount, _lastWakeResetDate
-- without affecting other keys — eliminating read-modify-write races with frontend syncs.
CREATE OR REPLACE FUNCTION atomic_update_daily_counts(
  payload JSONB
) RETURNS VOID AS $$
DECLARE
  p_project_id           TEXT  := payload->>'p_project_id';
  p_daily_wake_count     INT   := (payload->>'p_daily_wake_count')::INT;
  p_daily_desire_count   INT   := (payload->>'p_daily_desire_count')::INT;
  p_daily_email_count    INT   := (payload->>'p_daily_email_count')::INT;
  p_last_wake_reset_date TEXT  := payload->>'p_last_wake_reset_date';
BEGIN
  UPDATE project_configs
  SET config = config
    || jsonb_build_object('_dailyWakeCount', to_jsonb(p_daily_wake_count))
    || jsonb_build_object('_dailyDesireCount', to_jsonb(p_daily_desire_count))
    || jsonb_build_object('_dailyEmailCount', to_jsonb(p_daily_email_count))
    || jsonb_build_object('_lastWakeResetDate', to_jsonb(p_last_wake_reset_date)),
    updated_at = NOW()
  WHERE project_id = p_project_id;
END;
$$ LANGUAGE plpgsql;

-- Grant access
GRANT ALL ON project_configs TO PUBLIC;
GRANT ALL ON app_state TO PUBLIC;
GRANT ALL ON project_todos TO PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
