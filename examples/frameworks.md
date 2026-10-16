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

Generate the versioned starter schema without a database password or server key:

```sh
npx plexivo-generate-types --url "$PLEXIVO_DATA_URL" --key "$PLEXIVO_PUBLISHABLE_KEY" --output src/database.types.ts
```

The generated definition covers only tables present in the public Client Data schema contract. It does not reflect arbitrary PostgreSQL schemas.

React and React Native can keep the client in a context provider. Vue can expose the same singleton through a plugin. Authentication, RLS-backed CRUD, token refresh, and realtime subscriptions use the same SDK in every framework.

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

The verified staging surface is deliberately narrower than Supabase: email/password, password changes, server-side logout, self-service account disablement, TOTP MFA, the RLS-protected `items` API, and API-mutation events. A private Storage SDK is source-tested but remains disabled until its dedicated bucket credential and hostile staging tests pass:

```js
const object = await plexivo.storage.upload(
  'avatars/me.png',
  file,
  {contentType: 'image/png'}
);
const downloaded = await plexivo.storage.download(object.id);
```

Upload bytes receive only a short-lived, operation-bound signed URL; the browser never receives the project key, app-user JWT, database password or MinIO credential on that request. Password recovery delivery, social OAuth, arbitrary schemas, advanced Storage, Functions and WAL change capture remain unavailable until their own acceptance gates pass.
