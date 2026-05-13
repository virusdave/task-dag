#!/usr/bin/env bash
set -euo pipefail

AUTH_TOKEN_FILE="$HOME/.secret/sweed/auth-token"
if [[ ! -f "$AUTH_TOKEN_FILE" ]]; then
    echo "Error: Auth token not found at $AUTH_TOKEN_FILE" >&2
    exit 1
fi

AUTH_TOKEN=$(cat "$AUTH_TOKEN_FILE")
API_URL="https://prime.sweedpos.com/api/"

MIDTOWN_DEALER=210705
BRONX_DEALER=210249

TO_DATE=$(date +%Y-%m-%d)
FROM_DATE=$(date -d "60 days ago" +%Y-%m-%d)

echo "Query window: $FROM_DATE to $TO_DATE" >&2
echo >&2

call_sweed_rpc() {
    local name="$1"
    local params="$2"
    
    curl -4 -s "$API_URL" \
        -H "Content-Type: application/json" \
        --data @- <<EOF
{
    "auth": "$AUTH_TOKEN",
    "id": "$(uuidgen)",
    "name": "$name",
    "params": $params
}
EOF
}

set_dealer() {
    local dealer_id="$1"
    local result
    result=$(call_sweed_rpc "store.auth.dealer.set" "{\"dealerId\": $dealer_id}")
    
    local current_dealer
    current_dealer=$(echo "$result" | jq -r '.result.user.currentDealerId')
    local current_name
    current_name=$(echo "$result" | jq -r '.result.user.currentDealerName // ""')
    
    if [[ "$current_dealer" != "$dealer_id" ]]; then
        echo "Error: Dealer context mismatch. Expected $dealer_id, got $current_dealer $current_name" >&2
        exit 1
    fi
    
    echo "✓ Set dealer context: $current_dealer - $current_name" >&2
}

list_orders() {
    local dealer_id="$1"
    call_sweed_rpc "store.purchase.order.list" "{
        \"orderStatusId\": 2,
        \"fromDate\": \"$FROM_DATE\",
        \"toDate\": \"$TO_DATE\",
        \"page\": 1,
        \"pageSize\": 100
    }"
}

get_order() {
    local order_id="$1"
    call_sweed_rpc "store.purchase.order.get" "{\"id\": $order_id}"
}

process_site() {
    local site_name="$1"
    local dealer_id="$2"
    
    echo "=== $site_name (Dealer $dealer_id) ===" >&2
    
    set_dealer "$dealer_id"
    
    local orders_response
    orders_response=$(list_orders "$dealer_id")
    
    local order_ids
    order_ids=$(echo "$orders_response" | jq -r '.result.data[].id')
    local order_count
    order_count=$(echo "$order_ids" | wc -l)
    
    echo "Found $order_count pending orders" >&2
    
    local all_issues="[]"
    
    for order_id in $order_ids; do
        echo "  Analyzing order $order_id..." >&2
        
        local order_detail
        order_detail=$(get_order "$order_id")
        
        local issues
        issues=$(echo "$order_detail" | jq --arg site "$site_name" --arg dealer "$dealer_id" --arg order "$order_id" '
            .result.positions[] |
            {
                positionId: .id,
                distributorProductId: .distributorProduct.id,
                distributorProductName: .distributorProduct.name,
                catalogProductId: (.distributorProduct.product.id // null),
                catalogProductName: (.distributorProduct.product.name // null),
                suggestedProductId: (.suggestedProduct.id // null),
                hasDistributorProduct: (.distributorProduct.id != null),
                hasCatalogProduct: (.distributorProduct.product.id != null),
                isGenericPlaceholder: (
                    (.distributorProduct.product.name // "" | ascii_downcase | gsub("^\\s+|\\s+$"; "")) as $name |
                    ($name == "preroll samples samples" or $name == "edibles samples 10x 10mg")
                )
            } |
            select(
                .hasDistributorProduct == false or
                .hasCatalogProduct == false or
                .isGenericPlaceholder == true
            ) |
            . + {
                site: $site,
                dealerId: ($dealer | tonumber),
                orderId: ($order | tonumber),
                issue: (
                    if .hasDistributorProduct == false then "NO_DISTRIBUTOR_PRODUCT"
                    elif .hasCatalogProduct == false then "UNMAPPED"
                    elif .isGenericPlaceholder then "GENERIC_PLACEHOLDER"
                    else null
                    end
                )
            }
        ')
        
        all_issues=$(echo "$all_issues" | jq --argjson new "$issues" '. + [$new]')
    done
    
    echo "$all_issues"
}

# Process both sites
midtown_issues=$(process_site "Midtown" "$MIDTOWN_DEALER")
echo >&2

bronx_issues=$(process_site "Bronx" "$BRONX_DEALER")
echo >&2

# Combine results
all_results=$(echo "$midtown_issues" "$bronx_issues" | jq -s 'add | flatten')

# Summary
echo "=== SUMMARY ===" >&2
total=$(echo "$all_results" | jq 'length')
unmapped=$(echo "$all_results" | jq '[.[] | select(.issue == "UNMAPPED")] | length')
generic=$(echo "$all_results" | jq '[.[] | select(.issue == "GENERIC_PLACEHOLDER")] | length')
no_dist=$(echo "$all_results" | jq '[.[] | select(.issue == "NO_DISTRIBUTOR_PRODUCT")] | length')

echo "Total issues found: $total" >&2
echo "  Unmapped positions: $unmapped" >&2
echo "  Generic placeholder mappings: $generic" >&2
echo "  No distributor product: $no_dist" >&2
echo >&2

# Output JSON
echo "$all_results" | jq .
