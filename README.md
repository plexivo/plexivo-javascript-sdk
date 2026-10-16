# Plexivo Client for JavaScript and TypeScript

Source repository for `@plexivo/client`, the Plexivo Client Data SDK for JavaScript, TypeScript, React, React Native, and Vue.

## Usage

```js
import { createClient } from '@plexivo/client';

const plexivo = createClient(projectApiUrl, publishableKey);
await plexivo.auth.signInWithPassword({ email, password });
const items = await plexivo.from('items').select();
```

Use the project API URL and publishable key provided by Plexivo. Never embed database credentials or server-only keys in browser or mobile applications.

See [framework integrations](examples/frameworks.md) for session handling, type generation, and the documented scope of the SDK. Availability of server features depends on your project configuration.

## Development

Requires Node.js 20 or later.

```sh
npm test
npm pack --dry-run
```

Publishing this source repository does not publish a package to npm.

## License

Apache-2.0. See [LICENSE](LICENSE).
