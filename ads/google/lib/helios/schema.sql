-- Google Ads tables for Helios database
-- Stores snapshots of Google Ads data for analysis

-- Accounts
CREATE TABLE IF NOT EXISTS gads_accounts (
  account_id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  currency TEXT,
  time_zone TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Campaigns
CREATE TABLE IF NOT EXISTS gads_campaigns (
  campaign_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gads_accounts(account_id),
  campaign_name TEXT NOT NULL,
  campaign_status TEXT,
  campaign_type TEXT,
  daily_budget NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Ad Groups
CREATE TABLE IF NOT EXISTS gads_ad_groups (
  ad_group_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES gads_campaigns(campaign_id),
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT,
  default_cpc NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Ads
CREATE TABLE IF NOT EXISTS gads_ads (
  ad_id TEXT PRIMARY KEY,
  ad_group_id TEXT NOT NULL REFERENCES gads_ad_groups(ad_group_id),
  ad_type TEXT NOT NULL,
  ad_status TEXT,
  headlines JSONB NOT NULL,
  descriptions JSONB NOT NULL,
  paths JSONB,
  final_url TEXT,
  policy_status TEXT,
  policy_topics JSONB,
  serving_status TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Performance snapshots (daily)
CREATE TABLE IF NOT EXISTS gads_performance_snapshots (
  snapshot_id SERIAL PRIMARY KEY,
  ad_id TEXT NOT NULL REFERENCES gads_ads(ad_id),
  snapshot_date DATE NOT NULL,
  impressions INTEGER,
  clicks INTEGER,
  conversions NUMERIC,
  cost NUMERIC,
  ctr NUMERIC,
  conversion_rate NUMERIC,
  quality_score NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(ad_id, snapshot_date)
);

-- Family tags for grouping
CREATE TABLE IF NOT EXISTS gads_family_tags (
  ad_id TEXT NOT NULL REFERENCES gads_ads(ad_id),
  tag_key TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (ad_id, tag_key)
);

-- Trial tracking
CREATE TABLE IF NOT EXISTS gads_trials (
  trial_id TEXT PRIMARY KEY,
  trial_group_name TEXT NOT NULL UNIQUE,
  original_campaign_id TEXT REFERENCES gads_campaigns(campaign_id),
  original_ad_group_id TEXT REFERENCES gads_ad_groups(ad_group_id),
  trial_campaign_id TEXT REFERENCES gads_campaigns(campaign_id),
  trial_ad_group_id TEXT REFERENCES gads_ad_groups(ad_group_id),
  global_batch_number INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  policy_class_being_probed TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  status TEXT DEFAULT 'pending' -- pending, running, completed, removed
);

-- Trial ads (control and variants)
CREATE TABLE IF NOT EXISTS gads_trial_ads (
  trial_ad_id SERIAL PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES gads_trials(trial_id),
  ad_id TEXT NOT NULL REFERENCES gads_ads(ad_id),
  is_control BOOLEAN NOT NULL DEFAULT FALSE,
  variant_label TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Trial check results (at intervals: 1hr, 4hr, 24hr, 48hr)
CREATE TABLE IF NOT EXISTS gads_trial_checks (
  check_id SERIAL PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES gads_trials(trial_id),
  ad_id TEXT NOT NULL REFERENCES gads_ads(ad_id),
  check_time TIMESTAMP NOT NULL,
  check_interval_hours INTEGER NOT NULL, -- 1, 4, 24, or 48
  serving_status TEXT NOT NULL,
  policy_status TEXT,
  policy_topics JSONB,
  impressions INTEGER,
  clicks INTEGER,
  conversions NUMERIC,
  ctr NUMERIC,
  conversion_rate NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(trial_id, ad_id, check_interval_hours)
);

-- L2 runs (track each analysis run)
CREATE TABLE IF NOT EXISTS gads_l2_runs (
  run_id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  snapshot_file TEXT NOT NULL,
  l1_config_version TEXT NOT NULL,
  l2_prompt_version TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  status TEXT DEFAULT 'running', -- running, completed, failed
  families_analyzed INTEGER,
  trials_created INTEGER,
  output_json_path TEXT,
  output_html_path TEXT,
  output_csv_dir TEXT
);

-- L3 evaluations (track meta-analysis)
CREATE TABLE IF NOT EXISTS gads_l3_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  evaluation_date DATE NOT NULL,
  l2_run_ids TEXT[] NOT NULL,
  l3_prompt_version TEXT NOT NULL,
  prediction_accuracy JSONB NOT NULL, -- PredictionAccuracy
  pattern_effectiveness JSONB NOT NULL, -- PatternEffectiveness[]
  proposed_updates JSONB NOT NULL, -- ProposedUpdate[]
  governance_status TEXT DEFAULT 'pending_review', -- pending_review, approved, rejected
  governance_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  approved_by TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_gads_ads_ad_group ON gads_ads(ad_group_id);
CREATE INDEX IF NOT EXISTS idx_gads_ad_groups_campaign ON gads_ad_groups(campaign_id);
CREATE INDEX IF NOT EXISTS idx_gads_campaigns_account ON gads_campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_gads_performance_date ON gads_performance_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_gads_performance_ad ON gads_performance_snapshots(ad_id);
CREATE INDEX IF NOT EXISTS idx_gads_family_tags_ad ON gads_family_tags(ad_id);
CREATE INDEX IF NOT EXISTS idx_gads_trials_batch ON gads_trials(global_batch_number);
CREATE INDEX IF NOT EXISTS idx_gads_trials_status ON gads_trials(status);
CREATE INDEX IF NOT EXISTS idx_gads_trial_checks_trial ON gads_trial_checks(trial_id);
CREATE INDEX IF NOT EXISTS idx_gads_trial_checks_interval ON gads_trial_checks(check_interval_hours);
CREATE INDEX IF NOT EXISTS idx_gads_l2_runs_date ON gads_l2_runs(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_gads_l3_evals_date ON gads_l3_evaluations(evaluation_date);

-- Views for common queries

-- Trial outcomes view
CREATE OR REPLACE VIEW gads_trial_outcomes AS
SELECT 
  t.trial_id,
  t.trial_group_name,
  t.hypothesis,
  t.policy_class_being_probed,
  ta.ad_id,
  ta.is_control,
  ta.variant_label,
  tc.check_interval_hours,
  tc.serving_status,
  tc.policy_status,
  tc.impressions,
  tc.clicks,
  tc.ctr,
  tc.conversions,
  tc.conversion_rate
FROM gads_trials t
JOIN gads_trial_ads ta ON t.trial_id = ta.trial_id
LEFT JOIN gads_trial_checks tc ON ta.ad_id = tc.ad_id AND t.trial_id = tc.trial_id
WHERE t.status = 'completed'
ORDER BY t.trial_id, ta.is_control DESC, tc.check_interval_hours;

-- Active trials view
CREATE OR REPLACE VIEW gads_active_trials AS
SELECT 
  t.*,
  COUNT(DISTINCT ta.ad_id) as total_ads,
  COUNT(DISTINCT CASE WHEN ta.is_control THEN ta.ad_id END) as control_ads,
  COUNT(DISTINCT CASE WHEN NOT ta.is_control THEN ta.ad_id END) as variant_ads
FROM gads_trials t
LEFT JOIN gads_trial_ads ta ON t.trial_id = ta.trial_id
WHERE t.status IN ('pending', 'running')
GROUP BY t.trial_id;

-- Family performance summary
CREATE OR REPLACE VIEW gads_family_performance AS
SELECT 
  ft.tag_value as family_key,
  COUNT(DISTINCT a.ad_id) as total_ads,
  COUNT(DISTINCT CASE WHEN a.serving_status = 'eligible' THEN a.ad_id END) as eligible_ads,
  COUNT(DISTINCT CASE WHEN a.serving_status = 'eligible_limited' THEN a.ad_id END) as limited_ads,
  COUNT(DISTINCT CASE WHEN a.serving_status = 'not_eligible' THEN a.ad_id END) as disapproved_ads,
  AVG(ps.impressions) as avg_impressions,
  AVG(ps.clicks) as avg_clicks,
  AVG(ps.ctr) as avg_ctr,
  AVG(ps.conversions) as avg_conversions,
  AVG(ps.conversion_rate) as avg_conversion_rate
FROM gads_family_tags ft
JOIN gads_ads a ON ft.ad_id = a.ad_id
LEFT JOIN gads_performance_snapshots ps ON a.ad_id = ps.ad_id
WHERE ft.tag_key IN ('creative_theme', 'product_tag')
  AND ps.snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY ft.tag_value;
