CREATE TABLE workspace_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  hidden_nav_pages TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO workspace_settings (id) VALUES ('default');
