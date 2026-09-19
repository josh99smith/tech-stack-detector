/**
 * Technology fingerprint matching engine.
 *
 * Implements the Wappalyzer pattern format used by the enthec/webappanalyzer
 * fingerprint database: each pattern is a case-insensitive regular expression,
 * optionally followed by `\;version:<expr>` and `\;confidence:<n>` tags.
 */

export interface RawTechnology {
    cats: number[];
    website?: string;
    description?: string;
    cpe?: string;
    implies?: string | string[];
    requires?: string | string[];
    requiresCategory?: number | number[];
    excludes?: string | string[];
    html?: string | string[];
    text?: string | string[];
    url?: string | string[];
    css?: string | string[];
    scriptSrc?: string | string[];
    scripts?: string | string[];
    robots?: string | string[];
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    meta?: Record<string, string | string[]>;
    dns?: Record<string, string | string[]>;
    js?: Record<string, string>;
    dom?: string | string[] | Record<string, DomRule>;
}

export interface DomRule {
    exists?: string;
    text?: string | string[];
    attributes?: Record<string, string | string[]>;
    properties?: Record<string, string>;
}

export interface FingerprintBundle {
    source: string;
    license: string;
    fetchedAt: string;
    technologyCount: number;
    categories: Record<string, { name: string; priority: number; groups?: number[] }>;
    groups: Record<string, { name: string }>;
    technologies: Record<string, RawTechnology>;
}

export interface CompiledPattern {
    regex: RegExp;
    version?: string;
    confidence: number;
}

interface CompiledDomRule {
    selector: string;
    /** Per comma-branch, the lower-cased literals that must all occur in the raw HTML for the branch to match.
     *  If every branch has a missing literal the selector cannot match and the DOM query is skipped. */
    literals: string[][];
    exists?: CompiledPattern[];
    text?: CompiledPattern[];
    attributes?: Record<string, CompiledPattern[]>;
}

/** Splits a selector list on top-level commas (ignoring commas inside quotes or brackets). */
function splitSelectorList(selector: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = '';
    for (const ch of selector) {
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[' || ch === '(') depth++;
        else if (ch === ']' || ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

/**
 * For each comma-separated branch of a selector, the lower-cased literal tokens that MUST occur in the
 * document for that branch to match: `#id`, `.class` and quoted attribute values (`[href*='wp-content']`).
 * A branch with no usable literal (e.g. `iframe`, `[data-foo]`) yields an empty list and always runs.
 */
export function selectorLiterals(selector: string): string[][] {
    return splitSelectorList(selector).map((branch) => {
        const out = new Set<string>();
        const attrValue = /\[[^\]]*?[*^$|~]?=\s*(?:'([^']+)'|"([^"]+)"|([^\]\s'"]+))\s*[is]?\s*\]/g;
        for (const m of branch.matchAll(attrValue)) {
            const v = (m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase();
            if (v.length >= 4) out.add(v);
        }
        // Strip quoted strings and bracket expressions before looking for #id / .class tokens.
        const bare = branch.replace(/\[[^\]]*\]/g, ' ').replace(/'[^']*'|"[^"]*"/g, ' ');
        for (const m of bare.matchAll(/[#.]([A-Za-z0-9_-]{4,})/g)) out.add(m[1].toLowerCase());
        return [...out];
    });
}

/**
 * Single-pass substring index: a Bloom filter over every 4-character gram of the (lower-cased) document.
 * `mayContain(literal)` is false only when the literal definitely does not occur, so it is a safe
 * pre-filter for DOM selectors: building it is O(n) once per page, each check is a few array reads.
 */
/* eslint-disable no-bitwise -- bit-packed Bloom filter */
export class GramIndex {
    private readonly bits: Uint8Array;
    private readonly mask: number;

    constructor(text: string, bitsPow2 = 24) {
        this.bits = new Uint8Array(1 << (bitsPow2 - 3));
        this.mask = (1 << bitsPow2) - 1;
        const n = text.length;
        // Hash each 4-gram directly (a few multiplies per position; ~10 ms per MB).
        for (let i = 0; i + 4 <= n; i++) {
            const g = ((((text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) * 31 + text.charCodeAt(i + 2)) * 31 + text.charCodeAt(i + 3)) | 0) & this.mask;
            this.bits[g >>> 3] |= 1 << (g & 7);
        }
    }

    private hasGram(text: string, i: number): boolean {
        const g = ((((text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) * 31 + text.charCodeAt(i + 2)) * 31 + text.charCodeAt(i + 3)) | 0) & this.mask;
        return (this.bits[g >>> 3] & (1 << (g & 7))) !== 0;
    }

    /** False means the literal is certainly absent. Literals shorter than 4 chars are always "maybe". */
    mayContain(literal: string): boolean {
        if (literal.length < 4) return true;
        for (let i = 0; i + 4 <= literal.length; i++) if (!this.hasGram(literal, i)) return false;
        return true;
    }
}
/* eslint-enable no-bitwise */

export interface CompiledTechnology {
    name: string;
    slug: string;
    cats: number[];
    website?: string;
    description?: string;
    cpe?: string;
    implies: { name: string; confidence: number; version?: string }[];
    requires: string[];
    requiresCategory: number[];
    excludes: string[];
    html: CompiledPattern[];
    text: CompiledPattern[];
    url: CompiledPattern[];
    css: CompiledPattern[];
    scriptSrc: CompiledPattern[];
    scripts: CompiledPattern[];
    robots: CompiledPattern[];
    headers: Record<string, CompiledPattern[]>;
    cookies: Record<string, CompiledPattern[]>;
    meta: Record<string, CompiledPattern[]>;
    dns: Record<string, CompiledPattern[]>;
    dom: CompiledDomRule[];
}

/** Everything we can observe about a page without executing JavaScript. */
export interface PageData {
    url: string;
    html?: string;
    text?: string;
    css?: string[];
    scriptSrc?: string[];
    scripts?: string[];
    robots?: string;
    headers?: Record<string, string[]>;
    cookies?: Record<string, string[]>;
    meta?: Record<string, string[]>;
    dns?: Record<string, string[]>;
    /** Evaluates a CSS selector and returns matched elements. Provided by the caller (cheerio). */
    querySelectorAll?: (selector: string) => DomElement[];
}

export interface DomElement {
    text(): string;
    attr(name: string): string | undefined;
}

export interface Detection {
    tech: CompiledTechnology;
    confidence: number;
    version?: string;
    /** Which kind of evidence produced this detection, e.g. `headers:server`. */
    evidence: string;
}

export interface ResolvedTechnology {
    name: string;
    slug: string;
    categories: string[];
    groups: string[];
    version: string | null;
    confidence: number;
    website: string | null;
    cpe?: string;
    description?: string;
    evidence: string[];
}

const toArray = <T>(value: T | T[] | undefined): T[] => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
};

export const slugify = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

/** Parses a single raw pattern string, e.g. `^WordPress(?: ([\d.]+))?\;version:\1`. */
export function compilePattern(raw: string): CompiledPattern {
    const [regexSource, ...tags] = raw.split('\\;');
    let regex: RegExp;
    try {
        regex = new RegExp(regexSource.replace(/\//g, '\\/'), 'i');
    } catch {
        // A handful of upstream patterns use syntax the JS engine rejects; never match them.
        regex = /(?!)/;
    }
    const pattern: CompiledPattern = { regex, confidence: 100 };
    for (const tag of tags) {
        const idx = tag.indexOf(':');
        if (idx === -1) continue;
        const key = tag.slice(0, idx);
        const value = tag.slice(idx + 1);
        if (key === 'version') pattern.version = value;
        else if (key === 'confidence') {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n)) pattern.confidence = Math.max(0, Math.min(100, n));
        }
    }
    return pattern;
}

const compileList = (value: string | string[] | undefined): CompiledPattern[] => toArray(value).map(compilePattern);

const compileMap = (value: Record<string, string | string[]> | undefined): Record<string, CompiledPattern[]> => {
    const out: Record<string, CompiledPattern[]> = {};
    if (!value) return out;
    for (const [key, patterns] of Object.entries(value)) {
        out[key.toLowerCase()] = compileList(patterns);
    }
    return out;
};

const compileDom = (value: RawTechnology['dom']): CompiledDomRule[] => {
    if (!value) return [];
    if (typeof value === 'string' || Array.isArray(value)) {
        return toArray(value).map((selector) => ({ selector, literals: selectorLiterals(selector), exists: [compilePattern('')] }));
    }
    return Object.entries(value).map(([selector, rule]) => {
        const compiled: CompiledDomRule = { selector, literals: selectorLiterals(selector) };
        if (rule.exists !== undefined) compiled.exists = [compilePattern(rule.exists)];
        if (rule.text !== undefined) compiled.text = compileList(rule.text);
        if (rule.attributes) {
            compiled.attributes = {};
            for (const [attr, patterns] of Object.entries(rule.attributes)) {
                compiled.attributes[attr] = compileList(patterns);
            }
        }
        return compiled;
    });
};

const parseImplies = (value: string | string[] | undefined) =>
    toArray(value).map((raw) => {
        const [name, ...tags] = raw.split('\\;');
        const entry: { name: string; confidence: number; version?: string } = { name, confidence: 100 };
        for (const tag of tags) {
            const [k, v] = tag.split(':');
            if (k === 'confidence') entry.confidence = Number.parseInt(v, 10) || 100;
            if (k === 'version') entry.version = v;
        }
        return entry;
    });

export function compileTechnology(name: string, raw: RawTechnology): CompiledTechnology {
    return {
        name,
        slug: slugify(name),
        cats: raw.cats ?? [],
        website: raw.website,
        description: raw.description,
        cpe: raw.cpe,
        implies: parseImplies(raw.implies),
        requires: toArray(raw.requires),
        requiresCategory: toArray(raw.requiresCategory),
        excludes: toArray(raw.excludes),
        html: compileList(raw.html),
        text: compileList(raw.text),
        url: compileList(raw.url),
        css: compileList(raw.css),
        scriptSrc: compileList(raw.scriptSrc),
        scripts: compileList(raw.scripts),
        robots: compileList(raw.robots),
        headers: compileMap(raw.headers),
        cookies: compileMap(raw.cookies),
        meta: compileMap(raw.meta),
        dns: compileMap(raw.dns),
        dom: compileDom(raw.dom),
    };
}

/** Substitutes capture groups (`\1`) and ternaries (`\1?a:b`) in a version expression. */
export function resolveVersion(pattern: CompiledPattern, value: string): string | undefined {
    if (!pattern.version) return undefined;
    const matches = pattern.regex.exec(value);
    if (!matches) return undefined;
    let resolved = pattern.version;
    matches.forEach((group, index) => {
        const ternary = new RegExp(`\\\\${index}\\?([^:]+):(.*)$`).exec(resolved);
        if (ternary && ternary.length === 3) {
            resolved = resolved.replace(ternary[0], group ? ternary[1] : ternary[2]);
        }
        resolved = resolved.trim().replace(new RegExp(`\\\\${index}`, 'g'), group ?? '');
    });
    resolved = resolved.trim();
    return resolved.length ? resolved : undefined;
}

const MAX_VALUE_LENGTH = 2_000_000;
const REGEX_HTML_LIMIT = 1_000_000;

function matchPatterns(
    tech: CompiledTechnology,
    patterns: CompiledPattern[],
    values: string[],
    evidence: string,
    out: Detection[],
): void {
    for (const pattern of patterns) {
        for (const rawValue of values) {
            const value = rawValue.length > MAX_VALUE_LENGTH ? rawValue.slice(0, MAX_VALUE_LENGTH) : rawValue;
            if (pattern.regex.test(value)) {
                out.push({
                    tech,
                    confidence: pattern.confidence,
                    version: resolveVersion(pattern, value),
                    evidence,
                });
                break; // one hit per pattern is enough
            }
        }
    }
}

function matchMap(
    tech: CompiledTechnology,
    patternMap: Record<string, CompiledPattern[]>,
    valueMap: Record<string, string[]> | undefined,
    kind: string,
    out: Detection[],
): void {
    if (!valueMap) return;
    for (const [key, patterns] of Object.entries(patternMap)) {
        const values = valueMap[key];
        if (!values || values.length === 0) continue;
        matchPatterns(tech, patterns, values, `${kind}:${key}`, out);
    }
}

function matchDom(tech: CompiledTechnology, page: PageData, out: Detection[], index?: GramIndex): void {
    if (!page.querySelectorAll || tech.dom.length === 0) return;
    for (const rule of tech.dom) {
        // Cheap pre-check: a selector that needs `#foo` or `[href*='bar']` cannot match a document that
        // never contains "foo" / "bar". Skips the vast majority of DOM queries on large pages.
        if (index && rule.literals.length && !rule.literals.some((branch) => branch.every((lit) => index.mayContain(lit)))) continue;
        let elements: DomElement[];
        try {
            elements = page.querySelectorAll(rule.selector);
        } catch {
            continue; // selector syntax unsupported by the HTML parser
        }
        if (elements.length === 0) continue;
        const evidence = `dom:${rule.selector}`;
        if (rule.exists) {
            out.push({ tech, confidence: rule.exists[0].confidence, version: undefined, evidence });
        }
        if (rule.text) {
            const texts = elements.map((el) => el.text()).filter(Boolean);
            matchPatterns(tech, rule.text, texts, evidence, out);
        }
        if (rule.attributes) {
            for (const [attr, patterns] of Object.entries(rule.attributes)) {
                const values = elements.map((el) => el.attr(attr)).filter((v): v is string => typeof v === 'string');
                matchPatterns(tech, patterns, values, `${evidence}[${attr}]`, out);
            }
        }
    }
}

export class TechnologyDetector {
    readonly technologies: Map<string, CompiledTechnology> = new Map();
    readonly categories: FingerprintBundle['categories'];
    readonly groups: FingerprintBundle['groups'];

    constructor(bundle: FingerprintBundle) {
        this.categories = bundle.categories;
        this.groups = bundle.groups;
        for (const [name, raw] of Object.entries(bundle.technologies)) {
            this.technologies.set(name, compileTechnology(name, raw));
        }
    }

    /** Runs every fingerprint against the collected page data and returns raw detections. */
    analyze(page: PageData): Detection[] {
        const out: Detection[] = [];
        // Regex families run against the first 1 MB: fingerprints live in <head> and early markup, and this
        // keeps CPU time bounded on multi-megabyte pages.
        const htmlForRegex = page.html && page.html.length > REGEX_HTML_LIMIT ? page.html.slice(0, REGEX_HTML_LIMIT) : page.html;
        const html = htmlForRegex ? [htmlForRegex] : [];
        const index = page.html ? new GramIndex(page.html.toLowerCase()) : undefined;
        const text = page.text ? [page.text] : [];
        const url = [page.url];
        for (const tech of this.technologies.values()) {
            if (tech.url.length) matchPatterns(tech, tech.url, url, 'url', out);
            if (tech.html.length && html.length) matchPatterns(tech, tech.html, html, 'html', out);
            if (tech.text.length && text.length) matchPatterns(tech, tech.text, text, 'text', out);
            if (tech.scriptSrc.length && page.scriptSrc?.length) {
                matchPatterns(tech, tech.scriptSrc, page.scriptSrc, 'scriptSrc', out);
            }
            if (tech.scripts.length && page.scripts?.length) matchPatterns(tech, tech.scripts, page.scripts, 'scripts', out);
            if (tech.css.length && page.css?.length) matchPatterns(tech, tech.css, page.css, 'css', out);
            if (tech.robots.length && page.robots) matchPatterns(tech, tech.robots, [page.robots], 'robots', out);
            matchMap(tech, tech.headers, page.headers, 'headers', out);
            matchMap(tech, tech.cookies, page.cookies, 'cookies', out);
            matchMap(tech, tech.meta, page.meta, 'meta', out);
            matchMap(tech, tech.dns, page.dns, 'dns', out);
            matchDom(tech, page, out, index);
        }
        return out;
    }

    /** Applies implies / requires / excludes and produces the final, deduplicated list. */
    resolve(detections: Detection[]): ResolvedTechnology[] {
        type Acc = { tech: CompiledTechnology; confidence: number; versions: string[]; evidence: Set<string> };
        const acc = new Map<string, Acc>();
        const add = (tech: CompiledTechnology, confidence: number, version: string | undefined, evidence: string) => {
            const existing = acc.get(tech.name);
            if (existing) {
                existing.confidence = Math.min(100, existing.confidence + confidence);
                if (version) existing.versions.push(version);
                existing.evidence.add(evidence);
            } else {
                acc.set(tech.name, {
                    tech,
                    confidence: Math.min(100, confidence),
                    versions: version ? [version] : [],
                    evidence: new Set([evidence]),
                });
            }
        };
        for (const d of detections) add(d.tech, d.confidence, d.version, d.evidence);

        // Implied technologies, applied until a fixed point is reached.
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 20) {
            changed = false;
            for (const entry of [...acc.values()]) {
                for (const implied of entry.tech.implies) {
                    const tech = this.technologies.get(implied.name);
                    if (!tech) continue;
                    if (acc.has(tech.name)) continue;
                    add(tech, Math.min(entry.confidence, implied.confidence), implied.version, `implied-by:${entry.tech.name}`);
                    changed = true;
                }
            }
        }

        // Requirements: drop technologies whose prerequisites are absent (repeat until stable).
        changed = true;
        guard = 0;
        while (changed && guard++ < 20) {
            changed = false;
            for (const entry of [...acc.values()]) {
                const { tech } = entry;
                if (tech.requires.length && !tech.requires.some((name) => acc.has(name))) {
                    acc.delete(tech.name);
                    changed = true;
                    continue;
                }
                if (tech.requiresCategory.length) {
                    const present = [...acc.values()].some((e) => e.tech.cats.some((c) => tech.requiresCategory.includes(c)));
                    if (!present) {
                        acc.delete(tech.name);
                        changed = true;
                    }
                }
            }
        }

        // Exclusions.
        for (const entry of [...acc.values()]) {
            for (const excluded of entry.tech.excludes) {
                if (acc.has(excluded) && acc.has(entry.tech.name)) acc.delete(excluded);
            }
        }

        const pickVersion = (versions: string[]): string | null => {
            if (!versions.length) return null;
            const scored = versions
                .filter((v) => v && v.length <= 40)
                .map((v) => ({ v, dots: (v.match(/\./g) ?? []).length, len: v.length }))
                .sort((a, b) => b.dots - a.dots || b.len - a.len);
            return scored[0]?.v ?? null;
        };

        const result: ResolvedTechnology[] = [];
        for (const entry of acc.values()) {
            const categories = entry.tech.cats.map((id) => this.categories[String(id)]?.name).filter((n): n is string => !!n);
            const groupIds = new Set<number>();
            for (const id of entry.tech.cats) for (const g of this.categories[String(id)]?.groups ?? []) groupIds.add(g);
            const groups = [...groupIds].map((g) => this.groups[String(g)]?.name).filter((n): n is string => !!n);
            result.push({
                name: entry.tech.name,
                slug: entry.tech.slug,
                categories,
                groups,
                version: pickVersion(entry.versions),
                confidence: Math.round(entry.confidence),
                website: entry.tech.website ?? null,
                cpe: entry.tech.cpe,
                description: entry.tech.description,
                evidence: [...entry.evidence],
            });
        }
        result.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
        return result;
    }

    detect(page: PageData): ResolvedTechnology[] {
        return this.resolve(this.analyze(page));
    }
}
