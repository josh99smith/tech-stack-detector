/**
 * Turns an HTTP response + parsed HTML into the PageData the engine consumes.
 */
import { resolveCname, resolveMx, resolveNs, resolveSoa, resolveTxt } from 'node:dns/promises';

import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import type { DomElement, PageData } from './engine.js';

type CheerioAPI = CheerioCrawlingContext['$'];

const MAX_HTML = 2_000_000;
const MAX_INLINE = 200_000;

export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        out[key.toLowerCase()] = Array.isArray(value) ? value : [value];
    }
    return out;
}

export function parseCookies(setCookie: string[] | undefined): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const line of setCookie ?? []) {
        const first = line.split(';')[0] ?? '';
        const eq = first.indexOf('=');
        if (eq === -1) continue;
        const name = first.slice(0, eq).trim().toLowerCase();
        const value = first.slice(eq + 1).trim();
        if (!name) continue;
        (out[name] ??= []).push(value);
    }
    return out;
}

export function collectFromHtml($: CheerioAPI): Pick<PageData, 'meta' | 'scriptSrc' | 'scripts' | 'css' | 'text' | 'querySelectorAll'> & {
    title: string | null;
} {
    const meta: Record<string, string[]> = {};
    $('meta').each((_, el) => {
        const name = ($(el).attr('name') ?? $(el).attr('property') ?? $(el).attr('http-equiv') ?? '').toLowerCase();
        const content = $(el).attr('content');
        if (!name || content === undefined) return;
        (meta[name] ??= []).push(content);
    });

    const scriptSrc: string[] = [];
    const scripts: string[] = [];
    $('script').each((_, el) => {
        const src = $(el).attr('src');
        if (src) scriptSrc.push(src);
        else {
            const body = $(el).text();
            if (body) scripts.push(body.slice(0, MAX_INLINE));
        }
    });
    // Stylesheet links help too (e.g. /wp-content/ paths, CDN-hosted CSS frameworks).
    $('link[rel~="stylesheet"][href], link[rel="preload"][href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) scriptSrc.push(href);
    });

    const css: string[] = [];
    $('style').each((_, el) => {
        const body = $(el).text();
        if (body) css.push(body.slice(0, MAX_INLINE));
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_INLINE);
    const title = $('title').first().text().trim() || null;

    const querySelectorAll = (selector: string): DomElement[] => {
        const found = $(selector).toArray();
        return found.map((el) => ({
            text: () => $(el).text(),
            attr: (name: string) => $(el).attr(name),
        }));
    };

    return { meta, scriptSrc, scripts, css, text: bodyText, querySelectorAll, title };
}

export function truncateHtml(html: string): string {
    return html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
}

/** Looks up DNS records used by fingerprints (TXT, MX, NS, SOA, CNAME). Failures are ignored. */
export async function collectDns(hostname: string, timeoutMs = 4000): Promise<Record<string, string[]>> {
    const apex = hostname.replace(/^www\./i, '');
    const withTimeout = async <T>(p: Promise<T>): Promise<T | undefined> => {
        const timeout = new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), timeoutMs);
        });
        return Promise.race([p.catch(() => undefined), timeout]);
    };

    const [txt, mx, ns, soa, cname] = await Promise.all([
        withTimeout(resolveTxt(apex)),
        withTimeout(resolveMx(apex)),
        withTimeout(resolveNs(apex)),
        withTimeout(resolveSoa(apex)),
        withTimeout(resolveCname(hostname)),
    ]);
    const out: Record<string, string[]> = {};
    if (txt) out.txt = txt.map((chunks) => chunks.join(''));
    if (mx) out.mx = mx.map((m) => m.exchange);
    if (ns) out.ns = ns;
    if (soa) out.soa = [`${soa.nsname} ${soa.hostmaster}`];
    if (cname) out.cname = cname;
    return out;
}
