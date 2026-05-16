/**
 * Real Google Ads API Client Implementation
 * Uses google-ads-api library to fetch actual ad data
 */

import { GoogleAdsApi, Customer } from 'google-ads-api';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GoogleAdsConfig, AdGroupInfo, AdInfo } from './client.js';

/**
 * Load Google Ads credentials from production secrets
 */
export function loadGoogleAdsCredentials(): GoogleAdsConfig {
  const secretBase = path.join(os.homedir(), '.secret/google-ads');
  
  const developerToken = fs.readFileSync(path.join(secretBase, 'developer-token'), 'utf-8').trim();
  const authorizedUser = JSON.parse(fs.readFileSync(path.join(secretBase, 'authorized-user.json'), 'utf-8'));
  
  // Customer ID needs to be configured - try common locations
  let customerId = process.env.GADS_CUSTOMER_ID || '';
  
  if (!customerId) {
    // Try to extract from last-verification.json
    try {
      const verification = JSON.parse(fs.readFileSync(path.join(secretBase, 'last-verification.json'), 'utf-8'));
      customerId = verification.customer_id || verification.login_customer_id || '';
    } catch {
      // Will need to be provided
    }
  }
  
  return {
    clientId: authorizedUser.client_id,
    clientSecret: authorizedUser.client_secret,
    developerToken,
    refreshToken: authorizedUser.refresh_token,
    customerId,
  };
}

/**
 * Real Google Ads API Client
 */
export class RealGoogleAdsClient {
  private client: GoogleAdsApi;
  private customer: Customer;
  private config: GoogleAdsConfig;
  private rateLimitDelay: number = 10000; // 10 seconds between calls (conservative)
  private lastCallTime: number = 0;

  constructor(config: GoogleAdsConfig) {
    this.config = config;
    
    this.client = new GoogleAdsApi({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      developer_token: config.developerToken,
    });
    
    this.customer = this.client.Customer({
      customer_id: config.customerId,
      refresh_token: config.refreshToken,
    });
  }

  /**
   * Wait to respect rate limits
   */
  private async respectRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    
    if (timeSinceLastCall < this.rateLimitDelay) {
      const waitTime = this.rateLimitDelay - timeSinceLastCall;
      console.log(`⏱️  Rate limit: waiting ${Math.round(waitTime/1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastCallTime = Date.now();
  }

  /**
   * Export all responsive search ads with their metrics and policy status
   */
  async exportAllAds(): Promise<any[]> {
    console.log('📡 Fetching all responsive search ads from Google Ads API...');
    
    await this.respectRateLimit();
    
    const query = `
      SELECT
        customer.id,
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        ad_group_ad.ad.id,
        ad_group_ad.ad.type,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1,
        ad_group_ad.ad.responsive_search_ad.path2,
        ad_group_ad.ad.final_urls,
        ad_group_ad.status,
        ad_group_ad.policy_summary.approval_status,
        ad_group_ad.policy_summary.policy_topic_entries,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_micros,
        metrics.ctr,
        metrics.conversions_from_interactions_rate
      FROM ad_group_ad
      WHERE 
        ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
        AND ad_group_ad.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
      ORDER BY campaign.id, ad_group.id
    `;

    try {
      const results = await this.customer.query(query);
      
      console.log(`✅ Fetched ${results.length} ads from Google Ads`);
      
      // Transform to our snapshot format
      const snapshots = results.map((row: any) => this.transformToSnapshot(row));
      
      return snapshots;
    } catch (error) {
      console.error('❌ Google Ads API error:', error);
      throw error;
    }
  }

  /**
   * Transform Google Ads API row to our snapshot format
   */
  private transformToSnapshot(row: any): any {
    const ad = row.ad_group_ad.ad;
    const rsa = ad.responsive_search_ad;
    
    // Extract policy status
    const policyApproval = row.ad_group_ad.policy_summary?.approval_status || 'UNKNOWN';
    const policyTopics = (row.ad_group_ad.policy_summary?.policy_topic_entries || [])
      .map((entry: any) => entry.type)
      .filter((t: string) => t);
    
    // Map approval status to serving status
    const servingStatus = this.mapApprovalToServingStatus(policyApproval);
    
    return {
      account_id: row.customer.id.replace(/-/g, ''),
      campaign_id: row.campaign.id.toString(),
      campaign_name: row.campaign.name,
      ad_group_id: row.ad_group.id.toString(),
      ad_group_name: row.ad_group.name,
      ad_id: ad.id.toString(),
      ad_type: 'responsive_search_ad',
      ad_status: row.ad_group_ad.status.toLowerCase(),
      headlines: (rsa.headlines || []).map((h: any) => h.text),
      descriptions: (rsa.descriptions || []).map((d: any) => d.text),
      paths: [rsa.path1, rsa.path2].filter(p => p),
      final_url: (ad.final_urls || [])[0] || '',
      policy_status: policyApproval.toLowerCase(),
      policy_topics: policyTopics,
      serving_status: servingStatus,
      metrics: {
        impressions: parseInt(row.metrics?.impressions || '0'),
        clicks: parseInt(row.metrics?.clicks || '0'),
        conversions: parseFloat(row.metrics?.conversions || '0'),
        cost: (parseInt(row.metrics?.cost_micros || '0') / 1000000),
        ctr: parseFloat(row.metrics?.ctr || '0'),
        conversion_rate: parseFloat(row.metrics?.conversions_from_interactions_rate || '0'),
      },
      family_tags: this.extractFamilyTags(row),
      snapshot_date: new Date().toISOString().split('T')[0],
    };
  }

  /**
   * Map Google's approval status to our serving status
   */
  private mapApprovalToServingStatus(approval: string): string {
    const map: Record<string, string> = {
      'APPROVED': 'eligible',
      'APPROVED_LIMITED': 'eligible_limited',
      'DISAPPROVED': 'not_eligible',
      'UNDER_REVIEW': 'under_review',
      'AREA_OF_INTEREST_ONLY': 'eligible_limited',
    };
    
    return map[approval] || 'unknown';
  }

  /**
   * Extract family tags from ad/campaign names
   */
  private extractFamilyTags(row: any): Record<string, string> {
    const tags: Record<string, string> = {};
    
    // Try to extract theme/product from campaign or ad group name
    const name = `${row.campaign.name} ${row.ad_group.name}`.toLowerCase();
    
    // Creative themes
    if (name.includes('brand')) tags.creative_theme = 'brand';
    else if (name.includes('promo')) tags.creative_theme = 'promo';
    else if (name.includes('local')) tags.creative_theme = 'local';
    else if (name.includes('medical')) tags.creative_theme = 'medical';
    else tags.creative_theme = 'general';
    
    // Product tags
    if (name.includes('flower') || name.includes('cannabis product')) tags.product_tag = 'flower';
    else if (name.includes('edible')) tags.product_tag = 'edibles';
    else if (name.includes('vape') || name.includes('cartridge')) tags.product_tag = 'vapes';
    else if (name.includes('accessory') || name.includes('accessories')) tags.product_tag = 'accessories';
    else tags.product_tag = 'general';
    
    // Geo tags
    if (name.includes('midtown')) tags.geo_target = 'midtown';
    else if (name.includes('bronx')) tags.geo_target = 'bronx';
    else if (name.includes('brooklyn')) tags.geo_target = 'brooklyn';
    else if (name.includes('queens')) tags.geo_target = 'queens';
    
    return tags;
  }
}

/**
 * Create client from production secrets
 */
export function createRealGoogleAdsClient(): RealGoogleAdsClient {
  const config = loadGoogleAdsCredentials();
  
  if (!config.customerId) {
    throw new Error('Google Ads Customer ID not configured. Set GADS_CUSTOMER_ID environment variable.');
  }
  
  return new RealGoogleAdsClient(config);
}
