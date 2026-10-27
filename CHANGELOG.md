# Changelog

## 0.3.0

Plexivo Postgres as a Backend-as-a-Service, documented end to end.

- **Documentation**: a new README (quick start in five minutes, auth, data,
  realtime, GraphQL and live queries, Plexivo Functions, files, errors,
  TypeScript, security, coming from Firebase) and TSDoc on every exported
  symbol, with a typedoc API reference (`npm run docs`).
- **Examples** in the package: Node examples for auth, a todo list, a
  realtime chat, a GraphQL live query and a function call; a Vite browser
  app; the SQL schema and the function they use. Type-checked, and run
  against a live Plexivo Postgres before release.
- **Functions**: `functions.invoke(name, {path, query})` calls a sub-route
  with a query string.
- **Fixes**: every failure is now a `PlexivoError` — non-JSON error bodies,
  signed storage transfers, several rows for `single()`/`sole()`, and calls
  that need a user (`sign_in_required`). `signOut()` while signed out
  resolves. A refused realtime join rejects `ready()` and reaches
  `graphql.subscribe`. `plexivo-generate-types` reads the live Data API
  instead of the old starter table.
- Type declarations: `PlexivoError` and `RecordNotFoundError` constructors;
  `create(…, {returning: 'minimal'})` resolves to a count.

## 0.2.0

Everything Plexivo Postgres offers, from one client.

- **Queries**: a chainable, immutable builder with GORM-style conditions
  (operators, maps, groups, `whereNot`, `whereIn`, `whereBetween`, `whereNull`,
  JSON paths, arrays, full-text search, `whereHas` / `whereDoesntHave`),
  Supabase / PostgREST filters (`eq`, `in`, `or('a.eq.1,…')`, `match`, `not`,
  `textSearch`, `range`, `single`, `maybeSingle`) and PostgREST select strings
  with embeds and counts.
- **Reading**: `first`, `last`, `take`, `find(ids)`, `firstOrNull`, `sole`,
  `pluck`, `count`, `exists`, `sum`/`avg`/`min`/`max`, `paginate`,
  `findInBatches`, `each`, `for await`, `distinct`, row locks.
- **Writing**: `create` (one or many), `createInBatches`, `upsert` with
  chosen update columns or ignore, `save`, `update`/`delete` by filter or key,
  `increment`/`decrement`, `firstOrCreate`, `firstOrInit`, `updateOrCreate`.
  Writes without a filter are refused (`missing_where`) unless
  `allowGlobalUpdate()`.
- **Models**: relations (`belongsTo`, `hasOne`, `hasMany`, `manyToMany`),
  `preload` (nested, filtered, ordered, limited), `joins`, `withCount`,
  `withAggregate`, hooks in GORM order, named scopes, soft deletes
  (`unscoped`, `onlyTrashed`, `restore`, `forceDelete`), association mode.
- **Aggregates**: grouped with `having` and order by aggregates.
- **Transactions**: several operations in one request, all or nothing, with
  references between steps (`.ref('id')`) and row locks.
- **Server (secret key)**: raw SQL (`sql` tagged templates, `raw`, `exec`,
  `sqlTransaction`), `migrator.autoMigrate(models)` with columns, indexes,
  row-level security and policies, the full migrator, versioned
  `migrate`/`rollback`.
- **Auth**: guests and `linkEmail`, OAuth with PKCE (Google, GitHub,
  Microsoft), signed-in devices, organisations with roles and invitations,
  user import (including from Supabase).
- **Realtime**: row-change feeds with filters, rooms with broadcast and
  presence, signed in or out.
- **GraphQL** with automatic persisted queries and live queries;
  **functions**; **RPC** returning `{data}`; the live API description
  (`getApi`) and `renderApiTypes` for TypeScript.
- **Errors**: `PlexivoError` with code, message, hint, SQLSTATE and trace id;
  `RecordNotFoundError`, `isNotFound`, `isUniqueViolation`,
  `isPermissionDenied`.
- Full TypeScript definitions.

Breaking: awaiting `from(table).select()` now resolves to rows that also carry
`data` and `count` (an array, as before, plus those properties); `rpc()`
resolves to `{data}`. Needs a Plexivo Brain with the structured Data API
(`/query/v1`, R6.36).

## 0.1.1

- Publish through the repository's GitHub Actions workflow using npm Trusted
  Publishing and provenance, without a stored npm publishing token.
- No SDK runtime or public API changes from 0.1.0.

## 0.1.0

- Initial public release.
