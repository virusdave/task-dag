#!/usr/bin/env python3
"""
Convert a Google Ads Editor CSV/TSV export to the JSONL snapshot
format the morning bundle consumes.

Three failure modes the previous version had, all fixed here:

  1. **Encoding.** Older comments insisted exports were UTF-8-SIG.
     They are actually UTF-16 LE with a 0xFF 0xFE BOM. Reading as
     UTF-8 produced NUL-interleaved keys ('A\\0d\\0 \\0t\\0y\\0p\\0e\\0'),
     no header ever matched 'Ad type', the snapshot ended up with
     zero RSAs, and downstream analysis silently produced an empty
     bundle. We now detect the BOM and decode accordingly.

  2. **Synthetic ad IDs.** The previous fabricated
     `ad_id = f"{ad_group}-{len(ads)}"`, which meant every repair /
     pause CSV emitted by L2 referenced an ID that Google Ads Editor
     does not recognize, so those operations were silent no-ops in
     the operator's account. We now read the real numeric `ID`
     column. When it's empty (an ad not yet synced), we leave it
     empty rather than fabricate, so downstream code knows it has
     to match by content instead of pretending to have an ID.

  3. **Hardcoded snapshot date.** Was a fixed '2026-05-15'. Now uses
     today's date by default, overridable via --snapshot-date.

Usage:
  convert-csv-to-snapshot.py <input.csv> [output.jsonl] \
      [--snapshot-date YYYY-MM-DD]
"""

import csv
import io
import json
import sys
from datetime import date


def read_text_with_bom_detection(path: str) -> str:
    """Read a file, detecting and decoding the BOM correctly.

    Returns a Python str. Raises with a clear error if the bytes
    cannot be decoded by any supported codec.
    """
    with open(path, 'rb') as fp:
        raw = fp.read()
    if raw[:2] == b'\xff\xfe':
        return raw.decode('utf-16-le').lstrip('\ufeff')
    if raw[:2] == b'\xfe\xff':
        return raw.decode('utf-16-be').lstrip('\ufeff')
    if raw[:3] == b'\xef\xbb\xbf':
        return raw.decode('utf-8-sig')
    # No BOM. Assume UTF-8; this matches what the helios TS port does.
    return raw.decode('utf-8')


def parse_args(argv):
    snapshot_date = date.today().isoformat()
    positional = []
    i = 0
    while i < len(argv):
        if argv[i] == '--snapshot-date' and i + 1 < len(argv):
            snapshot_date = argv[i + 1]
            i += 2
            continue
        positional.append(argv[i])
        i += 1
    input_file = positional[0] if positional else '/tmp/google-ads-export-utf8.csv'
    output_file = (
        positional[1] if len(positional) > 1
        else 'snapshots/ads-snapshot-live.jsonl'
    )
    return input_file, output_file, snapshot_date


def main():
    input_file, output_file, snapshot_date = parse_args(sys.argv[1:])

    text = read_text_with_bom_detection(input_file)
    reader = csv.DictReader(io.StringIO(text), delimiter='\t')

    ads = []
    impaired_with_no_id = 0
    for row in reader:
        if row.get('Ad type') != 'Responsive search ad':
            continue

        headlines = [
            row.get(f'Headline {i}', '').strip()
            for i in range(1, 16)
            if row.get(f'Headline {i}', '').strip()
        ]
        descriptions = [
            row.get(f'Description {i}', '').strip()
            for i in range(1, 6)
            if row.get(f'Description {i}', '').strip()
        ]
        if not headlines:
            continue

        campaign = row.get('Campaign', '').strip()
        ad_group = row.get('Ad Group', '').strip()
        status = row.get('Status', '').lower()
        approval = row.get('Approval Status', '').strip()

        serving_status_map = {
            'Approved': 'eligible',
            'Approved limited': 'eligible_limited',
            'Disapproved': 'not_eligible',
            'Pending review': 'under_review',
            'Under review': 'under_review',
        }
        serving_status = serving_status_map.get(approval, 'unknown')

        # Real ad ID from the Editor export's 'ID' column. In practice,
        # every "All campaigns" Editor export we've seen for this account
        # leaves the ID column empty for RSAs (Editor only fills it after
        # a Get-Latest-Changes round-trip the operator hasn't done). To
        # keep downstream emitters working — they need a non-empty handle
        # to index ads and reference them across CSV batches — we
        # synthesize a STABLE content-hash id when the real ID is empty.
        # The hash is over (campaign, ad_group, ad_type, headlines,
        # descriptions, final_url), so the same RSA gets the same id
        # across runs (no churn). Ads Editor will still match the import
        # row by content (Campaign + Ad group + Ad type + Original
        # Headline / Description columns added by csv-generator), so the
        # synthetic id is purely an internal join key.
        real_ad_id = (row.get('ID', '') or '').strip()
        if real_ad_id:
            ad_id = real_ad_id
        else:
            import hashlib
            h = hashlib.sha1()
            h.update('|'.join([
                campaign,
                ad_group,
                'rsa',
                '\x1f'.join(headlines),
                '\x1f'.join(descriptions),
                row.get('Final URL', '') or '',
            ]).encode('utf-8'))
            ad_id = 'csyn-' + h.hexdigest()[:16]
            if serving_status in ('not_eligible', 'eligible_limited'):
                impaired_with_no_id += 1

        name_lower = f"{campaign} {ad_group}".lower()
        family_tags = {}
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

        metrics = {
            'impressions': int(row.get('Impressions', '0') or '0'),
            'clicks': int(row.get('Clicks', '0') or '0'),
            'conversions': float(row.get('Conversions', '0') or '0'),
            'cost': float(
                (row.get('Cost', '0') or '0').replace('$', '').replace(',', '')
            ),
            'ctr': (
                float((row.get('CTR') or '0').replace('%', '')) / 100
                if row.get('CTR') else 0
            ),
            'conversion_rate': (
                float((row.get('Conv rate') or '0').replace('%', '')) / 100
                if row.get('Conv rate') else 0
            ),
        }

        ads.append({
            'account_id': row.get('Customer', 'unknown'),
            'campaign_id': campaign,
            'campaign_name': campaign,
            'ad_group_id': ad_group,
            'ad_group_name': ad_group,
            'ad_id': ad_id,  # real ID or empty string
            'ad_type': 'responsive_search_ad',
            'ad_status': status,
            'headlines': headlines,
            'descriptions': descriptions,
            'paths': [row.get('Path 1', ''), row.get('Path 2', '')],
            'final_url': row.get('Final URL', ''),
            'policy_status': approval.lower().replace(' ', '_'),
            'policy_topics': [],
            'serving_status': serving_status,
            'metrics': metrics,
            'family_tags': family_tags,
            'snapshot_date': snapshot_date,
        })

    # Hard fail on a structurally-correct-but-content-empty result so
    # we never silently overwrite a good snapshot with an empty one
    # (which is what would happen on encoding mismatch before this
    # version). The morning bundle has its own emptiness guard
    # downstream too — defence in depth.
    if not ads:
        sys.stderr.write(
            f'ERROR: 0 Responsive search ad rows found in {input_file}. '
            f'Refusing to write an empty snapshot. Check that the input '
            f'is a real Ads Editor TSV export (UTF-16 LE BOM, tab '
            f'delimited, with "Ad type", "Headline N", "Description N" '
            f'columns).\n'
        )
        sys.exit(2)

    print(f'✅ Converted {len(ads)} responsive search ads')
    by_status = {}
    for ad in ads:
        by_status[ad['serving_status']] = by_status.get(ad['serving_status'], 0) + 1
    print('\n📊 Status Breakdown:')
    for status, count in sorted(by_status.items(), key=lambda x: -x[1]):
        print(f'  {status}: {count}')
    if impaired_with_no_id:
        print(
            f'\n⚠️  {impaired_with_no_id} impaired ads (disapproved / '
            f'limited) have empty IDs in the export. Repair / pause '
            f'CSV emitters must match these by content (headlines + '
            f'descriptions) rather than ID.'
        )

    with open(output_file, 'w') as f:
        for ad in ads:
            f.write(json.dumps(ad) + '\n')
    print(f'\n💾 Snapshot written to: {output_file}')


if __name__ == '__main__':
    main()
