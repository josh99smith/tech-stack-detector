Find out **what any website is built with** in seconds. Paste a list of URLs and get back the CMS, ecommerce platform, JavaScript frameworks, analytics and marketing tags, CDN, hosting provider, email provider, security tools and more, matched against a database of **7,600+ technology fingerprints**.

It is a **Wappalyzer / BuiltWith alternative** that runs as an API: no browser extension, no monthly subscription, no per-seat licence. You pay a flat price per website analyzed, and websites that cannot be reached are reported **free of charge**.

## What can you do with Website Tech Stack Detector?

- **Qualify sales leads** by technology: find every prospect running Shopify, HubSpot, Magento, WordPress + WooCommerce, Salesforce, Intercom, and so on.
- **Enrich CRM records** with the tech stack of each account (works great with the Apify integrations for Google Sheets, Airtable, HubSpot, Zapier and Make).
- **Competitive research**: see which analytics, A/B testing, personalisation and advertising tools competitors deploy.
- **Migration and agency prospecting**: build lists of sites on an outdated CMS, an end-of-life framework, or a platform you specialise in.
- **Security and compliance checks**: spot exposed server versions, missing HSTS, third-party trackers or unexpected scripts across your own portfolio of domains.
- **Feed AI agents**: the Actor is exposed through the Apify MCP server, so an agent can call it as a tool ("what is example.com built with?").

## How it works

For every URL the Actor downloads the HTML page and inspects HTTP headers, cookies, meta tags, inline scripts and styles, script and stylesheet URLs, the DOM structure and (optionally) DNS records. Every signal is matched against the open-source fingerprint database maintained by the [webappanalyzer](https://github.com/enthec/webappanalyzer) project, the community continuation of the original Wappalyzer rules. Detections also resolve *implied* technologies (for example WordPress implies PHP and MySQL) and drop contradictory ones.

Detection is HTTP-only, so it is fast (typically 1 to 3 seconds per site) and cheap. Technologies that only reveal themselves after JavaScript executes in a browser are not detected; see the FAQ.

## How to use it

1. Open the Actor and paste your website URLs into **Website URLs**, one per line. The scheme is optional.
2. Optionally turn on **Include detection evidence** to see exactly which header, script or cookie triggered each match.
3. Click **Start**. Results appear in the **Output** tab as they arrive.
4. Download the dataset as JSON, CSV, Excel or XML, or connect it to your tools with an integration.

To run it programmatically, use the **API** tab: every Apify Actor can be started with a single HTTP request or with the official [JavaScript](https://docs.apify.com/api/client/js) and [Python](https://docs.apify.com/api/client/python) clients.

```json
{
    "urls": ["https://www.shopify.com", "wordpress.org", "https://www.nytimes.com"],
    "detectViaDns": true,
    "includeEvidence": false
}
```

## Output

One record per website. Successful records look like this (trimmed):

```json
{
    "url": "https://wordpress.org/",
    "finalUrl": "https://wordpress.org/",
    "success": true,
    "statusCode": 200,
    "title": "Blog Tool, Publishing Platform, and CMS",
    "technologyCount": 13,
    "technologies": [
        { "name": "WordPress", "slug": "wordpress", "categories": ["CMS", "Blogs"], "version": "7.2", "confidence": 100, "website": "https://wordpress.org" },
        { "name": "Gutenberg", "slug": "gutenberg", "categories": ["WordPress plugins", "Editors"], "version": "24.0.0", "confidence": 100, "website": "https://wordpress.org/gutenberg/" },
        { "name": "Nginx", "slug": "nginx", "categories": ["Web servers", "Reverse proxies"], "version": null, "confidence": 100, "website": "http://nginx.org/en" },
        { "name": "Google Tag Manager", "slug": "google-tag-manager", "categories": ["Tag managers"], "version": null, "confidence": 100, "website": "http://www.google.com/tagmanager" }
    ],
    "byCategory": {
        "CMS": ["WordPress"],
        "Web servers": ["Nginx"],
        "Tag managers": ["Google Tag Manager"],
        "Security": ["HSTS"]
    },
    "byGroup": { "Content": ["WordPress"], "Servers": ["Nginx"], "Analytics": ["Google Tag Manager"] },
    "server": "nginx",
    "responseTimeMs": 474,
    "fetchedAt": "2026-09-18T20:24:11.000Z"
}
```

Websites that could not be analyzed are still recorded, so nothing silently disappears from your list:

```json
{ "url": "https://this-domain-does-not-exist.example", "success": false, "errorType": "dns", "error": "getaddrinfo ENOTFOUND ...", "fetchedAt": "..." }
```

### Fields

| Field | Description |
| --- | --- |
| `url` / `finalUrl` | The URL you supplied and the URL after redirects. |
| `success` | `true` when the page was fetched and analyzed. Only these records are billed. |
| `statusCode` | HTTP status of the final response. |
| `title` | The page `<title>`. |
| `technologyCount` | Number of technologies detected. |
| `technologies[]` | `name`, `slug`, `categories`, `version` (when it can be determined), `confidence` (0 to 100), vendor `website`, optional `cpe` identifier, optional `description` and `evidence`. |
| `byCategory` / `byGroup` | Technology names grouped by category (CMS, CDN, Analytics, ...) and by broader group (Content, Servers, Marketing, ...). |
| `server` | Raw `Server` response header. |
| `errorType` | For failures: `invalid-url`, `dns`, `timeout`, `blocked`, `http-error`, `network` or `other`. |

## Pricing: how much does it cost to detect a website's tech stack?

You pay a **flat price per successfully analyzed website** (see the price shown next to the Start button). Unreachable or invalid URLs cost nothing. There is no charge for Actor start-up, and the Actor stops automatically when it reaches the maximum cost you set for a run, so a large list never produces a surprise bill.

For comparison, a 1,000-domain lookup on this Actor costs a fraction of a single month of a BuiltWith or Wappalyzer subscription, and you only pay for what you actually run.

## Tips

- **Speed**: raise **Max concurrency** (up to 50) for large lists. Most runs finish at several hundred sites per minute.
- **Blocked sites**: a few websites refuse cloud IP addresses. Enable **Proxy configuration > Apify Proxy** to route those through residential or datacenter proxies (proxy traffic is billed by Apify separately).
- **Auditing**: switch on **Include detection evidence** to see the exact header, cookie, script URL or DNS record behind each detection. Handy when a result looks surprising.
- **Fresh fingerprints**: the fingerprint database is refreshed with every release of the Actor. The snapshot date is printed at the top of every run log.
- **Scheduling**: use the **Schedule** tab to re-run the same list weekly or monthly and track technology changes over time.

## FAQ

**Why does it find fewer technologies than my browser extension on some sites?**
Browser extensions execute the page's JavaScript and read global variables. This Actor analyzes the served HTML, headers, cookies and DNS records, which covers the large majority of fingerprints and is many times faster and cheaper. Single-page applications that render everything client-side will show fewer detections. A JavaScript-rendering mode is on the roadmap; tell us in the Issues tab if you need it.

**Is the data accurate?**
Each fingerprint is a community-maintained rule. Confidence values reflect how many independent signals matched. Occasional false positives are possible when a page merely mentions another platform; use the evidence field to review them.

**Which URL is analyzed?**
Only the page you provide (usually the home page), after following redirects. Sub-pages are not crawled.

**Is this legal?**
The Actor reads publicly served pages exactly like a browser does, at low request rates, and stores no personal data. You are responsible for using the results in compliance with the laws that apply to you.

## Support and feedback

Found a site that is misdetected, or a technology that is missing? Open a ticket in the **Issues** tab of this Actor. Fingerprint contributions are welcome upstream at [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer).

This Actor is open source under the GPL-3.0 licence. The technology fingerprints are © their contributors, GPL-3.0.
