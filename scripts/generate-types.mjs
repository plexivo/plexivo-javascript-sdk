#!/usr/bin/env node
// TypeScript types for your project's live Data API: every table and
// function the publishable key can see, read from GET /meta/api.
//
//   PLEXIVO_DATA_URL=… PLEXIVO_PUBLISHABLE_KEY=… plexivo-generate-types --output src/database.types.ts
import {writeFile} from 'node:fs/promises';
import {renderApiTypes} from '../src/generate-types.js';

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
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/meta/api`, {
    headers: {apikey: publishableKey, accept: 'application/json'}
  });
  if (!response.ok) {
    console.error(`The Data API description request failed with HTTP ${response.status}`);
    process.exitCode = 1;
  } else {
    const types = renderApiTypes(await response.json());
    if (output) await writeFile(output, types, {encoding: 'utf8', mode: 0o600});
    else process.stdout.write(types);
  }
}
