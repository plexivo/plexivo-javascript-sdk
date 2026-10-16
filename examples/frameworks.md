# Framework integrations

The same browser-safe client works in React, React Native, Vue, and plain JavaScript. Only the project API URL and publishable key belong in client code. Never place a database URL or `plx_secret_` key in a browser or mobile bundle.

```ts
import { createClient } from '@plexivo/client'
import type { Database } from './database.types'

export const plexivo = createClient<Database>(
  import.meta.env.VITE_PLEXIVO_DATA_URL,
  import.meta.env.VITE_PLEXIVO_PUBLISHABLE_KEY
)
```

Generate types from your project's live API (no password or server key needed):

```js
import { renderApiTypes } from '@plexivo/client/generate-types'
writeFileSync('src/database.types.ts', renderApiTypes(await plexivo.getApi()))
```

React and React Native can keep the client in a context provider. Vue can expose the same singleton through a plugin. Authentication, queries and models, transactions, token refresh, realtime and GraphQL use the same SDK in every framework.

Browser sessions are persisted by default and an expired access token is refreshed once before the original request is retried. React Native must pass an encrypted device-storage adapter rather than using unencrypted application preferences.

```ts
const { data: { subscription } } = plexivo.auth.onAuthStateChange((event, session) => {
  // Update application state without storing a database or server key.
})

const factor = await plexivo.auth.mfa.enroll()
// Display factor.uri as a QR code, then ask the user for their authenticator code.
await plexivo.auth.mfa.verify({ code })

await plexivo.auth.signOut() // revokes the current refresh session on the server
subscription.unsubscribe()
```

Files go straight to storage with a short-lived signed URL; the browser never receives a database password or storage credential:

```js
const object = await plexivo.storage.upload('avatars/me.png', file, {contentType: 'image/png'})
const downloaded = await plexivo.storage.download(object.id)
```

See the [README](../README.md) for queries, models, transactions, realtime, GraphQL, functions and the server-only SQL and migrations.
