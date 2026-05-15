-- Pending Purchases Database Schema
-- Based on design in docs/pending_purchases/HELIOS_DESIGN_COMPLETE.md

-- Table: pending_purchase_packets
-- Purpose: Metadata for proposal packets
CREATE TABLE IF NOT EXISTS pending_purchase_packets (
  packet_id SERIAL PRIMARY KEY,
  packet_title TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('generated', 'import')),
  source_path TEXT,
  import_file_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'superseded')),
  state_context JSONB,
  summary JSONB,
  site_keys TEXT[] NOT NULL,
  site_labels TEXT[] NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user TEXT,
  superseded_by_packet_id INTEGER REFERENCES pending_purchase_packets(packet_id)
);

CREATE INDEX IF NOT EXISTS idx_pp_packets_status ON pending_purchase_packets(status);
CREATE INDEX IF NOT EXISTS idx_pp_packets_generated_at ON pending_purchase_packets(generated_at DESC);

-- Table: pending_purchase_rows
-- Purpose: Individual line item proposals
CREATE TABLE IF NOT EXISTS pending_purchase_rows (
  row_id SERIAL PRIMARY KEY,
  packet_id INTEGER NOT NULL REFERENCES pending_purchase_packets(packet_id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  
  -- Order context
  site_key TEXT NOT NULL,
  site_dealer_id INTEGER NOT NULL,
  order_id TEXT,
  position_id TEXT,
  distributor_product_name TEXT NOT NULL,
  
  -- Parsed taxonomy
  parsed_brand TEXT,
  parsed_category TEXT,
  parsed_subcategory TEXT,
  parsed_variant_name TEXT,
  parsed_strain_name TEXT,
  parsed_pack_size TEXT,
  parsed_pack_count INTEGER,
  
  -- Costing & Pricing
  cost_per_unit NUMERIC(10,2),
  proposed_retail_price NUMERIC(10,2),
  gm_percent NUMERIC(5,2),
  
  -- Market research
  market_avg_price NUMERIC(10,2),
  competitor_listings JSONB,
  evidence_tier TEXT CHECK (evidence_tier IN ('exact', 'categorical', 'none')),
  
  -- Catalog matching
  matched_product_id INTEGER,
  matched_group_id INTEGER,
  create_product BOOLEAN DEFAULT FALSE,
  create_group BOOLEAN DEFAULT FALSE,
  
  -- Enrichment
  primary_image_url TEXT,
  primary_image_href TEXT,
  metrc_tag TEXT,
  distributor_sku TEXT,
  
  -- Review & approval
  review_flags TEXT[],
  mapping_status TEXT CHECK (mapping_status IN ('mapped_variant_ready_for_link', 'needs_catalog_create', 'needs_review')),
  approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by_user TEXT,
  approved_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  
  -- Apply tracking
  apply_status TEXT DEFAULT 'not_requested' CHECK (apply_status IN ('not_requested', 'queued', 'running', 'applied', 'failed', 'blocked')),
  apply_request_id INTEGER,
  applied_at TIMESTAMPTZ,
  apply_error TEXT,
  
  -- Created entities (after apply)
  created_group_id INTEGER,
  created_product_id INTEGER,
  created_distributor_link_id INTEGER,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(packet_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_pp_rows_packet ON pending_purchase_rows(packet_id);
CREATE INDEX IF NOT EXISTS idx_pp_rows_approval_status ON pending_purchase_rows(approval_status) WHERE approval_status != 'rejected';
CREATE INDEX IF NOT EXISTS idx_pp_rows_apply_status ON pending_purchase_rows(apply_status);
CREATE INDEX IF NOT EXISTS idx_pp_rows_site ON pending_purchase_rows(site_key);
CREATE INDEX IF NOT EXISTS idx_pp_rows_order ON pending_purchase_rows(order_id) WHERE order_id IS NOT NULL;

-- Table: pending_purchase_apply_requests
-- Purpose: Track apply execution
CREATE TABLE IF NOT EXISTS pending_purchase_apply_requests (
  request_id SERIAL PRIMARY KEY,
  packet_id INTEGER NOT NULL REFERENCES pending_purchase_packets(packet_id),
  job_id INTEGER,
  
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'blocked')),
  
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by_user TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  
  -- Summary stats
  total_row_count INTEGER NOT NULL,
  applied_row_count INTEGER DEFAULT 0,
  failed_row_count INTEGER DEFAULT 0,
  blocked_row_count INTEGER DEFAULT 0,
  
  -- Result details
  result_summary JSONB,
  error_message TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_apply_requests_packet ON pending_purchase_apply_requests(packet_id);
CREATE INDEX IF NOT EXISTS idx_pp_apply_requests_status ON pending_purchase_apply_requests(status);
CREATE INDEX IF NOT EXISTS idx_pp_apply_requests_job ON pending_purchase_apply_requests(job_id) WHERE job_id IS NOT NULL;

-- Foreign key for apply_request_id (deferred to allow circular reference)
ALTER TABLE pending_purchase_rows 
  DROP CONSTRAINT IF EXISTS fk_pp_rows_apply_request;
ALTER TABLE pending_purchase_rows 
  ADD CONSTRAINT fk_pp_rows_apply_request 
  FOREIGN KEY (apply_request_id) 
  REFERENCES pending_purchase_apply_requests(request_id);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_pending_purchase_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_pp_packets_updated_at
  BEFORE UPDATE ON pending_purchase_packets
  FOR EACH ROW
  EXECUTE FUNCTION update_pending_purchase_updated_at();

CREATE TRIGGER trigger_pp_rows_updated_at
  BEFORE UPDATE ON pending_purchase_rows
  FOR EACH ROW
  EXECUTE FUNCTION update_pending_purchase_updated_at();

CREATE TRIGGER trigger_pp_apply_requests_updated_at
  BEFORE UPDATE ON pending_purchase_apply_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_pending_purchase_updated_at();
