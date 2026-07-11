-- WarmBuddy Supabase Schema
-- Run this in Supabase SQL Editor after creating your project

CREATE TABLE IF NOT EXISTS project_configs (
  project_id  TEXT PRIMARY KEY,
  config      JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE project_configs ENABLE ROW LEVEL SECURITY;

-- Allow service_role to read/write (backend uses service_role key)
CREATE POLICY service_role_all ON project_configs
  FOR ALL USING (true);

-- Optional: Create index on updated_at for efficient queries
CREATE INDEX IF NOT EXISTS idx_project_configs_updated
  ON project_configs (updated_at DESC);
