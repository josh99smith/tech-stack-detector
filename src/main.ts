import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CheerioCrawler, type ProxyConfigurationOptions } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { collectDns, collectFromHtml, detectChallengePage, normalizeHeaders, parseCookies, truncateHtml } from './collect.js';
import { type FingerprintBundle, type ResolvedTechnology, TechnologyDetector } from './engine.js';

const CHARGE_EVENT = 'site-analyzed';

interface Input {
    urls?: (string | { url: string })[];
    maxConcurrency?: number;
    timeoutSecs?: number;
    detectViaDns?: boolean;
    includeDescriptions?: boolean;
    includeEvidence?: boolean;
    maxRetries?: number;
    proxyConfiguration?: ProxyConfigurationOptions & { useApifyProxy?: boolean };
}

interface TechnologyOutput {
    name: string;
    slug: string;
    categories: string[];
    version: string | null;
    confidence: number;
    website: string | null;
    cpe?: string;
    description?: string;
    evidence?: string[];
}

interface SuccessItem {
    url: string;
    finalUrl: string;
    success: true;
    statusCode: number;
    title: string | null;
    technologyCount: number;
    /** Flat list of technology names, handy for CSV exports and spreadsheet filters. */
    technologyNames: string[];
    technologies: TechnologyOutput[];
    byCategory: Record<string, string[]>;
    byGroup: Record<string, string[]>;
    server: string | null;
    responseTimeMs: number;
    fetchedAt: string;
}

interface FailureItem {
    url: string;
    success: false;
    errorType: 'invalid-url' | 'dns' | 'timeout' | 'blocked' | 'http-error' | 'network' | 'not-html' | 'other';
    error: string;
    statusCode?: number;
    fetchedAt: string;
}

function normalizeUrl(raw: string): string | null {
    let value = raw.trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
        const parsed = new URL(value);
        if (!parsed.hostname.includes('.')) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

export function categorizeError(message: string, statusCode?: number): FailureItem['errorType'] {
    const m = message.toLowerCase();
    // Crawlee reports HTTP failures as "500 - Internal Server Error" / "received 403 status code".
    const fromMessage = /^(\d{3}) - /.exec(message)?.[1] ?? /received (\d{3}) status code/.exec(message)?.[1];
    const status = statusCode ?? (fromMessage ? Number(fromMessage) : undefined);
    if (status === 403 || status === 429 || status === 503 || m.includes('blocked') || m.includes('captcha')) return 'blocked';
    if (status && status >= 400) return 'http-error';
    if (m.includes('enotfound') || m.includes('getaddrinfo') || m.includes('dns')) return 'dns';
    if (m.includes('timeout') || m.includes('timed out') || m.includes('etimedout')) return 'timeout';
    if (m.includes('econnrefused') || m.includes('econnreset') || m.includes('socket') || m.includes('tls') || m.includes('certificate'))
        return 'network';
    return 'other';
}

function shapeTechnologies(list: ResolvedTechnology[], includeDescriptions: boolean, includeEvidence: boolean): TechnologyOutput[] {
    return list.map((t) => {
        const out: TechnologyOutput = {
            name: t.name,
            slug: t.slug,
            categories: t.categories,
            version: t.version,
            confidence: t.confidence,
            website: t.website,
        };
        if (t.cpe) out.cpe = t.cpe;
        if (includeDescriptions && t.description) out.description = t.description;
        if (includeEvidence) out.evidence = t.evidence;
        return out;
    });
}

function groupBy(list: ResolvedTechnology[], key: 'categories' | 'groups'): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const t of list) for (const k of t[key]) (out[k] ??= []).push(t.name);
    return out;
}

await Actor.init();

Actor.on('aborting', async () => {
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};
const maxConcurrency = Math.min(Math.max(input.maxConcurrency ?? 10, 1), 50);
const timeoutSecs = Math.min(Math.max(input.timeoutSecs ?? 30, 5), 120);
const detectViaDns = input.detectViaDns ?? true;
const includeDescriptions = input.includeDescriptions ?? false;
const includeEvidence = input.includeEvidence ?? false;
const maxRetries = Math.min(Math.max(input.maxRetries ?? 1, 0), 5);

const rawUrls = (input.urls ?? []).map((u) => (typeof u === 'string' ? u : u?.url ?? ''));
if (rawUrls.length === 0) {
    await Actor.fail('Input "urls" is empty. Provide at least one website URL, e.g. ["https://www.shopify.com"].');
}

const seen = new Set<string>();
const requests: { url: string; uniqueKey: string; userData: { originalUrl: string } }[] = [];
const failures: FailureItem[] = [];
for (const raw of rawUrls) {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
        failures.push({ url: raw, success: false, errorType: 'invalid-url', error: 'Not a valid website URL', fetchedAt: new Date().toISOString() });
        continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    requests.push({ url: normalized, uniqueKey: normalized, userData: { originalUrl: raw } });
}
if (failures.length) await Actor.pushData(failures);

log.info(`Loading fingerprint database...`);
// The bundle lives in src/data and is not copied by tsc; this resolves correctly from both src/ (tsx) and dist/ (node).
const bundlePath = fileURLToPath(new URL('../src/data/fingerprints.json', import.meta.url));
const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as FingerprintBundle;
const detector = new TechnologyDetector(bundle);
log.info(`Loaded ${bundle.technologyCount} technology fingerprints (snapshot ${bundle.fetchedAt.slice(0, 10)}).`);
log.info(`Analyzing ${requests.length} website(s) with concurrency ${maxConcurrency}.`);

const proxyConfiguration = input.proxyConfiguration?.useApifyProxy
    ? await Actor.createProxyConfiguration(input.proxyConfiguration)
    : undefined;

const chargingManager = Actor.getChargingManager();
const { isPayPerEvent } = chargingManager.getPricingInfo();
let analyzed = 0;
let charged = 0;
let failed = 0;
let stopBecauseOfBudget = false;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    minConcurrency: Math.min(maxConcurrency, 2),
    maxRequestRetries: maxRetries,
    navigationTimeoutSecs: timeoutSecs,
    requestHandlerTimeoutSecs: timeoutSecs + 90,
    useSessionPool: true,
    ignoreSslErrors: true,
    persistCookiesPerSession: false,
    additionalMimeTypes: ['application/xhtml+xml', 'text/plain', 'application/json', 'application/pdf', 'application/octet-stream', 'image/*'],
    async requestHandler({ request, response, body, $, contentType }) {
        if (stopBecauseOfBudget) return;
        const started = Date.now();
        const mime = contentType?.type ?? String(response.headers['content-type'] ?? '').split(';')[0].trim();
        if (typeof $ !== 'function' || (mime && !/html|xml/i.test(mime))) {
            failed += 1;
            const item: FailureItem = {
                url: request.userData.originalUrl,
                success: false,
                errorType: 'not-html',
                error: `The URL returned ${mime || 'a non-HTML response'} instead of a web page, so there is nothing to analyze. It was not charged.`,
                statusCode: response.statusCode,
                fetchedAt: new Date().toISOString(),
            };
            log.warning(`${request.loadedUrl ?? request.url}: not-html (${mime || 'unknown content type'})`);
            await Actor.pushData(item);
            return;
        }
        const html = truncateHtml(typeof body === 'string' ? body : body.toString('utf8'));
        const headers = normalizeHeaders(response.headers as Record<string, string | string[] | undefined>);
        const cookies = parseCookies(headers['set-cookie']);
        const fromHtml = collectFromHtml($);
        const finalUrl = request.loadedUrl ?? request.url;

        const challenge = detectChallengePage(fromHtml.title, html, response.statusCode ?? 200);
        if (challenge) {
            failed += 1;
            const item: FailureItem = {
                url: request.userData.originalUrl,
                success: false,
                errorType: 'blocked',
                error: `${challenge}. The page could not be analyzed, so it was not charged. Enabling Apify Proxy (residential) may help.`,
                statusCode: response.statusCode,
                fetchedAt: new Date().toISOString(),
            };
            log.warning(`${finalUrl}: blocked - ${challenge}`);
            await Actor.pushData(item); // free of charge
            return;
        }

        // A 4xx/5xx page or an empty body is not the website the user asked to analyze; report it free of charge,
        // consistent with how thrown HTTP errors are categorised.
        const statusCode = response.statusCode ?? 200;
        if (statusCode >= 400 || html.trim().length === 0) {
            failed += 1;
            const item: FailureItem = {
                url: request.userData.originalUrl,
                success: false,
                errorType: statusCode >= 400 ? 'http-error' : 'not-html',
                error:
                    statusCode >= 400
                        ? `The server responded with HTTP ${statusCode}, so the page could not be analyzed. It was not charged.`
                        : 'The server returned an empty response, so there is nothing to analyze. It was not charged.',
                statusCode,
                fetchedAt: new Date().toISOString(),
            };
            log.warning(`${finalUrl}: ${item.errorType} (HTTP ${statusCode})`);
            await Actor.pushData(item); // free of charge
            return;
        }

        const dns = detectViaDns ? await collectDns(new URL(finalUrl).hostname) : undefined;

        const technologies = detector.detect({
            url: finalUrl,
            html,
            headers,
            cookies,
            dns,
            ...fromHtml,
        });

        const item: SuccessItem = {
            url: request.userData.originalUrl,
            finalUrl,
            success: true,
            statusCode: response.statusCode ?? 200,
            title: fromHtml.title,
            technologyCount: technologies.length,
            technologyNames: technologies.map((t) => t.name),
            technologies: shapeTechnologies(technologies, includeDescriptions, includeEvidence),
            byCategory: groupBy(technologies, 'categories'),
            byGroup: groupBy(technologies, 'groups'),
            server: headers.server?.[0] ?? null,
            responseTimeMs: Date.now() - started,
            fetchedAt: new Date().toISOString(),
        };

        const { eventChargeLimitReached } = await Actor.pushData(item, CHARGE_EVENT);
        analyzed += 1;
        charged += 1;
        log.info(`${finalUrl}: ${technologies.length} technologies (${technologies.slice(0, 5).map((t) => t.name).join(', ')}${technologies.length > 5 ? ', ...' : ''})`);
        if (eventChargeLimitReached) {
            stopBecauseOfBudget = true;
            log.warning('Maximum charge limit for this run reached; stopping early. Raise the run cost limit to analyze more sites.');
            await crawler.autoscaledPool?.abort();
        }
    },
    async failedRequestHandler({ request }, error) {
        failed += 1;
        const statusCode = (error as { statusCode?: number }).statusCode ?? (error as { response?: { statusCode?: number } }).response?.statusCode;
        const message = error.message?.trim() || `${error.name || 'Connection failed'}: the server did not send a usable response`;
        const item: FailureItem = {
            url: request.userData.originalUrl,
            success: false,
            errorType: categorizeError(message, statusCode),
            error: message.slice(0, 500),
            statusCode,
            fetchedAt: new Date().toISOString(),
        };
        log.warning(`${request.url}: ${item.errorType} - ${item.error}`);
        await Actor.pushData(item); // free of charge: users only pay for analyzed sites
    },
});

await crawler.run(requests);

const summary = {
    requested: rawUrls.length,
    analyzed,
    failed: failed + failures.length,
    chargedEvents: isPayPerEvent ? charged : undefined,
    stoppedEarlyDueToBudget: stopBecauseOfBudget,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);

await Actor.exit();
