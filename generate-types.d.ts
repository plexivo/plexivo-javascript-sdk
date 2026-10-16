/** Types from the versioned starter schema contract (getSchema). */
export function renderTypes(contract: unknown): string;
/** TypeScript for a project's live Data API (getApi): every table's Row, Insert and Update, and every function. */
export function renderApiTypes(api: import('./index.js').LiveApi): string;
