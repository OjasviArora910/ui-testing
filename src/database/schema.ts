/** SQLite schema. Versioned through PRAGMA user_version; add new migrations to the end of the array. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    auth_profile TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    verdict TEXT,
    request_json TEXT NOT NULL,
    config_json TEXT NOT NULL,
    state_json TEXT,
    summary_json TEXT,
    rules_run_json TEXT,
    error TEXT,
    abort_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER,
    title TEXT,
    error TEXT,
    test_status TEXT NOT NULL DEFAULT 'pending',
    model_json TEXT,
    discovered_at TEXT NOT NULL,
    UNIQUE (run_id, url)
  );
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    page_url TEXT,
    viewport TEXT,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT,
    ok INTEGER NOT NULL,
    detail TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','major','minor','info')),
    classification TEXT NOT NULL CHECK (classification IN ('defect','anomaly')),
    basis TEXT CHECK (basis IN ('deterministic','generic_rule','configured_rule','baseline','human')),
    page TEXT NOT NULL,
    viewport TEXT NOT NULL,
    element_json TEXT,
    expected TEXT NOT NULL,
    actual TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, fingerprint),
    CHECK (classification <> 'defect' OR basis IS NOT NULL)
  );
  CREATE INDEX idx_findings_run ON findings(run_id);
  CREATE TABLE evidence (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mime TEXT NOT NULL,
    label TEXT,
    page TEXT,
    viewport TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, id)
  );
  CREATE TABLE network_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    page TEXT, viewport TEXT,
    method TEXT, url TEXT, resource_type TEXT, status INTEGER, ok INTEGER, failure TEXT, duration_ms REAL, ignored INTEGER, at INTEGER
  );
  CREATE INDEX idx_net_run ON network_events(run_id);
  CREATE TABLE console_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    page TEXT, viewport TEXT,
    kind TEXT, level TEXT, text TEXT, location TEXT, at INTEGER
  );
  CREATE INDEX idx_console_run ON console_events(run_id);
  CREATE TABLE ai_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    finding_id TEXT REFERENCES findings(id) ON DELETE CASCADE,
    provider TEXT, model TEXT,
    status TEXT NOT NULL CHECK (status IN ('accepted','rejected')),
    analysis_json TEXT,
    reject_reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE human_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('CONFIRM_BUG','NOT_A_BUG','EXPECTED_BEHAVIOR','NEEDS_INVESTIGATION')),
    note TEXT,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL
  );
  CREATE INDEX idx_decisions_finding ON human_decisions(finding_id);
  CREATE TABLE baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    viewport TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mask_json TEXT,
    run_id TEXT,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );
  `,
];
