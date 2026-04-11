#!/usr/bin/env bash

curl -v 'https://prime.sweedpos.com/api/' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'app-path: /' \
  -H 'baggage: sentry-environment=prime,sentry-release=4.434.0,sentry-public_key=920510ec5736a8fdf59d74a2fa775ecf,sentry-trace_id=704a6f63b56b4d0090cb7a1d617d7a28,sentry-sample_rate=1,sentry-transaction=%2Fstore_setup%2Fproducts,sentry-sampled=true' \
  -H 'cache-control: no-cache' \
  -H 'content-type: application/json' \
  -b 'ph_phc_mGT2oFJv0Dwvi26vbLjQxFPvPLGHuUpFeyBknthFatj_posthog=%7B%22distinct_id%22%3A%2215826%22%2C%22%24sesid%22%3A%5B1757927547165%2C%2201994ca5-a11d-7813-8fa5-69590a140404%22%2C1757927547165%5D%2C%22%24epp%22%3Atrue%7D; cf_clearance=nsSBuc5zly4Z7fh_39JavYYzTIsaheDWElSUbw6PbQo-1757941458-1.2.1.1-q.q9WseEHep9RV47KDd7hFqY3Y9kyYEjt194TJDP9h77I5oJ6avHfTEVTIeUySgHfOgevZsifZ6IB2cmuzPAC2AdyUb7nQTjRHkCP5b30tg6fBwtq2d6fFbTR5Et1HzeX7aVIDNBmOI53aG31fgviNOXgEX471.hEfZ53NNdr5gI_Ov1XoI2z7lXOut8vSH1UxDfCyxCsXAK0E7nmlZGnPb1hJ3jbCGSr1XfAmK8gmg; __cf_bm=uoB8VUOZeLrC3edY22g4H1o8stJ0taRuhq5Lrll4C0I-1757962452-1.0.1.1-8YL6.6RIKye1.AHIJDbYgVON3NBUWr6oygZEuQCRktDRdBOMi6D5ShHL7I9IXhuViPJQN5kIWdOAyGxRqJTCOWl2ER8Go3Y7CMM8.OvBuK8; ph_phc_uTfLx9QshZZCdpHSkrdjgVL5GdXAPLpYz313pNqmnKJ_posthog=%7B%22distinct_id%22%3A%2217925%22%2C%22%24sesid%22%3A%5B1757963187350%2C%2201994ec5-4fc1-77b9-81f2-46adaa3b5d7d%22%2C1757963177921%5D%2C%22%24epp%22%3Atrue%7D' \
  -H 'dnt: 1' \
  -H 'origin: https://prime.sweedpos.com' \
  -H 'pragma: no-cache' \
  -H 'priority: u=1, i' \
  -H 'referer: https://prime.sweedpos.com/store_setup/products' \
  -H 'sec-ch-ua: "Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-fetch-dest: empty' \
  -H 'sec-fetch-mode: cors' \
  -H 'sec-fetch-site: same-origin' \
  -H 'sentry-trace: 704a6f63b56b4d0090cb7a1d617d7a28-a5e30c05e69549ee-1' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
  --data-raw '{"auth":"c0e393f7-59cc-4299-bd4e-5ba2c0843ec1","name":"store.product.group.list","params":{"enabled":true,"page":1,"pageSize":50,"reload":false},"id":"80522f59-19e6-436e-95de-01ee572112ea"}'
