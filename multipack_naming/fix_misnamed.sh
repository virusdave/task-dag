#!/usr/bin/env bash

# Script to fix misnamed variants with spaces around "x"

# Function to make API call for updating a variant (copied from fix_all_variants.sh)
update_variant() {
    local id="$1"
    local correct_tab="$2"
    local random_id=$(uuidgen)

    echo "Updating variant $id: $correct_tab"

    curl -s 'https://prime.sweedpos.com/api/' \
      -H 'accept: application/json, text/plain, */*' \
      -H 'accept-language: en-US,en;q=0.9' \
      -H 'app-path: /' \
      -H 'cache-control: no-cache' \
      -H 'content-type: application/json' \
      -H 'dnt: 1' \
      -H 'origin: https://prime.sweedpos.com' \
      -H 'pragma: no-cache' \
      -H 'priority: u=1, i' \
      -H 'sec-ch-ua: "Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"' \
      -H 'sec-ch-ua-mobile: ?0' \
      -H 'sec-ch-ua-platform: "macOS"' \
      -H 'sec-fetch-dest: empty' \
      -H 'sec-fetch-mode: cors' \
      -H 'sec-fetch-site: same-origin' \
      -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
      --data-raw '{"auth":"c0e393f7-59cc-4299-bd4e-5ba2c0843ec1","name":"store.product.edit","params":{"tab":"'"$correct_tab"'","id":"'$id'"},"id":"'$random_id'"}'

    echo ""
    sleep 1  # Rate limiting
}

echo "Starting to fix misnamed variants..."

count=0
# Get all misnamed products and fix them
cat products.json | jq -r '.result.data[] | select(.tab | test(" x ")) | "\(.id)|\(.tab)"' | \
while IFS='|' read -r id tab; do
    count=$((count + 1))
    echo "Processing $count: $id"
    
    # Fix the tab by removing space before "x" but keeping space after "x"
    correct_tab=$(echo "$tab" | sed 's/ x /x /g')
    
    echo "Fixing: '$tab' → '$correct_tab'"
    update_variant "$id" "$correct_tab"
done

echo "Completed fixing misnamed variants!"
