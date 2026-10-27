/**
 * TypeScript types for your Plexivo Postgres project, from its live Data API.
 * Pass the generated `Database` type to `createClient` for checked table
 * names, columns, inserts, updates and function calls.
 *
 * The `plexivo-generate-types` command does the same from the terminal.
 *
 * @example
 * ```ts
 * import { writeFileSync } from 'node:fs';
 * import { createClient } from '@plexivo/client';
 * import { renderApiTypes } from '@plexivo/client/generate-types';
 *
 * const db = createClient(PLEXIVO_DATA_URL, PLEXIVO_PUBLISHABLE_KEY);
 * writeFileSync('src/database.types.ts', renderApiTypes(await db.getApi()));
 * ```
 *
 * @packageDocumentation
 */

/**
 * TypeScript for the versioned starter schema contract, from `getSchema()`.
 * For your own tables, use {@link renderApiTypes}.
 *
 * @param contract - The result of `getSchema()`.
 * @returns The source of a module that exports `Json` and `Database`.
 * @throws Error when the contract is not a supported `public` schema, has no tables, or has an invalid table or field name or an unsupported field type.
 */
export function renderTypes(contract: unknown): string;
/**
 * TypeScript for a project's live Data API, from `getApi()`: every exposed
 * table's `Row`, `Insert` and `Update`, and every exposed function's `Args`
 * and `Returns`. Nullable columns are `| null`; columns with a default are
 * optional in `Insert`; read-only columns are left out of `Insert` and
 * `Update`. Numbers map to `number`, json and jsonb to `Json`, everything
 * else to `string`.
 *
 * The output holds no key or credential, so it is safe to commit.
 *
 * @param api - The result of `getApi()`.
 * @returns The source of a module that exports `Json` and `Database`.
 * @throws Error when `api` is not the result of `getApi()`.
 *
 * @example
 * ```ts
 * // Once, in a script:
 * fs.writeFileSync('database.types.ts', renderApiTypes(await db.getApi()));
 *
 * // In your app:
 * import type { Database } from './database.types';
 * const typed = createClient<Database>(url, key);
 * ```
 */
export function renderApiTypes(api: import('./index.js').LiveApi): string;
