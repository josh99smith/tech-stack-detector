import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CheerioCrawler, type ProxyConfigurationOptions } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { collectDns, collectFromHtml, normalizeHeaders, parseCookies, truncateHtml } from './collect.js';
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
    errorType: 'invalid-url' | 'dns' | 'timeout' | 'blocked' | 'http-error' | 'network' | 'other';
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
    if (statusCode === 403 || statusCode === 429 || m.includes('blocked') || m.includes('captcha')) return 'blocked';
    if (statusCode && statusCode >= 400) return 'http-error';
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
    requestHandlerTimeoutSecs: timeoutSecs + 30,
    useSessionPool: true,
    persistCookiesPerSession: false,
    ignoreSslErrors: true,
    additionalMimeTypes: ['application/xhtml+xml', 'text/plain'],
    async requestHandler({ request, response, body, $ }) {
        if (stopBecauseOfBudget) return;
        const started = Date.now();
        const html = truncateHtml(typeof body === 'string' ? body : body.toString('utf8'));
        const headers = normalizeHeaders(response.headers as Record<string, string | string[] | undefined>);
        const cookies = parseCookies(headers['set-cookie']);
        const fromHtml = collectFromHtml($);
        const finalUrl = request.loadedUrl ?? request.url;
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
            technologies: shapeTechnologies(technologies, includeDescriptions, includeEvidence),
            byCategory: groupBy(technologies, 'categories'),
            byGroup: groupBy(technologies, 'groups'),
            server: headers.server?.[0] ?? null,
            responseTimeMs: Date.now() - started,
            fetchedAt: new Date().toISOString(),
        };

        const { eventChargeLimitReached, chargedCount } = await Actor.pushData(item, CHARGE_EVENT);
        analyzed += 1;
        charged += chargedCount ?? 0;
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
        const item: FailureItem = {
            url: request.userData.originalUrl,
            success: false,
            errorType: categorizeError(error.message, statusCode),
            error: error.message.slice(0, 500),
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
