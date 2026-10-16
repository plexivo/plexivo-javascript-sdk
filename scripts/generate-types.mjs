#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {renderTypes} from '../src/generate-types.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const apiUrl = option('--url') || process.env.PLEXIVO_DATA_URL;
const publishableKey = option('--key') || process.env.PLEXIVO_PUBLISHABLE_KEY;
const output = option('--output');

if (!apiUrl || !publishableKey) {
  console.error('Usage: plexivo-generate-types --url <project-url> --key <publishable-key> [--output database.types.ts]');
  process.exitCode = 2;
} else {
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/meta/schema`, {
    headers: {apikey: publishableKey, accept: 'application/json'}
  });
  if (!response.ok) throw new Error(`Schema request failed with HTTP ${response.status}`);

  const types = renderTypes(await response.json());
  if (output) await writeFile(output, types, {encoding: 'utf8', mode: 0o600});
  else process.stdout.write(types);
}
