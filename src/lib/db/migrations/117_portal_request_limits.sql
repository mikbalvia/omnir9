-- Migration 117: Public portal request-limit/topup support
-- Stores lifetime request quotas used by /api/check-request and /api/topup/*.

CREATE TABLE IF NOT EXISTS api_key_request_limits (
  api_key_id TEXT PRIMARY KEY,
  max_requests_total INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS portal_topup_transactions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  api_key_name TEXT,
  key_prefix TEXT,
  packages INTEGER NOT NULL,
  requests_to_add INTEGER NOT NULL,
  total_idr INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  credited INTEGER NOT NULL DEFAULT 0,
  credited_at TEXT,
  buyer_phone TEXT,
  buyer_email TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_topup_api_key_id ON portal_topup_transactions(api_key_id);
CREATE INDEX IF NOT EXISTS idx_portal_topup_status ON portal_topup_transactions(status);
CREATE INDEX IF NOT EXISTS idx_portal_topup_created_at ON portal_topup_transactions(created_at);
