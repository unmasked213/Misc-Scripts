/**
 * Static sanity check for the extension.
 *
 * Not a test suite — a load-time smoke check. It resolves every ES import to a
 * real file, verifies every named import actually exists in the target module,
 * catches duplicate bindings, and confirms the manifest points at files that
 * exist. A single bad specifier silently kills an MV3 service worker at load with
 * nothing but a red dot on chrome://extensions, so this is worth having.
 *
 * Run: node check.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let errors = 0;
let checked = 0;

const fail = (msg) => { console.error('  FAIL ' + msg); errors++; };
const okMsg = (msg) => console.log('  ok   ' + msg);

function listJs(dir, out = []) {
    for (const e of execSync(`node -e "const fs=require('fs');console.log(fs.readdirSync('${dir.replace(/\\/g, '/')}',{withFileTypes:true}).map(d=>(d.isDirectory()?'D:':'F:')+d.name).join('\\n'))"`, { encoding: 'utf8' }).trim().split('\n')) {
        if (!e) continue;
        const name = e.slice(2);
        const p = join(dir, name);
        if (e.startsWith('D:')) listJs(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

// --- 1. exports per module ---
const exportsOf = new Map();
const files = listJs(join(ROOT, 'src'));

for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const n = part.trim().split(/\s+as\s+/).pop().trim();
            if (n) names.add(n);
        }
    }
    exportsOf.set(resolve(f), names);
}

// --- 2. imports resolve, and every named import exists ---
console.log('\nImport graph:');
for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const seen = new Set();

    for (const m of src.matchAll(/^import\s+(?:([^'"]+?)\s+from\s+)?['"]([^'"]+)['"]/gm)) {
        const clause = (m[1] || '').trim();
        const spec = m[2];
        checked++;

        if (!spec.startsWith('.')) { fail(`${rel(f)}: bare specifier "${spec}" — no bundler, this will not resolve`); continue; }

        const target = resolve(dirname(f), spec);
        if (!existsSync(target)) { fail(`${rel(f)} -> ${spec} does not exist`); continue; }

        const named = clause.match(/\{([^}]*)\}/);
        if (named) {
            const want = named[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
            const have = exportsOf.get(target) || new Set();
            for (const w of want) {
                if (seen.has(w)) fail(`${rel(f)}: duplicate binding "${w}" — SyntaxError at load`);
                seen.add(w);
                if (!have.has(w)) fail(`${rel(f)}: imports "${w}" from ${spec}, which does not export it`);
            }
        }
        const ns = clause.match(/^\*\s+as\s+([A-Za-z0-9_$]+)/);
        if (ns) { if (seen.has(ns[1])) fail(`${rel(f)}: duplicate binding "${ns[1]}"`); seen.add(ns[1]); }
    }
}
if (!errors) okMsg(`${checked} imports resolved across ${files.length} modules`);

// --- 3. content scripts must not import (they cannot be ES modules) ---
console.log('\nContent script constraints:');
for (const cs of ['src/content/probe.main.js', 'src/content/bridge.iso.js']) {
    const src = readFileSync(join(ROOT, cs), 'utf8');
    if (/^\s*import\s/m.test(src)) fail(`${cs} uses import — manifest-declared content scripts cannot be ES modules`);
    else okMsg(`${cs} is self-contained`);
}

// --- 4. manifest references exist ---
console.log('\nManifest:');
const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const refs = [
    mf.background?.service_worker,
    mf.action?.default_popup,
    ...Object.values(mf.icons || {}),
    ...Object.values(mf.action?.default_icon || {}),
    ...(mf.content_scripts || []).flatMap((c) => c.js || []),
];
for (const r of refs.filter(Boolean)) {
    if (existsSync(join(ROOT, r))) okMsg(r);
    else fail(`manifest references missing file: ${r}`);
}
if (mf.background && mf.background.type !== 'module') {
    fail('background.type must be "module" — the worker uses ES imports');
}
for (const extra of ['src/offscreen/index.html', 'src/ui/library/index.html']) {
    if (existsSync(join(ROOT, extra))) okMsg(extra); else fail(`missing ${extra}`);
}

function rel(f) { return relative(ROOT, f).replace(/\\/g, '/'); }

console.log(errors ? `\n${errors} problem(s) found.\n` : '\nAll checks passed.\n');
process.exit(errors ? 1 : 0);
