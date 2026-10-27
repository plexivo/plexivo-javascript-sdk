// Runs every code block in README.md against a live Plexivo Postgres
// project, so the documentation can never drift from the SDK.
//
// The convention:
//
//  * Blocks are grouped by their `## ` section and run in document order.
//  * ```sql blocks run first in their section, with the secret key (each
//    statement in turn, one transaction per block) — the README's own SQL
//    creates the schema the examples use.
//  * ```js / ```ts / ```jsx / ```tsx blocks of a section are one module, like
//    cells of a notebook: later blocks see earlier blocks' variables. Types
//    are stripped and JSX compiled with esbuild; imports are merged and
//    hoisted; `@plexivo/client` is this checkout (or PLEXIVO_SDK_ENTRY).
//    Each section runs in its own Node process; a section that imports
//    React gets a DOM (jsdom) with a `<div id="root">`.
//  * Credentials come from the environment, as in a real app:
//    process.env.PLEXIVO_DATA_URL / PLEXIVO_PUBLISHABLE_KEY / PLEXIVO_SECRET_KEY,
//    NEXT_PUBLIC_… and import.meta.env.VITE_… are set to the live project.
//    Every `name@example.com` becomes unique to this run.
//  * Hidden, in HTML comments that npm does not show:
//    `<!-- docs:setup … -->` code run before the section's blocks, and
//    `<!-- docs:check … -->` code run where it stands (assertions; `assert`
//    is node:assert/strict).
//  * ```sh blocks: package installs are the only blocks skipped (and are
//    printed as skipped); `npx plexivo-generate-types …` runs this
//    checkout's generator; any other shell command fails the run.
//  * After a section runs, every `db.…(` / `server.…(` call path in its code
//    is checked to exist on a real client, so even code inside functions the
//    example only defines cannot name an API that does not exist.
//
// Prints `ok <section>` / `FAIL <section> <details>` and what it ran.

import {readFileSync, writeFileSync, mkdirSync, rmSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {transform} from 'esbuild';
import {check, assert, finish, note, projectUnderTest, waitForApi, redact} from '../e2e/lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readmePath = process.env.README || join(root, 'README.md');
const outDir = join(root, 'test/docs/.out');

function sdkEntry() {
  const entry = process.env.PLEXIVO_SDK_ENTRY;
  if (!entry) return join(root, 'src/index.js');
  let file = resolve(entry);
  if (statSync(file).isDirectory()) {
    const pkg = JSON.parse(readFileSync(join(file, 'package.json'), 'utf8'));
    file = join(file, pkg.exports?.['.']?.import || pkg.main);
  }
  return file;
}

// ── reading the README ─────────────────────────────────────────────────────

export function parseReadme(text) {
  const sections = [];
  let section = {title: '(top)', items: []};
  sections.push(section);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      section = {title: heading[1].trim(), items: []};
      sections.push(section);
      continue;
    }
    const fence = line.match(/^(\s*)```(\w*)\s*$/);
    if (fence) {
      const indent = fence[1];
      const lang = fence[2] || 'text';
      const body = [];
      const start = i + 1;
      for (i++; i < lines.length && !lines[i].match(/^\s*```\s*$/); i++) body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
      section.items.push({kind: 'block', lang, code: body.join('\n'), line: start});
      continue;
    }
    const hidden = line.match(/^<!--\s*docs:(setup|check)\b(.*)$/);
    if (hidden) {
      const body = [hidden[2]];
      while (!body.at(-1).includes('-->') && i + 1 < lines.length) body.push(lines[++i]);
      const code = body.join('\n').replace(/-->\s*$/, '').trim();
      section.items.push({kind: hidden[1], lang: 'js', code, line: i + 1});
    }
  }
  return sections.filter((s) => s.items.length);
}

// One SQL text as statements: semicolons outside quotes, dollar quotes and comments.
export function splitSql(sql) {
  const out = [];
  let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      cur += '\n';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    const dollar = rest.match(/^\$([A-Za-z_]*)\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      cur += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const JS = new Set(['js', 'javascript', 'mjs', 'ts', 'typescript', 'jsx', 'tsx']);
const SH = new Set(['sh', 'bash', 'shell', 'console']);
const INSTALL = /^\s*(npm (install|i|add)|pnpm (add|install)|yarn add|bun add)\b/;

// ── compiling a section's code ─────────────────────────────────────────────

async function compile(item) {
  const loader = {ts: 'ts', typescript: 'ts', tsx: 'tsx', jsx: 'jsx'}[item.lang] || (/<[A-Z][\w.]*[\s/>]|<\/[a-z]+>/.test(item.code) ? 'jsx' : 'js');
  const out = await transform(item.code, {loader, format: 'esm', target: 'es2022', jsx: 'automatic', sourcefile: `README.md:${item.line}`});
  return out.code;
}

// Hoists and merges `import` statements; everything else is the body.
function hoist(codes, entryUrl) {
  const imports = new Map();
  const body = [];
  for (const code of codes) {
    const kept = [];
    for (const stmt of code.split(/\n(?=import\s)|(?<=;)\n/)) {
      const m = stmt.match(/^import\s+(?:(\*\s+as\s+\w+)|(\w+)?\s*,?\s*(\{[^}]*\})?)\s*from\s*(['"])([^'"]+)\4;?\s*$/s);
      if (m) {
        const [, ns, def, named, , spec] = m;
        const key = spec === '@plexivo/client' ? entryUrl : spec;
        const entry = imports.get(key) || {ns: null, def: null, named: new Set()};
        if (ns) entry.ns = ns;
        if (def) entry.def = def;
        if (named) for (const n of named.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)) entry.named.add(n);
        imports.set(key, entry);
      } else if (/^import\s+['"][^'"]+['"];?\s*$/.test(stmt)) {
        const spec = stmt.match(/['"]([^'"]+)['"]/)[1];
        if (!imports.has(spec)) imports.set(spec, {ns: null, def: null, named: new Set()});
      } else kept.push(stmt);
    }
    body.push(kept.join('\n'));
  }
  const head = [];
  for (const [spec, e] of imports) {
    const parts = [];
    if (e.def) parts.push(e.def);
    if (e.named.size) parts.push(`{ ${[...e.named].join(', ')} }`);
    if (e.ns) head.push(`import ${e.ns} from ${JSON.stringify(spec)};`);
    if (parts.length) head.push(`import ${parts.join(', ')} from ${JSON.stringify(spec)};`);
    if (!e.ns && !parts.length) head.push(`import ${JSON.stringify(spec)};`);
  }
  return {head: head.join('\n'), body: body.join('\n;\n').replace(/(["'])@plexivo\/client\1/g, JSON.stringify(entryUrl))};
}

// Every `db.a.b(` path the code calls on a client.
function apiPaths(code) {
  const paths = new Set();
  for (const m of code.matchAll(/\b(db|server)\.((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\(/g)) paths.add(`${m[1]}.${m[2]}`);
  return [...paths];
}

const DOM_SETUP = `
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: process.env.VITE_PLEXIVO_ORIGIN || 'http://localhost:5173/', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, k, { value: k === 'window' ? globalThis : w[k], configurable: true, writable: true }); } catch {}
}
globalThis.window.document = w.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
`;

function runNode(file, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [file], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({code, out}); });
  });
}

// ── the run ────────────────────────────────────────────────────────────────

const entry = sdkEntry();
const entryUrl = pathToFileURL(entry).href;
const {createClient} = await import(entryUrl);
const project = await projectUnderTest();
redact(project.publishable_key, project.secret_key);
await waitForApi(project.api_url);
const server = createClient(project.api_url, project.secret_key, {persistSession: false});
const run = Date.now().toString(36);
const clean = (s) => String(s).split(project.secret_key).join('<secret>').split(project.publishable_key).join('<publishable>');

const env = {
  ...process.env,
  PLEXIVO_DATA_URL: project.api_url,
  PLEXIVO_PUBLISHABLE_KEY: project.publishable_key,
  PLEXIVO_SECRET_KEY: project.secret_key,
  NEXT_PUBLIC_PLEXIVO_DATA_URL: project.api_url,
  NEXT_PUBLIC_PLEXIVO_PUBLISHABLE_KEY: project.publishable_key,
  VITE_PLEXIVO_DATA_URL: project.api_url,
  VITE_PLEXIVO_PUBLISHABLE_KEY: project.publishable_key,
  NODE_NO_WARNINGS: '1'
};

const sections = parseReadme(readFileSync(readmePath, 'utf8'));
console.log(`docs: ${readmePath} — ${sections.length} sections with code; SDK ${entry}`);
rmSync(outDir, {recursive: true, force: true});
mkdirSync(outDir, {recursive: true});
let blocks = 0;

for (const [index, section] of sections.entries()) {
  const ran = [];
  await check(`docs: ${section.title}`, async () => {
    const unique = (code) => code.replace(/\b([a-z][a-z0-9._-]*)@example\.com\b/g, `$1.${run}@example.com`);
    // SQL first, as the database owner.
    for (const item of section.items.filter((x) => x.kind === 'block' && x.lang === 'sql')) {
      const statements = splitSql(item.code);
      for (let i = 0; i < statements.length; i += 50) await server.sqlTransaction(statements.slice(i, i + 50));
      ran.push(`sql:${item.line} (${statements.length} statements)`);
      blocks++;
    }
    for (const item of section.items.filter((x) => x.kind === 'block' && SH.has(x.lang))) {
      blocks++;
      for (const line of item.code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        if (INSTALL.test(line)) { ran.push(`sh:${item.line} skipped (install): ${line}`); continue; }
        const gen = line.match(/^npx plexivo-generate-types\b(.*)$/);
        if (gen) {
          const args = gen[1].replace(/>\s*\S+/, '').trim().split(/\s+/).filter(Boolean)
            .map((a) => a.replace(/\$PLEXIVO_DATA_URL|\$\{PLEXIVO_DATA_URL\}/, project.api_url).replace(/\$PLEXIVO_PUBLISHABLE_KEY|\$\{PLEXIVO_PUBLISHABLE_KEY\}/, project.publishable_key));
          const outFile = join(outDir, `types-${index}.ts`);
          const at = args.indexOf('--output');
          if (at >= 0) args[at + 1] = outFile; else args.push('--output', outFile);
          const r = await new Promise((res) => {
            const c = spawn(process.execPath, [join(root, 'scripts/generate-types.mjs'), ...args], {cwd: root, env});
            let o = '';
            c.stdout.on('data', (d) => { o += d; });
            c.stderr.on('data', (d) => { o += d; });
            c.on('close', (code) => res({code, o}));
          });
          if (r.code !== 0) throw new Error(`plexivo-generate-types failed: ${clean(r.o)}`);
          const types = readFileSync(outFile, 'utf8');
          assert.match(types, /export (type|interface) Database\b/);
          ran.push(`sh:${item.line} ran: npx plexivo-generate-types (${types.length} bytes of types)`);
          continue;
        }
        throw new Error(`README.md:${item.line}: a shell command the docs runner cannot run: ${line}`);
      }
    }
    const code = section.items.filter((x) => (x.kind === 'block' && JS.has(x.lang)) || x.kind === 'setup' || x.kind === 'check');
    const ordered = [...code.filter((x) => x.kind === 'setup'), ...code.filter((x) => x.kind !== 'setup')];
    for (const item of section.items.filter((x) => x.kind === 'block' && !JS.has(x.lang) && !SH.has(x.lang) && x.lang !== 'sql')) {
      ran.push(`${item.lang}:${item.line} (not code)`);
    }
    if (ordered.length === 0) return;
    const compiled = [];
    for (const item of ordered) {
      compiled.push((await compile({...item, code: unique(item.code)})).replace(/import\.meta\.env\./g, 'process.env.'));
      if (item.kind === 'block') {
        blocks++;
        ran.push(`${item.lang}:${item.line}`);
      } else ran.push(`hidden ${item.kind}:${item.line}`);
    }
    const {head, body} = hoist(compiled, entryUrl);
    const usesDom = /from ["']react(-dom)?(\/[\w-]+)?["']/.test(head) || ordered.some((x) => x.lang === 'jsx' || x.lang === 'tsx');
    const paths = apiPaths(ordered.map((x) => x.code).join('\n'));
    const file = join(outDir, `section-${String(index).padStart(2, '0')}.mjs`);
    writeFileSync(file, [
      usesDom ? DOM_SETUP : '',
      head,
      `import __assert from 'node:assert/strict';`,
      `import { createClient as __createClient } from ${JSON.stringify(entryUrl)};`,
      `const assert = __assert;`,
      body,
      `;\n// The API surface the section names.`,
      `{ const __clients = { db: __createClient(process.env.PLEXIVO_DATA_URL, process.env.PLEXIVO_PUBLISHABLE_KEY, { persistSession: false }), server: typeof window === 'undefined' ? __createClient(process.env.PLEXIVO_DATA_URL, process.env.PLEXIVO_SECRET_KEY, { persistSession: false }) : null };`,
      `  for (const path of ${JSON.stringify(paths)}) { const [root, ...keys] = path.split('.'); let v = __clients[root]; if (v === null) continue; for (const k of keys) v = v?.[k]; if (typeof v !== 'function') throw new Error('README names ' + path + '(…), which the SDK does not have'); } }`,
      `await new Promise((r) => setTimeout(r, ${usesDom ? 1500 : 0}));`,
      `process.exit(0);`
    ].join('\n'));
    const result = await runNode(file, env);
    if (result.code !== 0) throw new Error(`section module failed (exit ${result.code}):\n${clean(result.out).split('\n').slice(0, 25).join('\n')}`);
    if (result.out.trim()) ran.push(`printed ${result.out.trim().split('\n').length} line(s)`);
  });
  console.log(`   ran: ${ran.join(' · ') || 'nothing'}`);
}

note(`${blocks} README blocks across ${sections.length} sections`);
finish();
