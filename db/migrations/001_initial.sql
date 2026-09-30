CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
 disabled boolean NOT NULL DEFAULT false, access_approved boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
 id text PRIMARY KEY CHECK (id IN ('render','vps')), name text NOT NULL, provider text NOT NULL,
 public_url text, enabled boolean NOT NULL DEFAULT true
);
INSERT INTO nodes(id,name,provider) VALUES ('render','Render · Node 01','Render'),('vps','VPS · Node 02','VPS') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS client_keys (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), node_id text NOT NULL REFERENCES nodes(id),
 name text NOT NULL, bot_id text NOT NULL, token_hash text UNIQUE NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_keys_user ON client_keys(user_id);
CREATE TABLE IF NOT EXISTS gateway_sessions (
 node_id text NOT NULL REFERENCES nodes(id), session_id text NOT NULL,
 key_id uuid NOT NULL REFERENCES client_keys(id), expires_at timestamptz NOT NULL,
 PRIMARY KEY(node_id,session_id)
);
CREATE TABLE IF NOT EXISTS connections (
 id uuid PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id), key_id uuid NOT NULL REFERENCES client_keys(id),
 expires_at timestamptz NOT NULL, UNIQUE(node_id,key_id)
);
CREATE TABLE IF NOT EXISTS client_days (
 day date NOT NULL DEFAULT CURRENT_DATE, node_id text NOT NULL REFERENCES nodes(id),
 key_id uuid NOT NULL REFERENCES client_keys(id), PRIMARY KEY(day,node_id,key_id)
);
CREATE TABLE IF NOT EXISTS rate_limits (
 key text PRIMARY KEY, window_start timestamptz NOT NULL, hits integer NOT NULL
);
CREATE TABLE IF NOT EXISTS request_buckets (
 node_id text NOT NULL REFERENCES nodes(id), minute timestamptz NOT NULL,
 requests bigint NOT NULL DEFAULT 0, errors bigint NOT NULL DEFAULT 0,
 starts bigint NOT NULL DEFAULT 0, exceptions bigint NOT NULL DEFAULT 0, ends bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(node_id,minute)
);
CREATE TABLE IF NOT EXISTS health_checks (
 id bigserial PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id), checked_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL CHECK(status IN ('ONLINE','DEGRADED','OFFLINE','UNKNOWN')),
 latency_ms integer, players integer, playing integer, clients integer,
 cpu double precision, ram_used bigint, ram_allocated bigint, process_uptime bigint,
 error_code text
);
CREATE INDEX IF NOT EXISTS checks_node_time ON health_checks(node_id,checked_at DESC);
CREATE TABLE IF NOT EXISTS incidents (
 id uuid PRIMARY KEY, node_id text REFERENCES nodes(id), title text NOT NULL,
 details text NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, automatic boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS one_auto_incident ON incidents(node_id) WHERE automatic AND resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL,
 target text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playback_runs (
 id uuid PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id), checked_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL, audible_confirmed boolean NOT NULL DEFAULT false
);
