# Changelog

## 0.1.3 (2026-09-23)

- Listing: joined the Best Damn series. New title "Best Damn Tech Stack Detector", new description, icon and README banner. No change to inputs, output or pricing.
- README: new "Integrate and automate your workflow" section (Make, Zapier, n8n, Slack, Airbyte, GitHub, Google Drive, webhooks).

## 0.1.2 (2026-09-20)

- Duplicate input URLs are now deduplicated by the Actor instead of being rejected by input validation, as the field description already promised.

## 0.1.1 (2026-09-20)

- Fixed: pages answering with HTTP 4xx/5xx (for example a 404 with an HTML body) or an empty body were analysed from headers alone and billed. They are now reported as free `http-error` / `not-html` failures, consistent with how connection-level HTTP errors were already handled.

## 0.1.0 (2026-09-18)

- Initial release: HTTP-only detection against 7,628 fingerprints (headers, cookies, meta, HTML, scripts, styles, DOM selectors, DNS records).
- Implied / required / excluded technology resolution, version extraction and confidence scoring.
- Unreachable or invalid URLs are reported in the dataset and never billed.
