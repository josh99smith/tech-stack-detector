// Downloads the latest technology fingerprints from enthec/webappanalyzer (GPL-3.0)
// and writes a single minified bundle to src/data/fingerprints.json.
// Usage: node scripts/update-fingerprints.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/enthec/webappanalyzer/main/src';
const FILES = ['_', ...'abcdefghijklmnopqrstuvwxyz'].map((c) => `technologies/${c}.json`);

async function getJson(rel) {
    const res = await fetch(`${BASE}/${rel}`);
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.json();
}

const [categories, groups, ...techFiles] = await Promise.all([
    getJson('categories.json'),
    getJson('groups.json'),
    ...FILES.map(getJson),
]);

const technologies = {};
for (const file of techFiles) Object.assign(technologies, file);

// Drop fields the detector never uses to keep the bundle small.
for (const tech of Object.values(technologies)) {
    delete tech.icon;
    delete tech.pricing;
    delete tech.saas;
    delete tech.oss;
    delete tech.probe;
    delete tech.xhr;
    delete tech.certIssuer;
}

const bundle = {
    source: 'https://github.com/enthec/webappanalyzer',
    license: 'GPL-3.0',
    fetchedAt: new Date().toISOString(),
    technologyCount: Object.keys(technologies).length,
    categories,
    groups,
    technologies,
};

const out = path.resolve('src/data/fingerprints.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(bundle));
console.log(`Wrote ${bundle.technologyCount} technologies to ${out}`);
