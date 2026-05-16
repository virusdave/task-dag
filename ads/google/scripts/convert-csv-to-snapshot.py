#!/usr/bin/env python3
"""
Convert Google Ads Editor CSV export to JSONL snapshot format
"""

import csv
import json
import sys

def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else '/tmp/google-ads-export-utf8.csv'
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'snapshots/ads-snapshot-live.jsonl'
    
    ads = []
    
    # Ads Editor exports as UTF-8-SIG (with BOM); otherwise the first
    # header key becomes '\ufeffCampaign' and every Campaign lookup
    # silently returns empty -- this is exactly what produced our
    # campaign-name-less snapshot.
    with open(input_file, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter='\t')
        
        for row in reader:
            if row.get('Ad type') != 'Responsive search ad':
                continue
            
            # Extract headlines (1-15)
            headlines = [
                row.get(f'Headline {i}', '').strip()
                for i in range(1, 16)
                if row.get(f'Headline {i}', '').strip()
            ]
            
            # Extract descriptions (1-5)
            descriptions = [
                row.get(f'Description {i}', '').strip()
                for i in range(1, 6)
                if row.get(f'Description {i}', '').strip()
            ]
            
            if not headlines:
                continue  # Skip ads with no headlines
            
            campaign = row.get('Campaign', '').strip()
            ad_group = row.get('Ad Group', '').strip()
            status = row.get('Status', '').lower()
            approval = row.get('Approval Status', '').strip()
            
            # Map approval status
            serving_status_map = {
                'Approved': 'eligible',
                'Approved limited': 'eligible_limited',
                'Disapproved': 'not_eligible',
                'Pending review': 'under_review',
                'Under review': 'under_review',
            }
            serving_status = serving_status_map.get(approval, 'unknown')
            
            # Extract family tags from campaign/ad group names
            name_lower = f"{campaign} {ad_group}".lower()
            family_tags = {}
            
            # Creative theme
            if 'brand' in name_lower:
                family_tags['creative_theme'] = 'brand'
            elif 'promo' in name_lower or 'discount' in name_lower:
                family_tags['creative_theme'] = 'promo'
            elif 'local' in name_lower:
                family_tags['creative_theme'] = 'local'
            elif 'medical' in name_lower:
                family_tags['creative_theme'] = 'medical'
            elif 'core' in name_lower:
                family_tags['creative_theme'] = 'core'
            else:
                family_tags['creative_theme'] = 'general'
            
            # Product tag
            if 'flower' in name_lower or 'bud' in name_lower:
                family_tags['product_tag'] = 'flower'
            elif 'edible' in name_lower:
                family_tags['product_tag'] = 'edibles'
            elif 'vape' in name_lower or 'cart' in name_lower:
                family_tags['product_tag'] = 'vapes'
            elif 'pre-roll' in name_lower or 'preroll' in name_lower:
                family_tags['product_tag'] = 'prerolls'
            else:
                family_tags['product_tag'] = 'general'
            
            # Geo target
            if 'midtown' in name_lower:
                family_tags['geo_target'] = 'midtown'
            elif 'bronx' in name_lower:
                family_tags['geo_target'] = 'bronx'
            elif 'brooklyn' in name_lower:
                family_tags['geo_target'] = 'brooklyn'
            elif 'queens' in name_lower:
                family_tags['geo_target'] = 'queens'
            elif 'manhattan' in name_lower:
                family_tags['geo_target'] = 'manhattan'
            
            # Parse metrics (if present)
            metrics = {
                'impressions': int(row.get('Impressions', '0') or '0'),
                'clicks': int(row.get('Clicks', '0') or '0'),
                'conversions': float(row.get('Conversions', '0') or '0'),
                'cost': float(row.get('Cost', '0').replace('$', '').replace(',', '') or '0'),
                'ctr': float(row.get('CTR', '0').replace('%', '') or '0') / 100 if row.get('CTR') else 0,
                'conversion_rate': float(row.get('Conv rate', '0').replace('%', '') or '0') / 100 if row.get('Conv rate') else 0,
            }
            
            ad_snapshot = {
                'account_id': row.get('Customer', 'unknown'),
                'campaign_id': campaign,
                'campaign_name': campaign,
                'ad_group_id': ad_group,
                'ad_group_name': ad_group,
                'ad_id': f"{ad_group}-{len(ads)}",  # Generate ID
                'ad_type': 'responsive_search_ad',
                'ad_status': status,
                'headlines': headlines,
                'descriptions': descriptions,
                'paths': [row.get('Path 1', ''), row.get('Path 2', '')],
                'final_url': row.get('Final URL', ''),
                'policy_status': approval.lower().replace(' ', '_'),
                'policy_topics': [],  # Would need to parse from detailed export
                'serving_status': serving_status,
                'metrics': metrics,
                'family_tags': family_tags,
                'snapshot_date': '2026-05-15',
            }
            
            ads.append(ad_snapshot)
    
    print(f"✅ Converted {len(ads)} responsive search ads")
    
    # Count by status
    by_status = {}
    for ad in ads:
        status = ad['serving_status']
        by_status[status] = by_status.get(status, 0) + 1
    
    print("\n📊 Status Breakdown:")
    for status, count in sorted(by_status.items(), key=lambda x: -x[1]):
        print(f"  {status}: {count}")
    
    # Write JSONL
    with open(output_file, 'w') as f:
        for ad in ads:
            f.write(json.dumps(ad) + '\n')
    
    print(f"\n💾 Snapshot written to: {output_file}")
    print(f"\n⚡ URGENT: Run analysis NOW:")
    print(f"  cd /home/amp-local/src/automation/ads/google")
    print(f"  npx tsx scripts/run-analysis.ts --snapshot {output_file} --output-dir outputs/urgent")

if __name__ == '__main__':
    main()
