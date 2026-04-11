#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq

# Remove all AVIF images from product groups in Sweed catalog
# Outputs CSV: product_name,removed_image_uuid,product_group_url

set -euo pipefail

AUTH_TOKEN="${SWEED_AUTH_TOKEN}"
BASE_URL="https://prime.sweedpos.com"
PAGE_SIZE=500

# CSV header
echo "product_name,removed_image_uuid,product_group_url"

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
        -H "app-path: /" \
        -H "cache-control: no-cache" \
        -H "content-type: application/json" \
        -H "origin: https://prime.sweedpos.com" \
        -H "pragma: no-cache" \
        -H "referer: https://prime.sweedpos.com/store_setup/products" \
        -d "$payload"
}

# Function to update product group, removing AVIF images
remove_avif_images() {
    local product_group_id="$1"
    local product_name="$2"
    local existing_images="$3"
    
    # Build new images array excluding any .avif images
    local new_images_ids="["
    local first=true
    local removed_count=0
    local removed_uuids=""
    
    local existing_urls=$(echo "$existing_images" | jq -r '.[].url')
    while IFS= read -r url; do
        if [ -n "$url" ]; then
            # Extract UUID from URL (part after timestamp_)
            local existing_uuid=$(echo "$url" | sed -E 's/.*_([a-f0-9-]+)\.[^.]+$/\1/')
            
            # Check if URL ends with .avif
            if [[ "$url" =~ \.avif$ ]]; then
                # This is an AVIF, skip it and record it
                removed_count=$((removed_count + 1))
                if [ -n "$removed_uuids" ]; then
                    removed_uuids="${removed_uuids},"
                fi
                removed_uuids="${removed_uuids}${existing_uuid}"
                echo "  Removing AVIF image: $existing_uuid" >&2
            else
                # Keep this image
                if [ "$first" = true ]; then
                    new_images_ids="${new_images_ids}\"${existing_uuid}\""
                    first=false
                else
                    new_images_ids="${new_images_ids},\"${existing_uuid}\""
                fi
            fi
        fi
    done <<< "$existing_urls"
    
    new_images_ids="${new_images_ids}]"
    
    if [ "$removed_count" -gt 0 ]; then
        echo "Updating product group $product_group_id ($product_name) - removing $removed_count AVIF image(s)" >&2
        
        # Update product group
        local result=$(api_call "store.product.group.edit" '{"id":'${product_group_id}',"imagesIds":'${new_images_ids}'}')
        
        # Check for errors
        local error=$(echo "$result" | jq -r '.error // empty')
        if [ -n "$error" ]; then
            echo "ERROR updating product group $product_group_id: $error" >&2
            return 1
        fi
        
        # Output CSV rows for each removed image
        IFS=',' read -ra UUIDS <<< "$removed_uuids"
        for uuid in "${UUIDS[@]}"; do
            product_url="${BASE_URL}/store_setup/products/product/${product_group_id}"
            echo "\"$product_name\",\"$uuid\",\"$product_url\""
        done
        
        return 0
    fi
    
    return 1
}

# Main processing loop
page=1
total_removals=0

while true; do
    log_timing "Starting page $page"
    echo "Processing page $page..." >&2

    response=$(api_call "store.product.group.list" '{"enabled":true,"page":'${page}',"pageSize":'${PAGE_SIZE}',"reload":false}')
    log_timing "Received API response for page $page"

    product_count=$(echo "$response" | jq -r '.result.data | length')
    if [ "$product_count" = "0" ] || [ "$product_count" = "null" ]; then
        echo "No more products on page $page, finished." >&2
        break
    fi

    # Process each product group
    while IFS= read -r product; do
        product_name=$(echo "$product" | jq -r '.name')
        product_id=$(echo "$product" | jq -r '.id')
        images=$(echo "$product" | jq -c '.images // []')

        # Skip products without images
        if [ "$(echo "$images" | jq '. | length')" = "0" ]; then
            continue
        fi

        # Check if any images are AVIF
        avif_count=$(echo "$images" | jq '[.[].url | select(endswith(".avif"))] | length')
        
        if [ "$avif_count" -gt 0 ]; then
            echo "Found product with $avif_count AVIF image(s): $product_name (ID: $product_id)" >&2
            
            if remove_avif_images "$product_id" "$product_name" "$images"; then
                total_removals=$((total_removals + avif_count))
            fi
        fi
    done < <(echo "$response" | jq -c '.result.data[]')

    # Check if we've reached the end
    total_count=$(echo "$response" | jq -r '.result.totalCount // 0')
    current_items=$((($page - 1) * $PAGE_SIZE + $product_count))

    if [ "$current_items" -ge "$total_count" ]; then
        echo "Reached end of catalog (processed $current_items of $total_count items)" >&2
        break
    fi

    page=$((page + 1))
done

echo "Total AVIF images removed: $total_removals" >&2
