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

-- Table 4b: Canonical LLM token usage events.
-- One row represents one upstream LLM call; multi-call interactions share interaction_id.
CREATE TABLE IF NOT EXISTS token_usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  window_id TEXT NOT NULL DEFAULT '',
  interaction_id TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'single',
  model TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL DEFAULT 'unknown',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  is_estimated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_token_usage_window_created ON token_usage_events(window_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_project_created ON token_usage_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_interaction ON token_usage_events(interaction_id);
ALTER TABLE token_usage_events DISABLE ROW LEVEL SECURITY;
GRANT ALL ON token_usage_events TO PUBLIC;

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

-- Table 5: System events for proactive behavior audit log (frontend polling source)
CREATE TABLE IF NOT EXISTS system_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_id TEXT DEFAULT '',
  type TEXT NOT NULL,
  drive_key TEXT,
  content TEXT DEFAULT '',
  push_sent BOOLEAN DEFAULT false,
  ntfy_sent BOOLEAN DEFAULT false,
  ntfy_attempts INTEGER NOT NULL DEFAULT 0,
  ntfy_last_error TEXT,
  ntfy_sent_at TIMESTAMPTZ,
  ntfy_message_id TEXT,
  todo_id TEXT,
  todo_title TEXT,
  post_decay_value INTEGER,
  has_context BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_events_project ON system_events(project_id, created_at);
ALTER TABLE system_events DISABLE ROW LEVEL SECURITY;
GRANT ALL ON system_events TO PUBLIC;

-- ntfy delivery state for existing installations
ALTER TABLE system_events ADD COLUMN IF NOT EXISTS ntfy_sent BOOLEAN DEFAULT false;
ALTER TABLE system_events ADD COLUMN IF NOT EXISTS ntfy_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE system_events ADD COLUMN IF NOT EXISTS ntfy_last_error TEXT;
ALTER TABLE system_events ADD COLUMN IF NOT EXISTS ntfy_sent_at TIMESTAMPTZ;
ALTER TABLE system_events ADD COLUMN IF NOT EXISTS ntfy_message_id TEXT;

-- Table 6: Litter box thoughts (AI's unfiltered inner monologue)
CREATE TABLE IF NOT EXISTS litter_thoughts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_id TEXT DEFAULT '',
  content TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  source_window TEXT DEFAULT '',
  proactive BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_litter_thoughts_project ON litter_thoughts(project_id, created_at);
ALTER TABLE litter_thoughts DISABLE ROW LEVEL SECURITY;
GRANT ALL ON litter_thoughts TO PUBLIC;

-- Table 7: Diary entries (AI's private journal)
CREATE TABLE IF NOT EXISTS diary_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_id TEXT DEFAULT '',
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  title TEXT DEFAULT '',
  content TEXT NOT NULL,
  mood TEXT DEFAULT 'calm',
  author TEXT DEFAULT 'ai',
  proactive BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  visibility_mode TEXT NOT NULL DEFAULT 'selected',
  visible_chat_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  replies JSONB NOT NULL DEFAULT '[]'::jsonb
);
-- Keep existing installations compatible: CREATE TABLE IF NOT EXISTS does not add new columns.
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS visibility_mode TEXT NOT NULL DEFAULT 'selected';
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS visible_chat_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS replies JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_diary_entries_project ON diary_entries(project_id, created_at);
ALTER TABLE diary_entries DISABLE ROW LEVEL SECURITY;
GRANT ALL ON diary_entries TO PUBLIC;

-- Diary delivery records. Each share creates a new row, including after consumption.
CREATE TABLE IF NOT EXISTS diary_deliveries (
  id TEXT PRIMARY KEY,
  diary_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  target_chat_id TEXT NOT NULL,
  delivery_type TEXT NOT NULL DEFAULT 'share',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_diary_deliveries_target ON diary_deliveries(target_project_id, target_chat_id, status);
ALTER TABLE diary_deliveries DISABLE ROW LEVEL SECURITY;
GRANT ALL ON diary_deliveries TO PUBLIC;

-- Table 8: Poke events (user ↔ AI nudge/poke interactions)
CREATE TABLE IF NOT EXISTS poke_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_id TEXT DEFAULT '',
  content TEXT NOT NULL,
  source TEXT DEFAULT 'ai',  -- 'ai' or 'user'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_poke_events_project ON poke_events(project_id, created_at);
ALTER TABLE poke_events DISABLE ROW LEVEL SECURITY;
GRANT ALL ON poke_events TO PUBLIC;

-- Table 9: Memories (AEM + USM + DLB) — authoritative cloud store
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'aem',
  layer TEXT NOT NULL DEFAULT 'ai_emotional',
  starred BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, created_at);
ALTER TABLE memories DISABLE ROW LEVEL SECURITY;

-- Core Overviews
CREATE TABLE IF NOT EXISTS core_overviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT '暖伴',
  metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_core_overviews_project ON core_overviews(project_id, updated_at DESC);
ALTER TABLE core_overviews DISABLE ROW LEVEL SECURITY;

-- Grant access
GRANT ALL ON project_configs TO PUBLIC;
GRANT ALL ON app_state TO PUBLIC;
GRANT ALL ON project_todos TO PUBLIC;
GRANT ALL ON chat_messages TO PUBLIC;
GRANT ALL ON memories TO PUBLIC;
GRANT ALL ON core_overviews TO PUBLIC;
GRANT ALL ON diary_deliveries TO PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
