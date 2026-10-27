# Browser example (Vite)

Sign in, a todo list kept live across tabs and devices, a realtime chat with a typing indicator, a GraphQL live count and a Plexivo Function — in one small page. Only the publishable key is in the app.

```sh
cd examples/browser
cp .env.example .env.local     # your Project URL and publishable key
npm install
npm run dev                    # http://localhost:5173
```

Before you start: create the example tables ([`../schema.sql`](../schema.sql)), switch Realtime on for `todos` and `messages`, deploy [`../functions/hello.js`](../functions/hello.js) as `hello`, and add `http://localhost:5173` to the Data API's allowed origins.

The code is in [`src/main.ts`](src/main.ts). `npm run build` type-checks it and builds a static site in `dist/`.
