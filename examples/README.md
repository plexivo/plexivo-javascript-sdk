# Examples

Runnable examples for `@plexivo/client`. No keys live in the code: each reads your project from an env file you create.

1. Create a Plexivo Postgres and turn on its Data API. From its **Connect** tab, copy the **Project URL** and the **publishable key**.
2. `cp examples/node/.env.example examples/node/.env` and fill it in.
3. Create the example tables once: `node --env-file=examples/node/.env examples/node/setup.ts` (needs the secret key in `.env`; or run [`schema.sql`](schema.sql) in `psql`). Then switch **Realtime** on for `todos` and `messages` in the console.
4. Deploy [`functions/hello.js`](functions/hello.js) as `hello` from the **Functions** tab for the function example.

| Example | Run it |
| --- | --- |
| Auth: sign up, sign in, session, devices, sign out | `node --env-file=examples/node/.env examples/node/auth.ts` |
| Todo CRUD: filters, order, pagination, errors | `node --env-file=examples/node/.env examples/node/todos.ts` |
| Realtime chat: row changes, broadcast, presence | `node --env-file=examples/node/.env examples/node/chat.ts` |
| GraphQL and a live query | `node --env-file=examples/node/.env examples/node/graphql-live.ts` |
| Calling a Plexivo Function | `node --env-file=examples/node/.env examples/node/call-function.ts` |
| Browser app (Vite) | see [browser/README.md](browser/README.md) |

The Node examples need Node 22.18 or later, which runs TypeScript directly. Run them from the repository root, where `@plexivo/client` resolves to this package. In your own project, `npm install @plexivo/client` and copy the code.

`database.types.ts` is what `plexivo-generate-types` writes for `schema.sql`; it types every query in the examples.
