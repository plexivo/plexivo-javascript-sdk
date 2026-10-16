// Raw SQL and migrations, for servers with the project's secret key
// (POST /sql/v1). A browser or app is refused by the platform whatever it
// sends; keep the secret key on your server.
//
//   const db = createClient(url, process.env.PLEXIVO_SECRET_KEY);
//   const rows = await db.sql`select * from orders where total > ${100}`;
//   await db.migrator.autoMigrate(Post, Comment);
//   await db.migrate([{id: '2026_10_17_add_slug', up: 'alter table posts add column slug text'}]);
//
// Statements in one call run in one transaction: all commit, or none do.

const ident = (name) => {
  if (typeof name !== 'string' || name === '') throw new TypeError('an identifier is a non-empty string');
  return name.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
};

export function sqlApi(call) {
  const run = async (statements) => (await call('/sql/v1', {method: 'POST', body: JSON.stringify({statements})})).results;
  const one = async (sql, params = []) => (await run([{sql, params}]))[0];

  /** Rows from one query: `await db.sql\`select * from t where id = ${id}\``. */
  function sql(strings, ...values) {
    if (!Array.isArray(strings) || !strings.raw) throw new TypeError('sql is a tagged template: db.sql`select … ${value}`');
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    return one(text, values.map(param)).then((r) => r.rows ?? []);
  }

  const api = {
    sql,
    /** Rows from `sql` with `$1`, `$2` … parameters. */
    raw: (text, params = []) => one(text, params.map(param)).then((r) => r.rows ?? []),
    /** Runs a statement: `{command, rowCount}`. */
    exec: (text, params = []) => one(text, params.map(param)).then((r) => ({command: r.command, rowCount: r.row_count})),
    /** Several statements in one transaction: `[{sql, params}]` → each result. */
    sqlTransaction: (statements) => run(statements.map((s) => (typeof s === 'string' ? {sql: s, params: []} : {sql: s.sql, params: (s.params || []).map(param)}))),
    migrator: migrator(run, one)
  };

  /**
   * Versioned migrations, each applied once, in order, each in its own
   * transaction, recorded in `plexivo_migrations`.
   * `up`/`down` are SQL, a list of SQL, or `(m) => …` using the migrator.
   */
  api.migrate = async (migrations, {table = 'plexivo_migrations'} = {}) => {
    await run([{sql: `CREATE TABLE IF NOT EXISTS ${ident(table)} (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`, params: []}]);
    const done = new Set((await one(`SELECT id FROM ${ident(table)}`)).rows.map((r) => r.id));
    const applied = [];
    for (const m of migrations) {
      if (!m?.id) throw new TypeError('each migration has an id');
      if (done.has(m.id)) continue;
      const statements = await steps(m.up, api.migrator);
      await run([...statements, {sql: `INSERT INTO ${ident(table)} (id) VALUES ($1)`, params: [m.id]}]);
      applied.push(m.id);
    }
    return applied;
  };

  /** Undoes the last `steps` applied migrations, newest first, with their `down`. */
  api.rollback = async (migrations, {steps: count = 1, table = 'plexivo_migrations'} = {}) => {
    const rows = (await one(`SELECT id FROM ${ident(table)} ORDER BY applied_at DESC, id DESC LIMIT $1`, [count])).rows;
    const undone = [];
    for (const {id} of rows) {
      const m = migrations.find((x) => x.id === id);
      if (!m?.down) throw new Error(`migration ${id} has no down`);
      await run([...await steps(m.down, api.migrator), {sql: `DELETE FROM ${ident(table)} WHERE id = $1`, params: [id]}]);
      undone.push(id);
    }
    return undone;
  };
  return api;
}

async function steps(spec, m) {
  if (typeof spec === 'function') {
    const plan = m.plan();
    await spec(plan);
    return plan.statements;
  }
  return [].concat(spec).map((s) => (typeof s === 'string' ? {sql: s, params: []} : s));
}

// JSON-friendly parameters: Dates as ISO text, everything else as it is.
const param = (v) => (v instanceof Date ? v.toISOString() : v);

/**
 * The migrator (GORM's Migrator interface): inspect and change the schema.
 * Every change method runs at once; `plan()` collects changes to run together.
 */
function migrator(run, one) {
  const exec = (statements) => run(statements);
  const m = {
    hasTable: async (table) => (await one('SELECT to_regclass($1) IS NOT NULL AS ok', [qualified(table)])).rows[0].ok,
    hasColumn: async (table, column) => (await one(
      'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS ok',
      [...split(table), column])).rows[0].ok,
    hasIndex: async (_table, name) => (await one('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0].ok,
    columns: async (table) => (await one(
      'SELECT column_name AS name, data_type AS type, is_nullable = \'YES\' AS nullable, column_default AS "default" FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      split(table))).rows,
    tables: async () => (await one("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.name),

    /** Creates missing tables, columns, indexes and policies for these models; never drops or changes anything. */
    async autoMigrate(...models) {
      const statements = [];
      for (const model of models.flat()) {
        if (!model?.columns) throw new TypeError(`autoMigrate needs columns on the ${model?.table ?? 'model'} model`);
        const exists = await m.hasTable(model.table);
        if (!exists) statements.push(...createTable(model.table, model.columns, model));
        else {
          const have = new Set((await m.columns(model.table)).map((c) => c.name));
          for (const [name, def] of Object.entries(model.columns)) {
            if (!have.has(name)) statements.push({sql: `ALTER TABLE ${ident(model.table)} ADD COLUMN IF NOT EXISTS ${columnSql(name, def)}`, params: []});
          }
        }
        statements.push(...indexes(model.table, model.indexes || [], model.columns));
        if (!exists) statements.push(...security(model.table, model));
      }
      if (statements.length) await exec(statements);
      return statements.map((s) => s.sql);
    },

    createTable: (table, columns, options = {}) => exec([...createTable(table, columns, options), ...indexes(table, options.indexes || [], columns), ...security(table, options)]),
    dropTable: (table, {ifExists = true, cascade = false} = {}) => exec([{sql: `DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}${ident(table)}${cascade ? ' CASCADE' : ''}`, params: []}]),
    renameTable: (from, to) => exec([{sql: `ALTER TABLE ${ident(from)} RENAME TO ${ident(to)}`, params: []}]),
    addColumn: (table, name, def) => exec([{sql: `ALTER TABLE ${ident(table)} ADD COLUMN IF NOT EXISTS ${columnSql(name, def)}`, params: []}]),
    dropColumn: (table, name) => exec([{sql: `ALTER TABLE ${ident(table)} DROP COLUMN IF EXISTS ${ident(name)}`, params: []}]),
    renameColumn: (table, from, to) => exec([{sql: `ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`, params: []}]),
    alterColumnType: (table, name, type, {using} = {}) => exec([{sql: `ALTER TABLE ${ident(table)} ALTER COLUMN ${ident(name)} TYPE ${type}${using ? ` USING ${using}` : ''}`, params: []}]),
    setNotNull: (table, name, notNull = true) => exec([{sql: `ALTER TABLE ${ident(table)} ALTER COLUMN ${ident(name)} ${notNull ? 'SET' : 'DROP'} NOT NULL`, params: []}]),
    setDefault: (table, name, value) => exec([{sql: `ALTER TABLE ${ident(table)} ALTER COLUMN ${ident(name)} ${value === undefined || value === null ? 'DROP DEFAULT' : `SET DEFAULT ${value}`}`, params: []}]),
    createIndex: (table, columns, options = {}) => exec(indexes(table, [{columns, ...options}], {})),
    dropIndex: (name) => exec([{sql: `DROP INDEX IF EXISTS ${ident(name)}`, params: []}]),
    addConstraint: (table, name, definition) => exec([{sql: `ALTER TABLE ${ident(table)} ADD CONSTRAINT ${ident(name)} ${definition}`, params: []}]),
    dropConstraint: (table, name) => exec([{sql: `ALTER TABLE ${ident(table)} DROP CONSTRAINT IF EXISTS ${ident(name)}`, params: []}]),
    /** Row-level security on, so the table appears in the Data API once it has a policy. */
    enableRowLevelSecurity: (table) => exec([{sql: `ALTER TABLE ${ident(table)} ENABLE ROW LEVEL SECURITY`, params: []}]),
    createPolicy: (table, policy) => exec([policySql(table, policy)]),
    dropPolicy: (table, name) => exec([{sql: `DROP POLICY IF EXISTS ${ident(name)} ON ${ident(table)}`, params: []}]),

    /** Collects changes to run later, together (used by function migrations). */
    plan() {
      const statements = [];
      const add = (list) => { statements.push(...list); return plan; };
      const plan = {
        statements,
        sql: (text, params = []) => add([{sql: text, params: params.map(param)}]),
        createTable: (t, c, o = {}) => add([...createTable(t, c, o), ...indexes(t, o.indexes || [], c), ...security(t, o)]),
        dropTable: (t, {ifExists = true, cascade = false} = {}) => add([{sql: `DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}${ident(t)}${cascade ? ' CASCADE' : ''}`, params: []}]),
        addColumn: (t, n, d) => add([{sql: `ALTER TABLE ${ident(t)} ADD COLUMN IF NOT EXISTS ${columnSql(n, d)}`, params: []}]),
        dropColumn: (t, n) => add([{sql: `ALTER TABLE ${ident(t)} DROP COLUMN IF EXISTS ${ident(n)}`, params: []}]),
        renameColumn: (t, a, b) => add([{sql: `ALTER TABLE ${ident(t)} RENAME COLUMN ${ident(a)} TO ${ident(b)}`, params: []}]),
        createIndex: (t, c, o = {}) => add(indexes(t, [{columns: c, ...o}], {})),
        dropIndex: (n) => add([{sql: `DROP INDEX IF EXISTS ${ident(n)}`, params: []}]),
        enableRowLevelSecurity: (t) => add([{sql: `ALTER TABLE ${ident(t)} ENABLE ROW LEVEL SECURITY`, params: []}]),
        createPolicy: (t, p) => add([policySql(t, p)])
      };
      return plan;
    }
  };
  return m;
}

function split(table) {
  const parts = table.split('.');
  return parts.length === 2 ? parts : ['public', parts[0]];
}
const qualified = (table) => split(table).map((p) => `"${p.replace(/"/g, '""')}"`).join('.');

/**
 * A column: SQL (`'text not null'`) or `{type, primaryKey, identity, notNull,
 * unique, default (SQL: "now()", "0", "'draft'"), references: 'table(col)' | 'table.col', onDelete, onUpdate, check}`.
 */
export function columnSql(name, def) {
  if (typeof def === 'string') return `${ident(name)} ${def}`;
  if (!def?.type) throw new TypeError(`column ${name} needs a type`);
  const parts = [ident(name), def.type];
  if (def.identity) parts.push('GENERATED BY DEFAULT AS IDENTITY');
  if (def.primaryKey) parts.push('PRIMARY KEY');
  if (def.notNull || def.nullable === false) parts.push('NOT NULL');
  if (def.unique) parts.push('UNIQUE');
  // A default is SQL, as GORM's default tag is: now(), 0, true, '{}'::jsonb, 'draft' (quoted).
  if (def.default !== undefined) parts.push(`DEFAULT ${def.default === null ? 'NULL' : def.default}`);
  if (def.check) parts.push(`CHECK (${def.check})`);
  if (def.references) {
    const m = String(def.references).match(/^([A-Za-z_][\w.]*)\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|\.([A-Za-z_]\w*))?$/);
    if (!m) throw new TypeError(`references is "table(column)" for ${name}`);
    const col = m[2] || m[3];
    parts.push(`REFERENCES ${ident(m[1])}${col ? ` (${ident(col)})` : ''}`);
    if (def.onDelete) parts.push(`ON DELETE ${def.onDelete.toUpperCase()}`);
    if (def.onUpdate) parts.push(`ON UPDATE ${def.onUpdate.toUpperCase()}`);
  }
  return parts.join(' ');
}

function createTable(table, columns, options = {}) {
  const cols = Object.entries(columns).map(([n, d]) => columnSql(n, d));
  if (options.primaryKey && Array.isArray(options.primaryKey)) cols.push(`PRIMARY KEY (${options.primaryKey.map(ident).join(', ')})`);
  for (const u of options.uniques || []) cols.push(`UNIQUE (${[].concat(u).map(ident).join(', ')})`);
  for (const c of options.checks || []) cols.push(`CHECK (${c})`);
  return [{sql: `CREATE TABLE IF NOT EXISTS ${ident(table)} (${cols.join(', ')})`, params: []}];
}

function indexes(table, list, columns) {
  const out = [];
  for (const [name, def] of Object.entries(columns || {})) {
    if (def && typeof def === 'object' && def.index) out.push({columns: [name], ...(typeof def.index === 'object' ? def.index : {})});
  }
  return [...out, ...list].map((ix) => {
    const cols = [].concat(ix.columns);
    const name = ix.name || `${table.replace(/\./g, '_')}_${cols.join('_')}_${ix.unique ? 'key' : 'idx'}`;
    return {
      sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ident(name)} ON ${ident(table)}${ix.using ? ` USING ${ix.using}` : ''} (${cols.map((c) => (/[()\s]/.test(c) ? c : ident(c))).join(', ')})${ix.where ? ` WHERE ${ix.where}` : ''}`,
      params: []
    };
  });
}

// Row-level security and policies from `policies: [{name, for, to, using, check}]`.
function security(table, options) {
  const policies = options.policies || [];
  const rls = options.rowLevelSecurity ?? policies.length > 0;
  return [
    ...(rls ? [{sql: `ALTER TABLE ${ident(table)} ENABLE ROW LEVEL SECURITY`, params: []}] : []),
    ...policies.map((p) => policySql(table, p))
  ];
}

function policySql(table, p) {
  if (!p?.name) throw new TypeError('a policy has a name');
  const cmd = (p.for || 'all').toUpperCase();
  if (!['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(cmd)) throw new TypeError(`policy for is all, select, insert, update or delete`);
  const to = [].concat(p.to || 'authenticated').map((r) => (/^(public|anon|authenticated|service_role)$/.test(r) ? r : ident(r))).join(', ');
  const using = p.using && cmd !== 'INSERT' ? ` USING (${p.using})` : '';
  const check = p.check && cmd !== 'SELECT' && cmd !== 'DELETE' ? ` WITH CHECK (${p.check})` : '';
  return {sql: `CREATE POLICY ${ident(p.name)} ON ${ident(table)} AS ${(p.as || 'permissive').toUpperCase()} FOR ${cmd} TO ${to}${using}${check}`, params: []};
}
