#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq imagemagick file

# Convert all AVIF product images to PNG in Sweed catalog
# Outputs CSV: product_name,prior_image_uuid,new_image_uuid,product_group_url

[[ -n "$VERBOSE" ]] && { set -x; DEBUG=1; }
# set -x   # Verbose command logging
set -euo pipefail

AUTH_TOKEN="${SWEED_AUTH_TOKEN}"
BASE_URL="https://prime.sweedpos.com"
PAGE_SIZE=1000
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-sweed_catalog}"
PG_USER="${PG_USER:-fb_sweed_catalog_images}"
# set $PG_PW to a valid postgres password
PG_PW="${PG_PQ:-$(cat ~amp-local/.secret/postgres/fbnyc/local/pg_fb_sweed_catalog_images_pw)}"

# CSV header
echo "product_name,prior_image_uuid,new_image_uuid,product_group_url"

# Timing function
log_timing() {
    if [ "${TIMING:-0}" = "1" ]; then
        echo "[$(date +%H:%M:%S.%3N)] $*" >&2
    fi
}

# Debug logging function
log_debug() {
    if [ "${DEBUG:-0}" = "1" ]; then
        echo "[DEBUG] $*" >&2
    fi
}

# Database helper functions
db_exec() {
    local query="$1"
    if [ -n "${PG_PW:-}" ]; then
        local temp_out="/tmp/db_exec_$$_$(date +%s%N).txt"
        local temp_query="/tmp/db_query_$$_$(date +%s%N).sql"
        echo "$query" > "$temp_query"
        log_debug "db_exec: Query length = ${#query}, query file = $temp_query, output file = $temp_out"
        PGPASSWORD="$PG_PW" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -t -A < "$temp_query" > "$temp_out" 2>&1
        local exit_code=$?
        local file_size=$(wc -c < "$temp_out" 2>/dev/null || echo 0)
        log_debug "db_exec: Exit code = $exit_code, File size = $file_size bytes"
        cat "$temp_out"
        # Don't remove for debugging: rm -f "$temp_out"
    fi
}

filter_seen_uuids() {
    local urls_json="$1"
    if [ -z "${PG_PW:-}" ]; then
        echo "$urls_json"
        return
    fi

    local input_count=$(echo "$urls_json" | jq 'length')
    log_debug "filter_seen_uuids: Input count = $input_count"

    # Extract UUIDs from URLs and build VALUES clause
    local values_list=$(echo "$urls_json" | jq -r '.[]' | sed -E "s/.*_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}).*/\1/" | sed "s/'/\\\'/g" | sed "s/.*/('&')/" | paste -sd, -)
    if [ -z "$values_list" ]; then
        echo "[]"
        return
    fi

    log_debug "filter_seen_uuids: Executing SQL query..."
    # Use CTE with NOT IN to filter out seen UUIDs
    local unseen=$(db_exec "WITH candidates(uuid) AS (VALUES $values_list) SELECT uuid FROM candidates WHERE uuid NOT IN (SELECT uuid FROM known_good_image_uuids);")
    log_debug "filter_seen_uuids: Query complete, raw result length = ${#unseen}"
    log_debug "filter_seen_uuids: First 200 chars of unseen: ${unseen:0:200}"

    # Convert back to JSON array
    if [ -z "$unseen" ]; then
        log_debug "filter_seen_uuids: unseen is empty"
        echo "[]"
    else
        local result=$(echo "$unseen" | jq -R -s 'split("\n") | map(select(length > 0))')
        local output_count=$(echo "$result" | jq 'length')
        log_debug "filter_seen_uuids: Output count = $output_count"
        echo "$result"
    fi
}

mark_uuid_seen() {
    local uuid="$1"
    if [ -n "${PG_PW:-}" ]; then
        db_exec "INSERT INTO known_good_image_uuids (uuid) VALUES ('$uuid') ON CONFLICT DO NOTHING;" > /dev/null
    fi
}

# Function to make API calls
api_call() {
    local operation="$1"
    local params="$2"
    local request_id=$(uuidgen)

    # Construct JSON payload properly
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

# Function to check if image is AVIF format
is_avif_image() {
    local image_url="$1"
    local temp_file="/tmp/check_image_$(basename "$image_url")"

    # Download image to temp file
    if curl -s "$image_url" -o "$temp_file"; then
        # Check actual format, not extension
        local format=$(file "$temp_file" | grep -i avif || true)
        rm -f "$temp_file"

        if [ -n "$format" ]; then
            return 0  # Is AVIF
        else
            # Image is in acceptable format, mark as seen
            local image_uuid="${image_url##*_}"
            image_uuid="${image_uuid%%.*}"
            mark_uuid_seen "$image_uuid"
        fi
    fi
    return 1  # Not AVIF or failed to download
}

# Function to convert AVIF to PNG and upload
convert_and_upload() {
    local image_url="$1"
    local temp_avif="/tmp/original_$(uuidgen).avif"
    local temp_png="/tmp/converted_$(uuidgen).png"

    # Download original AVIF
    if ! curl -s "$image_url" -o "$temp_avif"; then
        echo "ERROR: Failed to download $image_url" >&2
        return 1
    fi

    # Convert AVIF to PNG
    if ! magick "$temp_avif" "$temp_png" ; then
        echo "ERROR: Failed to convert $image_url to PNG" >&2
        rm -f "$temp_avif" "$temp_png"
        return 1
    fi

    # Reserve blob UUID
    local blob_result=$(api_call "store.blob.add" '{"type":"banner"}')
    local blob_uuid=$(echo "$blob_result" | jq -r '.result')

    if [ "$blob_uuid" = "null" ] || [ -z "$blob_uuid" ]; then
        echo "ERROR: Failed to reserve blob UUID" >&2
        rm -f "$temp_avif" "$temp_png"
        return 1
    fi

    # Upload PNG binary
    local upload_response=$(curl -s -X PUT "${BASE_URL}/api/blobs/upload/${blob_uuid}" \
        -H "Content-Type: application/octet-stream" \
        --data-binary "@${temp_png}")

    # Check upload success
    local upload_code=$(echo "$upload_response" | jq -r '.result.code // empty')
    if [ "$upload_code" != "200" ]; then
        echo "ERROR: Failed to upload PNG for blob $blob_uuid" >&2
        rm -f "$temp_avif" "$temp_png"
        return 1
    fi

    # Cleanup temp files
    rm -f "$temp_avif" "$temp_png"

    # Mark new image UUID as seen
    mark_uuid_seen "$blob_uuid"

    echo "$blob_uuid"
}

# Function to update product group with new image
update_product_images() {
    local product_group_id="$1"
    local new_image_uuid="$2"
    local existing_images="$3"

    # Build new images array with new PNG
    # local new_images_ids="[\"${new_image_uuid}\""
    local new_images_ids="[\"${new_image_uuid}\"]"

    # TODO(Dave/Amp): This seems broken; we end up with a TON of images on updated product groups

    # # Add existing images (excluding the AVIF we're replacing)
    # # Extract UUIDs from URLs like: https://media-prime.sweedpos.com/store/prime/1757627104_965143d6-2573-4859-88e9-c18ed93dc096.avif
    # local prior_image_uuid="$3"  # Get the prior image UUID from the third parameter
    # local existing_urls=$(echo "$existing_images" | jq -r '.[].url')
    # while IFS= read -r url; do
    #     if [ -n "$url" ]; then
    #         # Extract UUID from URL (part after timestamp_)
    #         local existing_uuid=$(echo "$url" | sed -E 's/.*_([a-f0-9-]+)\.[^.]+$/\1/')
    #         if [ -n "$existing_uuid" ] && [ "$existing_uuid" != "$prior_image_uuid" ]; then   # Drop prior image
    #             new_images_ids="${new_images_ids},\"${existing_uuid}\""
    #         fi
    #     fi
    # done <<< "$existing_urls"

    # new_images_ids="${new_images_ids}]"

    # Update product group
    api_call "store.product.group.edit" '{"id":'${product_group_id}',"imagesIds":'${new_images_ids}'}' >&2
}

# Main processing loop
page=1
total_conversions=0

while true; do
    log_timing "Starting page $page"
    echo "Processing page $page..." >&2

    # Get product groups for current page
    #response=$(api_call "store.product.group.list" '{"enabled":true,"page":'${page}',"pageSize":'${PAGE_SIZE}',"reload":false,"brandIds":[1962]}')
    response=$(api_call "store.product.group.list" '{"enabled":true,"page":'${page}',"pageSize":'${PAGE_SIZE}',"reload":false}')
    log_timing "Received API response for page $page"

    # Check if we have data
    product_count=$(echo "$response" | jq -r '.result.data | length')
    if [ "$product_count" = "0" ] || [ "$product_count" = "null" ]; then
        echo "No more products on page $page, finished." >&2
        break
    fi

    # Collect all image URLs from this page
    all_urls=$(echo "$response" | jq -c '[.result.data[].images[]?.url // empty]')
    echo "Page $page has $(echo "$all_urls" | jq 'length') total image URLs" >&2
    log_timing "Collected all URLs from page $page"
    log_debug "All URLs: $(echo "$all_urls" | jq -r '.[]' | head -5)"

    # Filter out already-seen UUIDs
    unseen_uuids=$(filter_seen_uuids "$all_urls")
    unseen_count=$(echo "$unseen_uuids" | jq 'length')
    echo "Filtering down to $unseen_count unseen UUIDs" >&2
    log_timing "DB filtered to $unseen_count unseen UUIDs"
    log_debug "Unseen UUIDs: $(echo "$unseen_uuids" | jq -r '.[]')"

    # Skip product iteration if no unseen UUIDs
    if [ "$unseen_count" = "0" ]; then
        log_timing "No unseen UUIDs, skipping to next page"
        page=$((page + 1))
        continue
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

        # Check first image for AVIF format
        while IFS= read -r image; do
            image_url=$(echo "$image" | jq -r '.url')
            image_uuid="${image_url##*_}"
            image_uuid="${image_uuid%%.*}"

            # Skip if this UUID was already seen (filtered out at page level)
            if ! echo "$unseen_uuids" | jq -e --arg uuid "$image_uuid" 'index($uuid)' > /dev/null; then
                continue
            fi

            echo "Checking image: $image_url" >&2
            log_timing "Downloading and checking image format"

            # Check if image is actually AVIF format
            if is_avif_image "$image_url"; then
                echo "Converting AVIF image for product: $product_name" >&2
                log_timing "Starting conversion for $product_name"

                # Convert and upload
                new_uuid=$(convert_and_upload "$image_url")
                log_timing "Completed conversion and upload"
                if [ $? -eq 0 ] && [ -n "$new_uuid" ]; then
                    # Update product group with new PNG image, dropping the old AVIF
                    update_product_images "$product_id" "$new_uuid" "$images" "$image_uuid"

                    # Output CSV row with product group URL
                    product_url="${BASE_URL}/store_setup/products/product/${product_id}"
                    echo "\"$product_name\",\"$image_uuid\",\"$new_uuid\",\"$product_url\""

                    total_conversions=$((total_conversions + 1))
                    echo "Converted image $total_conversions: $product_name" >&2
                fi
            fi
            break
        done < <(echo "$images" | jq -c '.[]')
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

echo "Total AVIF images converted: $total_conversions" >&2
