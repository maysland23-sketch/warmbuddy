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

-- Grant access
GRANT ALL ON project_configs TO PUBLIC;
GRANT ALL ON app_state TO PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
