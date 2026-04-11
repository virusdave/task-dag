#!/usr/bin/env bash

curl -v 'https://prime.sweedpos.com/api/' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'app-path: /' \
  -H 'baggage: sentry-environment=prime,sentry-release=4.434.0,sentry-public_key=920510ec5736a8fdf59d74a2fa775ecf,sentry-trace_id=ae47b85af68745da90a12029e7f8db0b,sentry-sample_rate=1,sentry-transaction=%2Fstore_setup%2Fproducts,sentry-sampled=true' \
  -H 'cache-control: no-cache' \
  -H 'content-type: application/json' \
  -b 'ph_phc_mGT2oFJv0Dwvi26vbLjQxFPvPLGHuUpFeyBknthFatj_posthog=%7B%22distinct_id%22%3A%2215826%22%2C%22%24sesid%22%3A%5B1757927547165%2C%2201994ca5-a11d-7813-8fa5-69590a140404%22%2C1757927547165%5D%2C%22%24epp%22%3Atrue%7D; intercom-device-id-niia51q8=1f1cece6-2506-40dc-9e3b-8332e5b4d3f8; cf_clearance=lc9ub1wIXYXvu7TrkCB276Rqm.RGffckXOuvFiW8l24-1757983778-1.2.1.1-svyPvYxnXzmm8Qd_RgveS7qelRmdsxifptgukJK2ZGw2woaZVzl7jk1lKNHOlY2WrYOGKKBQ6Luf3upc8.tO.WIdzuBgIg4Thu3T8lRfOrrNxST4FUp0K59bmuZnyWJia2RMAQ5cvu1WB0Tb87sSrQyXxdUIU3IWHfCqk1_1LB2QUaGABEWsAd2tl9j0wHUDtludf7TCBRExr6FxTmwHmWWaEe1xE7HcN2RYTaCL1zk; intercom-session-niia51q8=eWxac1d6b2NFb3krN2pNSWZHVkFHbmd4SzJnM0xLWDdpVlMvdDFMaWhEUlpKazNVOTBnWmh6d3NXRmdUVTV5Y21MTFZiVzkxazdKUFdLSm9LWUEvWDdUdmgzN09xMGpnRjVBSmJWSllmcGs9LS1VbmNWSlRvVUFFSnFnT21raHM3RUZnPT0=--356b6ec268ee189a7010addc701f53a412d0b802; __cf_bm=CsxN.bg2IEev5G6KKiT4WZL5mmpCQSkZnR3claTwzyw-1757989094-1.0.1.1-BHNmakg1NNI6Fz6q26j.snPd5cU5sWuqbbiMRqQk8EWzkzRQ8ChG_rbyqp0v2boADenlqKF1OGAzYBMMflcuWKyMy4ll5JFgbxr_g6em9Yo; ph_phc_uTfLx9QshZZCdpHSkrdjgVL5GdXAPLpYz313pNqmnKJ_posthog=%7B%22distinct_id%22%3A%2217925%22%2C%22%24sesid%22%3A%5B1757988264984%2C%2201994feb-f47a-7b4a-acd7-4980f389a068%22%2C1757982487674%5D%2C%22%24epp%22%3Atrue%7D' \
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
  -H 'sentry-trace: ae47b85af68745da90a12029e7f8db0b-b265bb331b38f140-1' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
  --data-raw '{"auth":"c0e393f7-59cc-4299-bd4e-5ba2c0843ec1","name":"store.product.list.short","params":{"tab":"pk","page":1,"pageSize":500,"reload":false,"advancedSearch":true},"id":"27483838-0e09-44c6-baca-47b3a542de93"}'
