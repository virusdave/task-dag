#!/bin/bash
# Test the Google Ads optimization pipeline end-to-end

set -e

echo "🚀 Testing Google Ads Content Optimization Pipeline"
echo "=================================================="

# Clean previous outputs
echo ""
echo "🧹 Cleaning previous outputs..."
rm -rf ads/google/outputs/test/*
mkdir -p ads/google/outputs/test/{json,csv,html}

# Run analysis
echo ""
echo "🔍 Running analysis on example snapshot..."
./ads/google/scripts/run-analysis.ts \
  --snapshot ads/google/snapshots/example-snapshot.jsonl \
  --output-dir ads/google/outputs/test

# Check outputs
echo ""
echo "✅ Checking outputs..."

JSON_COUNT=$(ls ads/google/outputs/test/json/*.json 2>/dev/null | wc -l)
CSV_COUNT=$(ls ads/google/outputs/test/csv/*.csv 2>/dev/null | wc -l)
HTML_COUNT=$(ls ads/google/outputs/test/html/*.html 2>/dev/null | wc -l)

echo "  JSON files: $JSON_COUNT"
echo "  CSV files: $CSV_COUNT"
echo "  HTML files: $HTML_COUNT"

if [ "$JSON_COUNT" -eq 0 ] || [ "$HTML_COUNT" -eq 0 ]; then
  echo ""
  echo "❌ Test failed: Missing outputs"
  exit 1
fi

echo ""
echo "✅ Pipeline test complete!"
echo ""
echo "📄 Review outputs at:"
echo "  - ads/google/outputs/test/html/*.html"
echo "  - ads/google/outputs/test/csv/"
