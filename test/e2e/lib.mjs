// Shared plumbing for the end-to-end suites: which SDK to test, a live
// project, and the ok / FAIL report the CI contract reads.
//
// Environment (all optional when a harness control endpoint is running):
//   API_URL, PUBLISHABLE_KEY, SECRET_KEY, ALLOWED_ORIGIN, POOLED  — the project under test
//   PLEXIVO_HARNESS_CONTROL  — the harness control endpoint (default http://127.0.0.1:47801)
//   PLEXIVO_SDK_ENTRY        — the SDK to import: a module file, or a package directory
//                              (default: this checkout's src/index.js)

import {readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

export {assert};

const CONTROL = process.env.PLEXIVO_HARNESS_CONTROL || 'http://127.0.0.1:47801';
export const POOLED = process.env.POOLED === '1';

/** The module the suites test: this checkout, or an installed copy (PLEXIVO_SDK_ENTRY). */
export async function loadSdk() {
  const entry = process.env.PLEXIVO_SDK_ENTRY;
  if (!entry) return {sdk: await import(new URL('../../src/index.js', import.meta.url).href), from: 'src/index.js'};
  let file = resolve(entry);
  if (statSync(file).isDirectory()) {
    const pkg = JSON.parse(readFileSync(join(file, 'package.json'), 'utf8'));
    const main = pkg.exports?.['.']?.import || pkg.exports?.['.']?.default || pkg.main;
    file = join(file, main);
  }
  return {sdk: await import(pathToFileURL(file).href), from: file};
}

async function retry(fn, label) {
  const deadline = Date.now() + 5 * 60_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const refused = error?.retryable || error?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/.test(String(error?.cause?.message || error?.message));
      if (!refused || Date.now() > deadline) throw error;
      if (attempt === 0) console.log(`note: ${label} is not answering yet (restarting?); retrying for up to 5 minutes`);
      await sleep(3000);
    }
  }
}

/** Whether the harness control endpoint is reachable (it is not inside the Brain's own CI run). */
export async function hasControl() {
  try {
    const r = await fetch(`${CONTROL}/projects`, {method: 'OPTIONS', signal: AbortSignal.timeout(1500)});
    return r.status > 0;
  } catch (error) {
    return false;
  }
}

/** A fresh project from the harness control endpoint. */
export async function newProject(options = {}) {
  return retry(async () => {
    const response = await fetch(`${CONTROL}/projects`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pooled: POOLED, ...options})
    });
    if (!response.ok) throw Object.assign(new Error(`the harness control endpoint answered ${response.status}`), {retryable: response.status >= 500});
    return response.json();
  }, 'the harness');
}

/** The project under test: the one the CI passes in, or a fresh one. */
export async function projectUnderTest(options = {}) {
  if (process.env.API_URL) {
    return {
      api_url: process.env.API_URL,
      publishable_key: process.env.PUBLISHABLE_KEY,
      secret_key: process.env.SECRET_KEY,
      origin: process.env.ALLOWED_ORIGIN,
      pooled: POOLED
    };
  }
  return newProject(options);
}

/** Waits for the API to answer (the harness restarts when the Brain changes). */
export async function waitForApi(apiUrl) {
  await retry(() => fetch(`${apiUrl}/auth/providers`), 'the Data API');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(check, {timeout = 10_000, every = 50, what = 'condition'} = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(every);
  }
}

// ── the report ───────────────────────────────────────────────────────────

const results = {passed: 0, failed: 0, failures: []};
let secrets = [];

/** Values that must never appear in the output (keys, tokens). */
export function redact(...values) {
  secrets.push(...values.filter((v) => typeof v === 'string' && v.length > 8));
}

function clean(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out.replace(/plx_(secret|publishable)_[A-Za-z0-9_-]+/g, 'plx_$1_<redacted>').replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>');
}

function describe(error) {
  if (!error) return 'failed';
  const bits = [error.message];
  for (const k of ['status', 'code', 'sqlstate', 'hint']) if (error[k] !== undefined && error[k] !== null) bits.push(`${k}=${error[k]}`);
  return bits.join(' ');
}

/** One check: prints `ok <name>` or `FAIL <name> <details>`. */
export async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.passed++;
    const ms = Date.now() - started;
    console.log(`ok ${name}${ms > 2000 ? ` (${(ms / 1000).toFixed(1)} s)` : ''}`);
  } catch (error) {
    results.failed++;
    results.failures.push(name);
    console.log(`FAIL ${name} ${clean(describe(error))}`);
    if (process.env.VERBOSE && error?.stack) console.log(clean(error.stack));
  }
}

/** A printed note (a skipped area and why). */
export function note(text) {
  console.log(`note: ${text}`);
}

/** Prints the count and exits: 0 and ALL PASSED only when nothing failed. */
export function finish() {
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed === 0 && results.passed > 0) {
    console.log('ALL PASSED');
    process.exit(0);
  }
  console.log(`FAILED: ${results.failures.join(', ')}`);
  process.exit(1);
}

/** Expects `promise` to reject with a PlexivoError carrying these fields. */
export async function refused(promise, expected = {}) {
  let error;
  try {
    const value = await promise;
    if (value && value.error && value.data === null) error = value.error;
    else throw Object.assign(new Error(`expected a refusal ${JSON.stringify(expected)}, got data: ${clean(JSON.stringify(value)).slice(0, 300)}`), {unexpected: true});
  } catch (e) {
    if (e?.unexpected) throw e;
    error = error || e;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (v instanceof RegExp) assert.match(String(error?.[k]), v, `${k}: ${describe(error)}`);
    else if (Array.isArray(v)) assert.ok(v.includes(error?.[k]), `${k} ${error?.[k]} not in ${v.join('|')}: ${describe(error)}`);
    else assert.equal(error?.[k], v, `${k}: ${describe(error)}`);
  }
  return error;
}

/** A unique, valid email for a test user. */
let counter = 0;
export const email = (tag = 'user') => `${tag}.${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
export const PASSWORD = 'correct-Horse-battery-9';
