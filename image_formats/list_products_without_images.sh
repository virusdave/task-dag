#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq

# List all product groups without images in Sweed catalog
# Outputs CSV: product_id,product_name,brand,category,has_stock,product_group_url

set -euo pipefail

AUTH_TOKEN="${SWEED_AUTH_TOKEN}"
BASE_URL="https://prime.sweedpos.com"
PAGE_SIZE=500

echo "========================================" >&2
echo "WARNING: AUTH TOKEN MUST BE STORE-LEVEL" >&2
echo "========================================" >&2
echo "This script requires store.product.list.short" >&2
echo "and store.inventory.item.list.grouped APIs" >&2
echo "which are only available with store-level" >&2
echo "authentication tokens, not corporate-level." >&2
echo "========================================" >&2
echo "" >&2
sleep 5

# Timing function
log_timing() {
    if [ "${TIMING:-0}" = "1" ]; then
        echo "[$(date +%H:%M:%S.%3N)] $*" >&2
    fi
}

# Function to make API calls
api_call() {
    local operation="$1"
    local params="$2"
    local request_id=$(uuidgen)

    local payload="{\"auth\":\"${AUTH_TOKEN}\",\"name\":\"${operation}\",\"params\":${params},\"id\":\"${request_id}\"}"

    curl -s "${BASE_URL}/api/" \
        -H "accept: application/json, text/plain, */*" \
        -H "content-type: application/json" \
        -d "$payload"
}

# Function to fetch all inventory product IDs with stock
fetch_inventory_product_ids() {
    local page=1
    echo "Fetching inventory with stock..." >&2
    log_timing "Starting inventory fetch"
    
    while true; do
        local response=$(api_call "store.inventory.item.list.grouped" '{"page":'${page}',"pageSize":500,"isOnStock":true}')
        
        local item_count=$(echo "$response" | jq -r '.result.data | length')
        if [ "$item_count" = "0" ] || [ "$item_count" = "null" ]; then
            break
        fi
        
        # Output product IDs
        echo "$response" | jq -r '.result.data[].product.id'
        
        local total_count=$(echo "$response" | jq -r '.result.totalCount // 0')
        local current_items=$((($page - 1) * 500 + $item_count))
        
        echo "Fetched $current_items of $total_count inventory items..." >&2
        
        if [ "$current_items" -ge "$total_count" ]; then
            break
        fi
        
        page=$((page + 1))
    done
    
    log_timing "Completed inventory fetch"
}

# Function to build product group stock lookup
build_stock_lookup() {
    echo "Building stock lookup..." >&2
    
    # Get all inventory product IDs and build a jq filter expression
    local inventory_ids=$(fetch_inventory_product_ids | sort -u | jq -R -s 'split("\n") | map(select(length > 0))')
    local num_products=$(echo "$inventory_ids" | jq 'length')
    echo "Found $num_products unique products with stock" >&2
    
    # Now fetch all products and build product_group_id -> has_stock mapping
    local page=1
    echo "Building product to group mapping..." >&2
    
    while true; do
        local response=$(api_call "store.product.list.short" '{"page":'${page}',"pageSize":500,"reload":false,"advancedSearch":true}')
        
        local product_count=$(echo "$response" | jq -r '.result.data | length')
        if [ "$product_count" = "0" ] || [ "$product_count" = "null" ]; then
            break
        fi
        
        # Output product group IDs that have stock
        echo "$response" | jq -r --argjson in_stock "$inventory_ids" '
            .result.data[] 
            | select(.id as $pid | $in_stock | index($pid))
            | .productGroup.id
        '
        
        local total_count=$(echo "$response" | jq -r '.result.totalCount // 0')
        local current_items=$((($page - 1) * 500 + $product_count))
        echo "Processed $current_items of $total_count products..." >&2
        
        if [ "$current_items" -ge "$total_count" ]; then
            break
        fi
        
        page=$((page + 1))
    done
}

# CSV header
echo "product_id,product_name,brand,category,has_stock,product_group_url"

# Build list of product group IDs with stock
echo "Building product group stock status..." >&2
groups_with_stock=$(build_stock_lookup | sort -u | jq -R -s 'split("\n") | map(select(length > 0) | tonumber)')
echo "Found $(echo "$groups_with_stock" | jq 'length') product groups with stock" >&2

# Main processing loop
echo "Processing product groups..." >&2
log_timing "Starting product group processing"
page=1
total_without_images=0

while true; do
    log_timing "Starting page $page"
    
    response=$(api_call "store.product.group.list" '{"enabled":true,"page":'${page}',"pageSize":'${PAGE_SIZE}',"reload":false}')
    log_timing "Received API response for page $page"

    product_count=$(echo "$response" | jq -r '.result.data | length')
    if [ "$product_count" = "0" ] || [ "$product_count" = "null" ]; then
        echo "No more products on page $page, finished." >&2
        break
    fi

    # Filter products without images and output CSV using jq
    echo "$response" | jq -r --arg base_url "$BASE_URL" --argjson groups_with_stock "$groups_with_stock" '
        .result.data[] 
        | select((.images // [] | length) == 0)
        | . as $group
        | [
            .id,
            .name,
            (.brand.name // "N/A"),
            (.category.name // "N/A"),
            (if ($groups_with_stock | index($group.id)) then "YES" else "NO" end),
            ($base_url + "/store_setup/products/product/" + (.id | tostring))
          ]
        | @csv
    '
    
    # Count how many on this page
    page_count=$(echo "$response" | jq '[.result.data[] | select((.images // [] | length) == 0)] | length')
    total_without_images=$((total_without_images + page_count))
    if [ "$page_count" -gt 0 ]; then
        echo "Found $page_count products without images on page $page" >&2
    fi

    # Check if we've reached the end
    total_count=$(echo "$response" | jq -r '.result.totalCount // 0')
    current_items=$((($page - 1) * $PAGE_SIZE + $product_count))

    if [ "$current_items" -ge "$total_count" ]; then
        echo "Reached end of catalog (processed $current_items of $total_count items)" >&2
        break
    fi

    page=$((page + 1))
done

echo "Total product groups without images: $total_without_images" >&2
log_timing "Script completed"
