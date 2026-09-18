import { readFileSync } from 'node:fs';

import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { collectFromHtml, detectChallengePage, normalizeHeaders, parseCookies } from '../src/collect.js';
import { compilePattern, type FingerprintBundle, resolveVersion, TechnologyDetector } from '../src/engine.js';

const bundle = JSON.parse(readFileSync(new URL('../src/data/fingerprints.json', import.meta.url), 'utf8')) as FingerprintBundle;
const detector = new TechnologyDetector(bundle);

describe('compilePattern', () => {
    it('parses regex, version and confidence tags', () => {
        const p = compilePattern('^WordPress(?: ([\\d.]+))?\\;version:\\1\\;confidence:50');
        expect(p.regex.test('WordPress 6.5')).toBe(true);
        expect(p.version).toBe('\\1');
        expect(p.confidence).toBe(50);
        expect(resolveVersion(p, 'WordPress 6.5')).toBe('6.5');
        expect(resolveVersion(p, 'WordPress')).toBeUndefined();
    });

    it('matches anything for an empty pattern', () => {
        expect(compilePattern('').regex.test('whatever')).toBe(true);
    });

    it('supports ternary version expressions', () => {
        const p = compilePattern('^(next)?.*$\\;version:\\1?Next:');
        expect(resolveVersion(p, 'next-abc')).toBe('Next');
        expect(resolveVersion(p, 'prod')).toBeUndefined();
    });

    it('never throws on invalid regex syntax', () => {
        expect(() => compilePattern('(?<')).not.toThrow();
    });
});

describe('TechnologyDetector', () => {
    it('loads the fingerprint bundle', () => {
        expect(detector.technologies.size).toBeGreaterThan(7000);
        expect(detector.technologies.get('WordPress')?.cats).toContain(1);
    });

    it('detects WordPress from a meta generator tag and implies PHP + MySQL', () => {
        const html = `<html><head><meta name="generator" content="WordPress 6.4.2"></head><body></body></html>`;
        const $ = load(html);
        const result = detector.detect({ url: 'https://example.com/', html, ...collectFromHtml($) });
        const names = result.map((t) => t.name);
        expect(names).toContain('WordPress');
        expect(names).toContain('PHP');
        expect(names).toContain('MySQL');
        expect(result.find((t) => t.name === 'WordPress')?.version).toBe('6.4.2');
        expect(result.find((t) => t.name === 'WordPress')?.categories).toContain('CMS');
    });

    it('detects Cloudflare and HSTS from headers', () => {
        const headers = normalizeHeaders({ server: 'cloudflare', 'cf-ray': 'abc', 'strict-transport-security': 'max-age=1' });
        const names = detector.detect({ url: 'https://example.com/', headers }).map((t) => t.name);
        expect(names).toContain('Cloudflare');
        expect(names).toContain('HSTS');
    });

    it('detects Shopify from cookies', () => {
        const cookies = parseCookies(['_shopify_s=abc; Path=/', '_shopify_y=def; Path=/']);
        const names = detector.detect({ url: 'https://example.com/', cookies }).map((t) => t.name);
        expect(names).toContain('Shopify');
    });

    it('drops technologies whose required technology is absent', () => {
        // "a3 Lazy Load" requires WordPress; a matching script without WordPress must not be reported.
        const scriptSrc = ['/wp-content/plugins/a3-lazy-load/assets/js/jquery.lazyloadxt.extra.min.js?ver=2.6.0'];
        const withWp = detector.detect({ url: 'https://x.com/', scriptSrc, meta: { generator: ['WordPress 6.0'] } }).map((t) => t.name);
        expect(withWp).toContain('a3 Lazy Load');
        const raw = detector.analyze({ url: 'https://x.com/', scriptSrc: ['/plugins/a3-lazy-load/x.js'] });
        const filtered = detector.resolve(raw.filter((d) => d.tech.name === 'a3 Lazy Load'));
        expect(filtered.map((t) => t.name)).not.toContain('a3 Lazy Load');
    });

    it('applies excludes (Angular excludes AngularJS)', () => {
        const angular = detector.technologies.get('Angular')!;
        const angularJs = detector.technologies.get('AngularJS')!;
        const resolved = detector.resolve([
            { tech: angular, confidence: 100, evidence: 'test' },
            { tech: angularJs, confidence: 100, evidence: 'test' },
        ]);
        const names = resolved.map((t) => t.name);
        expect(names).toContain('Angular');
        expect(names).not.toContain('AngularJS');
    });

    it('caps confidence at 100 and sorts by confidence', () => {
        const wp = detector.technologies.get('WordPress')!;
        const resolved = detector.resolve([
            { tech: wp, confidence: 80, evidence: 'a' },
            { tech: wp, confidence: 80, evidence: 'b' },
        ]);
        const wordpress = resolved.find((t) => t.name === 'WordPress')!;
        expect(wordpress.confidence).toBe(100);
        expect(wordpress.evidence).toEqual(['a', 'b']);
        expect(resolved.every((t, i) => i === 0 || resolved[i - 1].confidence >= t.confidence)).toBe(true);
    });

    it('detects DOM-based technologies (Open Graph) via cheerio selectors', () => {
        const html = `<html><head><meta property="og:title" content="x"></head><body></body></html>`;
        const names = detector.detect({ url: 'https://example.com/', html, ...collectFromHtml(load(html)) }).map((t) => t.name);
        expect(names).toContain('Open Graph');
    });
});

describe('collect helpers', () => {
    it('parses set-cookie headers into lowercase names', () => {
        expect(parseCookies(['PHPSESSID=1; Path=/', 'x=2'])).toEqual({ phpsessid: ['1'], x: ['2'] });
        expect(parseCookies(undefined)).toEqual({});
    });

    it('collects meta, scripts and title from HTML', () => {
        const $ = load(`<html><head><title> Hi </title><meta name="Generator" content="Hugo"><script src="/a.js"></script><script>var wp = 1;</script><style>.a{}</style></head><body>Hello</body></html>`);
        const data = collectFromHtml($);
        expect(data.title).toBe('Hi');
        expect(data.meta).toEqual({ generator: ['Hugo'] });
        expect(data.scriptSrc).toEqual(['/a.js']);
        expect(data.scripts).toEqual(['var wp = 1;']);
        expect(data.css).toEqual(['.a{}']);
        expect(data.text).toBe('Hello');
        expect(data.querySelectorAll?.('title').length).toBe(1);
    });
});

describe('detectChallengePage', () => {
    it('flags known challenge titles and markers', () => {
        expect(detectChallengePage('Client Challenge', '<html><noscript>Please enable JavaScript</noscript></html>', 200)).toMatch(/bot-challenge/);
        expect(detectChallengePage('Just a moment...', '<html></html>', 503)).toMatch(/bot-challenge/);
        expect(detectChallengePage('Home', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>', 200)).toMatch(/challenge-platform/);
        expect(detectChallengePage('Forbidden', '<html>denied</html>', 403)).toMatch(/HTTP 403/);
    });

    it('does not flag normal pages', () => {
        const big = '<html><head><title>Shop</title></head><body>' + 'x'.repeat(40_000) + '</body></html>';
        expect(detectChallengePage('Shop', big, 200)).toBeNull();
        expect(detectChallengePage('Blog', '<html><body>hello world</body></html>', 200)).toBeNull();
    });
});
