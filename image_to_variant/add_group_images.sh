#!/usr/bin/env bash

# Script to add group images to products that don't have images
# Reads from product_groups_final.csv and processes all products

CSV_FILE="product_groups_final.csv"
OUTPUT_CSV="products_updated.csv"

# Create output CSV with headers
echo "product_id,group_id,image_uuid,status" > "$OUTPUT_CSV"

# Function to get current product details
get_product() {
    local product_id="$1"
    local random_id=$(uuidgen)
    
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
      --data-raw '{"auth":"c0e393f7-59cc-4299-bd4e-5ba2c0843ec1","name":"store.product.get","params":{"id":"'$product_id'"},"id":"'$random_id'"}'
}

# Function to update product with new images
update_product() {
    local product_id="$1"
    local new_images_json="$2"
    local random_id=$(uuidgen)
    
    echo "Updating product $product_id with images: $new_images_json"
    
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
      --data-raw '{"auth":"c0e393f7-59cc-4299-bd4e-5ba2c0843ec1","name":"store.product.edit","params":{"imagesIds":'"$new_images_json"',"id":"'$product_id'"},"id":"'$random_id'"}'
    
    sleep 1  # Rate limiting
}

echo "Starting to process products..."

# Get all products and process them
./products.sh 2>/dev/null | jq -r '.result.data[] | [.id, .productGroup.id] | @csv' | \
while IFS=',' read -r product_id group_id; do
    # Remove quotes from CSV values
    product_id=$(echo "$product_id" | tr -d '"')
    group_id=$(echo "$group_id" | tr -d '"')
    
    echo "Processing product $product_id with group $group_id"
    
    # Check if this group has an image in our CSV
    image_uuid=$(grep "^$group_id," "$CSV_FILE" | cut -d',' -f2 | tr -d '"')
    
    if [[ -n "$image_uuid" && "$image_uuid" != "" ]]; then
        echo "  Found group image UUID: $image_uuid"
        
        # Get current product details
        product_details=$(get_product "$product_id")
        
        # Check if API call was successful
        if echo "$product_details" | jq -e '.error' >/dev/null 2>&1; then
            echo "  Error getting product details"
            echo "$product_id,$group_id,$image_uuid,error_getting_product" >> "$OUTPUT_CSV"
            continue
        fi
        
        # Extract current imagesIds (could be null or array)
        current_images=$(echo "$product_details" | jq '.result.imagesIds // []')
        
        # Check if the group image UUID is already in the array
        if echo "$current_images" | jq --arg uuid "$image_uuid" '. | index($uuid)' | grep -q 'null'; then
            # UUID not found, so add it to the array
            new_images=$(echo "$current_images" | jq --arg uuid "$image_uuid" '. + [$uuid]')
            
            echo "  Adding image UUID to product"
            update_result=$(update_product "$product_id" "$new_images")
            
            # Check if update was successful
            if echo "$update_result" | jq -e '.error' >/dev/null 2>&1; then
                echo "  Error updating product"
                echo "$product_id,$group_id,$image_uuid,error_updating" >> "$OUTPUT_CSV"
            else
                echo "  Successfully updated product"
                echo "$product_id,$group_id,$image_uuid,success" >> "$OUTPUT_CSV"
            fi
        else
            echo "  Image already exists in product"
            echo "$product_id,$group_id,$image_uuid,already_exists" >> "$OUTPUT_CSV"
        fi
    else
        echo "  No group image found for group $group_id"
    fi
done

echo "Completed processing products. Results in $OUTPUT_CSV"
