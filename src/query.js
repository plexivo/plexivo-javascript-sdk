// The query builder: a GORM-style, chainable description of one operation
// on one table, compiled to the Data API's structured form (POST /query/v1)
// and run as the signed-in user under row-level security.
//
//   await db.from('posts')
//     .select('id', 'title')
//     .where('likes', '>', 10)
//     .orWhere({featured: true})
//     .whereHas('comments', (c) => c.where('approved', true))
//     .preload('author', (a) => a.select('name'))
//     .order('created_at', 'desc')
//     .limit(20);
//
// A builder is immutable: every method returns a new one, so a base query
// can be shared and refined. Awaiting a builder runs find().

import {RecordNotFoundError, PlexivoError} from './errors.js';

const OPERATORS = {
  '=': 'eq', '==': 'eq', eq: 'eq',
  '!=': 'neq', '<>': 'neq', neq: 'neq',
  '>': 'gt', gt: 'gt', '>=': 'gte', gte: 'gte',
  '<': 'lt', lt: 'lt', '<=': 'lte', lte: 'lte',
  like: 'like', ilike: 'ilike', match: 'match', imatch: 'imatch', '~': 'match', '~*': 'imatch',
  in: 'in', is: 'is',
  contains: 'cs', '@>': 'cs', cs: 'cs',
  'contained by': 'cd', containedby: 'cd', '<@': 'cd', cd: 'cd',
  overlaps: 'ov', '&&': 'ov', ov: 'ov',
  fts: 'fts', plfts: 'plfts', phfts: 'phfts', wfts: 'wfts', search: 'wfts'
};
const NEGATED = {'not in': 'in', 'is not': 'is', 'not like': 'like', 'not ilike': 'ilike'};
const MAX_ROWS = 1000;

/**
 * Rows that read both ways: an array (`rows[0]`, `rows.length`, `for…of`)
 * that also carries `data` (itself), `count` and `error: null`, so
 * `const {data, count} = await q` works as it does with Supabase.
 */
export function resultOf(rows, count) {
  const out = Array.isArray(rows) ? rows : [];
  Object.defineProperties(out, {
    data: {value: out, enumerable: false},
    count: {value: count ?? (Array.isArray(rows) ? rows.length : null), enumerable: false, writable: true},
    error: {value: null, enumerable: false}
  });
  return out;
}

// Splits on `sep` outside parentheses and double quotes.
function splitTop(s, sep = ',') {
  const parts = [];
  let depth = 0, quoted = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === sep) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** A PostgREST select string (`id,title,author:authors(name),comments!inner(id)`) as structured items. */
export function parseSelect(spec) {
  const items = [];
  for (const part of splitTop(spec)) {
    const embed = part.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_][\w.]*)(?:!([A-Za-z_]\w*))?\((.*)\)$/s);
    if (embed) {
      const [, as, table, hint, inner] = embed;
      if (inner.trim() === 'count') {
        items.push({aggregate: table, as: as || table, count: true, ...(hint && hint !== 'inner' ? {hint} : {}), __countList: as || table});
        continue;
      }
      const sub = inner.trim() === '' || inner.trim() === '*' ? undefined : parseSelect(inner);
      items.push({embed: table, as: as || table.split('.').pop(), ...(hint === 'inner' ? {inner: true} : hint ? {hint} : {}), ...(sub ? {select: sub.some((x) => typeof x === 'object' && !x.column) && !sub.some((x) => typeof x === 'string' || x.column) ? ['*', ...sub] : sub} : {})});
      continue;
    }
    const m = part.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*|\*)(?:::(text))?$/);
    if (!m) throw new TypeError(`cannot read select item ${part}`);
    const [, as, column, cast] = m;
    if (column === '*') items.push('*');
    else if (as || cast) items.push({column, ...(as ? {as} : {}), ...(cast ? {text: true} : {})});
    else items.push(column);
  }
  return items;
}

/** A PostgREST logic string (`a.eq.1,and(b.gt.2,c.is.null)`) as a filter tree. */
export function parseLogic(spec, joiner = 'or') {
  const nodes = splitTop(String(spec).replace(/^\((.*)\)$/s, '$1')).map((part) => {
    const neg = part.startsWith('not.');
    const body = neg ? part.slice(4) : part;
    const group = body.match(/^(and|or)\((.*)\)$/s);
    let node;
    if (group) node = parseLogic(group[2], group[1]);
    else {
      const m = body.match(/^([A-Za-z_]\w*)\.(not\.)?([a-z]+(?:\([a-z_]+\))?)\.(.*)$/s);
      if (!m) throw new TypeError(`cannot read condition ${part}`);
      node = restCondition(m[1], m[3], m[4]);
      if (m[2]) node = {not: node};
    }
    return neg ? {not: node} : node;
  });
  return nodes.length === 1 ? nodes[0] : {[joiner]: nodes};
}

// One PostgREST `op.value` as a structured condition.
function restCondition(column, op, raw) {
  const unquote = (v) => (/^".*"$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"') : v);
  if (op === 'in') return {column, op: 'in', value: splitTop(raw.replace(/^\((.*)\)$/s, '$1')).map(unquote)};
  if (op === 'is') return {column, op: 'is', value: raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw};
  if (op === 'cs' || op === 'cd' || op === 'ov') {
    const v = raw.startsWith('{') && raw.endsWith('}') && !raw.includes(':') ? splitTop(raw.slice(1, -1)).map(unquote) : (() => { try { return JSON.parse(raw); } catch { return raw; } })();
    return {column, op, value: v};
  }
  return {column, op, value: unquote(raw)};
}

/** Turns `where(...)` arguments into one filter node. */
export function condition(args, ctx) {
  const [a, b, c] = args;
  if (typeof a === 'function') {
    const group = a(new Conditions(ctx));
    const node = (group instanceof Conditions ? group : new Conditions(ctx)).node();
    return node ?? {and: []};
  }
  if (a instanceof Conditions) return a.node() ?? {and: []};
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    // A map: every key equal to its value (null → is null, array → in).
    const parts = Object.entries(a).map(([column, value]) => condition([column, value], ctx));
    return parts.length === 1 ? parts[0] : {and: parts};
  }
  if (typeof a !== 'string' || a === '') throw new TypeError('where() takes a column, an object or a function');
  if (args.length === 2) {
    if (Array.isArray(b)) return {column: a, op: 'in', value: b};
    if (b === null || b === undefined) return {column: a, op: 'is', value: null};
    return {column: a, op: 'eq', value: plain(b)};
  }
  const raw = String(b).trim().toLowerCase();
  if (NEGATED[raw]) return {not: {column: a, op: NEGATED[raw], value: c === null ? null : plain(c)}};
  const fts = raw.match(/^(fts|plfts|phfts|wfts)\(([a-z_]+)\)$/);
  const op = fts ? raw : OPERATORS[raw];
  if (!op) throw new TypeError(`Unknown operator ${b}`);
  if (op === 'eq' && (c === null || c === undefined)) return {column: a, op: 'is', value: null};
  if (op === 'neq' && (c === null || c === undefined)) return {not: {column: a, op: 'is', value: null}};
  return {column: a, op, value: c === undefined ? null : plain(c)};
}

const plain = (v) => (v instanceof Date ? v.toISOString() : v);

/** Combines terms as SQL does: AND binds tighter than OR. */
function combine(terms) {
  if (terms.length === 0) return null;
  const groups = [[]];
  for (const [joiner, node] of terms) {
    if (joiner === 'or' && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(node);
  }
  const ands = groups.map((g) => (g.length === 1 ? g[0] : {and: g}));
  return ands.length === 1 ? ands[0] : {or: ands};
}

/**
 * Filters alone, for groups: `where((q) => q.where('a', 1).orWhere('b', 2))`.
 * Also the base of every query builder.
 */
export class Conditions {
  constructor(ctx, state = {}) {
    this._ctx = ctx;
    this._s = {terms: [], ...state};
  }

  _with(patch) {
    return new this.constructor(this._ctx, {...this._s, ...patch});
  }

  _term(joiner, node) {
    return this._with({terms: [...this._s.terms, [joiner, node]]});
  }

  node() {
    return combine(this._s.terms);
  }

  where(...args) { return this._term('and', condition(args, this._ctx)); }
  orWhere(...args) { return this._term('or', condition(args, this._ctx)); }
  whereNot(...args) { return this._term('and', {not: condition(args, this._ctx)}); }
  orWhereNot(...args) { return this._term('or', {not: condition(args, this._ctx)}); }
  whereIn(column, values) { return this.where(column, 'in', values); }
  whereNotIn(column, values) { return this.where(column, 'not in', values); }
  whereNull(column) { return this.where(column, 'is', null); }
  whereNotNull(column) { return this.where(column, 'is not', null); }
  whereBetween(column, low, high) { return this._term('and', {and: [condition([column, '>=', low]), condition([column, '<=', high])]}); }
  whereNotBetween(column, low, high) { return this._term('and', {not: {and: [condition([column, '>=', low]), condition([column, '<=', high])]}}); }
  whereLike(column, pattern) { return this.where(column, 'like', pattern); }
  whereILike(column, pattern) { return this.where(column, 'ilike', pattern); }
  whereContains(column, value) { return this.where(column, 'contains', value); }
  whereOverlaps(column, value) { return this.where(column, 'overlaps', value); }
  /** Full-text search: `whereSearch('document', 'fast cars', 'english')`. */
  whereSearch(column, text, language) { return this.where(column, language ? `wfts(${language})` : 'wfts', text); }

  /** Inside a json/jsonb column: `whereJson('meta', 'address.city', '=', 'Chennai')`. */
  whereJson(column, path, op, value) {
    const keys = Array.isArray(path) ? path.map(String) : String(path).split('.');
    if (value === undefined) [op, value] = ['=', op];
    const node = condition(['x', op, value]);
    const leaf = node.not ? node.not : node;
    const built = {column, path: keys, op: leaf.op, value: leaf.value};
    return this._term('and', node.not ? {not: built} : built);
  }

  /** A related row exists: `whereHas('comments', (c) => c.where('approved', true))`. */
  whereHas(relation, callback) { return this._term('and', this._ctx.has(relation, callback)); }
  orWhereHas(relation, callback) { return this._term('or', this._ctx.has(relation, callback)); }
  whereDoesntHave(relation, callback) { return this._term('and', {not: this._ctx.has(relation, callback)}); }

  // ── Supabase / PostgREST filter names ─────────────────────────────────
  eq(column, value) { return this.where(column, '=', value); }
  neq(column, value) { return this.where(column, '!=', value); }
  gt(column, value) { return this.where(column, '>', value); }
  gte(column, value) { return this.where(column, '>=', value); }
  lt(column, value) { return this.where(column, '<', value); }
  lte(column, value) { return this.where(column, '<=', value); }
  like(column, pattern) { return this.where(column, 'like', pattern); }
  ilike(column, pattern) { return this.where(column, 'ilike', pattern); }
  is(column, value) { return this.where(column, 'is', value); }
  in(column, values) { return this.where(column, 'in', values); }
  contains(column, value) { return this.where(column, 'contains', value); }
  containedBy(column, value) { return this.where(column, 'contained by', value); }
  overlaps(column, value) { return this.where(column, 'overlaps', value); }
  /** `textSearch('body', 'fast & cars', {type: 'websearch', config: 'english'})`. */
  textSearch(column, query, {type, config} = {}) {
    const fn = {plain: 'plfts', phrase: 'phfts', websearch: 'wfts'}[type] || 'fts';
    return this.where(column, config ? `${fn}(${config})` : fn, query);
  }
  /** Every key equal to its value. */
  match(values) { return this.where(values); }
  /** `not('status', 'eq', 'draft')`, `not('id', 'in', '(1,2)')`. */
  not(column, op, value) { return this._term('and', {not: restCondition(column, op, typeof value === 'string' ? value : Array.isArray(value) ? `(${value.join(',')})` : String(value))}); }
  /** `or('pinned.is.true,body.eq.Groceries')`, PostgREST's syntax. */
  or(spec) { return this._term('and', parseLogic(spec, 'or')); }
  /** `filter('age', 'gte', 18)`, an operator by its PostgREST name. */
  filter(column, op, value) {
    if (op.startsWith('not.')) return this.not(column, op.slice(4), value);
    return this._term('and', restCondition(column, op, typeof value === 'string' ? value : Array.isArray(value) ? `(${value.join(',')})` : String(value)));
  }
}

/** The SELECT list and options of a related-rows embed, nestable. */
class Embed extends Conditions {
  select(...args) {
    let opts;
    if (args.length && args.at(-1) && typeof args.at(-1) === 'object' && !Array.isArray(args.at(-1)) && ('count' in args.at(-1) || 'head' in args.at(-1))) opts = args.pop();
    const items = selectItems(args);
    const columns = items.filter((x) => typeof x === 'string' || x.column);
    const embeds = items.filter((x) => typeof x === 'object' && !x.column);
    let q = this._with({
      select: [...(this._s.select || []), ...columns.filter((c) => c !== '*' || embeds.length || columns.length > 1)],
      embeds: [...(this._s.embeds || []), ...embeds]
    });
    if (opts?.count) q = q._with({count: true});
    if (opts?.head) q = q._with({head: true});
    return q;
  }
  order(...args) { return this._with({order: [...(this._s.order || []), orderTerm(args)]}); }
  orderBy(...args) { return this.order(...args); }
  limit(n) { return this._with({limit: n}); }
  offset(n) { return this._with({offset: n}); }
  preload(relation, callback) { return this._with({embeds: [...(this._s.embeds || []), this._ctx.embed(relation, callback, false)]}); }
  joins(relation, callback) { return this._with({embeds: [...(this._s.embeds || []), this._ctx.embed(relation, callback, true)]}); }
  withCount(relation, callback, as) { return this._with({embeds: [...(this._s.embeds || []), this._ctx.aggregateEmbed(relation, callback, {count: true}, as, true)]}); }
  withAggregate(relation, spec, callback, as) { return this._with({embeds: [...(this._s.embeds || []), this._ctx.aggregateEmbed(relation, callback, spec, as, false)]}); }
}

function selectItems(columns) {
  const out = [];
  for (const c of columns.flat()) {
    if (typeof c === 'string') {
      for (const part of splitTop(c)) {
        const as = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
        if (as) out.push({column: as[1], as: as[2]});
        else out.push(...parseSelect(part));
      }
    } else if (c && typeof c === 'object' && (c.embed || c.aggregate || c.column)) {
      out.push(c);
    } else if (c && typeof c === 'object') {
      for (const [as, column] of Object.entries(c)) out.push({column, as});
    }
  }
  return out;
}

function orderTerm(args) {
  const [a, b, c] = args;
  if (a && typeof a === 'object') return a;
  if (b && typeof b === 'object') {
    const term = {column: a, dir: b.ascending === false ? 'desc' : 'asc'};
    if (b.nullsFirst === true) term.nulls = 'first';
    if (b.nullsFirst === false) term.nulls = 'last';
    return term;
  }
  const [column, dir = 'asc'] = b === undefined ? String(a).trim().split(/\s+/) : [a, b];
  const m = column.match(/^(count|sum|avg|min|max)\((\*|[A-Za-z_][A-Za-z0-9_]*)?\)$/i);
  const d = String(dir).toLowerCase();
  if (d !== 'asc' && d !== 'desc') throw new TypeError(`order direction is asc or desc, not ${dir}`);
  const term = m ? {fn: m[1].toLowerCase(), ...(m[2] && m[2] !== '*' ? {column: m[2]} : {}), dir: d} : {column, dir: d};
  const nulls = (c?.nulls || c || '').toString().toLowerCase();
  if (nulls === 'first' || nulls === 'last') term.nulls = nulls;
  return term;
}

export class QueryBuilder extends Embed {
  constructor(ctx, state = {}) {
    super(ctx, state);
  }

  get table() { return this._ctx.table; }

  // ── shaping ────────────────────────────────────────────────────────────

  distinct(...columns) { return this._with({distinct: columns.flat().length ? columns.flat() : true}); }
  page(number, size = 20) { return this._with({limit: size, offset: (Math.max(1, number) - 1) * size}); }
  /** Rows `from` to `to`, inclusive and zero-based (Supabase's range). */
  range(from, to) { return this._with({offset: from, limit: to - from + 1}); }
  /** Exactly one row as `{data}`; an error when there are none or several. */
  single() { return this._with({single: 'one'}); }
  /** One row or `{data: null}`; an error when there are several. */
  maybeSingle() { return this._with({single: 'maybe'}); }
  /** Supabase's `.select()` after a write asks for the rows back, which is the default here. */
  returning(mode) { return this._with({returning: mode}); }
  latest(column = 'created_at') { return this.order(column, 'desc'); }
  oldest(column = 'created_at') { return this.order(column, 'asc'); }

  /** Row locks, for a select inside a transaction. */
  lock(strength = 'update', wait) { return this._with({lock: {strength, ...(wait ? {wait} : {})}}); }
  lockForUpdate({nowait, skipLocked} = {}) { return this.lock('update', nowait ? 'nowait' : skipLocked ? 'skip_locked' : undefined); }
  forShare({nowait, skipLocked} = {}) { return this.lock('share', nowait ? 'nowait' : skipLocked ? 'skip_locked' : undefined); }

  /** GROUP BY, then aggregate(): `groupBy('author_id').having('count', '>', 1).aggregate({count: true})`. */
  groupBy(...columns) { return this._with({groupBy: [...(this._s.groupBy || []), ...columns.flat()]}); }
  group(...columns) { return this.groupBy(...columns); }

  /** `having('count', '>', 1)` or `having('sum', 'likes', '>=', 100)` or `having('sum(likes) > ?', 100)`. */
  having(...args) { return this._with({having: [...(this._s.having || []), havingNode(args)]}); }

  /** Apply reusable query pieces: `scopes(published, (q) => q.where(...))`, or named model scopes. */
  scopes(...scopes) {
    let q = this;
    for (const s of scopes.flat()) {
      const fn = typeof s === 'string' ? this._ctx.scope(s) : s;
      q = fn(q) ?? q;
    }
    return q;
  }
  scope(...scopes) { return this.scopes(...scopes); }

  /** Lets update() and delete() touch every row (GORM's AllowGlobalUpdate). */
  allowGlobalUpdate() { return this._with({allowGlobal: true}); }

  // A write must say which rows it touches: the soft-delete condition does not count.
  _writeWhere(op) {
    if (!this.node() && !this._s.allowGlobal) {
      throw new PlexivoError(`an ${op} must say which rows it touches: add where(), or allowGlobalUpdate() to touch every row`, {status: 400, code: 'missing_where'});
    }
    const where = this._where();
    return where ?? {not: {column: this._ctx.primaryKey, op: 'is', value: null}};
  }

  /** Include soft-deleted rows (GORM's Unscoped). */
  unscoped() { return this._with({unscoped: true}); }
  /** Only soft-deleted rows. */
  onlyTrashed() { return this._with({onlyTrashed: true}); }

  // ── compiling ──────────────────────────────────────────────────────────

  _where() {
    const nodes = [];
    const base = this.node();
    if (base) nodes.push(base);
    const soft = this._ctx.softDelete;
    if (soft && this._s.onlyTrashed) nodes.push({not: {column: soft, op: 'is', value: null}});
    else if (soft && !this._s.unscoped) nodes.push({column: soft, op: 'is', value: null});
    if (nodes.length === 0) return undefined;
    return nodes.length === 1 ? nodes[0] : {and: nodes};
  }

  /** The structured select operation this builder describes (GORM's DryRun). */
  toQuery(extra = {}) {
    const s = this._s;
    const select = [...(s.select || []), ...(s.embeds || [])];
    return clean({
      op: 'select',
      from: this.table,
      select: select.length ? (s.select?.length ? select : ['*', ...select]) : undefined,
      where: this._where(),
      order: s.order,
      limit: s.limit,
      offset: s.offset,
      distinct: s.distinct,
      lock: s.lock,
      ...extra
    });
  }

  // ── reading ────────────────────────────────────────────────────────────

  // Awaiting a builder runs it: the write it describes, or a read. Rows come
  // back as resultOf (an array with data and count); single()/maybeSingle() as {data}.
  then(resolve, reject) { return this._execute().then(resolve, reject); }
  catch(reject) { return this._execute().catch(reject); }
  finally(fn) { return this._execute().finally(fn); }

  _execute() {
    if (!this._run) this._run = this._s.write ? this._runWrite() : this._runRead();
    return this._run;
  }

  _runRead() {
    const s = this._s;
    const q = s.single ? this.limit(2) : this;
    return this._ctx.send(() => q.toQuery(s.count ? {count: true} : {}), async ({data, count}) => {
      const rows = await this._ctx.afterFind(this._ctx.shape(data, s.embeds));
      if (s.single) return single(rows, s.single, this.table, count);
      if (s.head) return {data: null, count: count ?? null, error: null};
      return resultOf(rows, count);
    }, 'rows');
  }

  _runWrite() {
    const w = this._s.write;
    const s = this._s;
    const finish = (rows) => (s.single ? single(rows, s.single, this.table) : rows);
    if (w.kind === 'insert') return this.create(w.values, {...w.options, __rows: true}).then(finish);
    if (w.kind === 'upsert') return this._upsert(w.values, w.options).then(finish);
    if (w.kind === 'update') return this._update(w.values, {returning: s.returning}).then(finish);
    return this._delete({returning: s.returning}).then(finish);
  }

  /** Rows (all matching, up to the limit; at most 1,000 per call). Pass ids to look them up by primary key. */
  find(ids) {
    const q = ids === undefined ? this : this.whereIn(this._ctx.primaryKey, [].concat(ids));
    return this._ctx.send(() => q.toQuery(), async ({data, count}) => resultOf(await this._ctx.afterFind(this._ctx.shape(data, q._s.embeds)), count), 'rows');
  }
  get(...ids) { return ids.length ? this.find(ids.flat()) : this.find(); }

  /** The first row by primary key (or by your order), or RecordNotFoundError. `first(id)` looks one up. */
  async first(id) {
    const q = (id === undefined ? this : this.where(this._ctx.primaryKey, id));
    const ordered = q._s.order?.length ? q : q.order(this._ctx.primaryKey, 'asc');
    const [row] = await ordered.limit(1).find();
    if (row === undefined) throw new RecordNotFoundError(this.table);
    return row;
  }
  /** The last row by primary key, or RecordNotFoundError. */
  async last() {
    const q = this._s.order?.length ? this._with({order: this._s.order.map(flip)}) : this.order(this._ctx.primaryKey, 'desc');
    const [row] = await q.limit(1).find();
    if (row === undefined) throw new RecordNotFoundError(this.table);
    return row;
  }
  /** Any one row, no order, or RecordNotFoundError. */
  async take() {
    const [row] = await this.limit(1).find();
    if (row === undefined) throw new RecordNotFoundError(this.table);
    return row;
  }
  /** Like first(), but null instead of an error. */
  async firstOrNull(id) {
    try { return await this.first(id); } catch (e) { if (e instanceof RecordNotFoundError) return null; throw e; }
  }
  /** Exactly one row (else an error): for lookups that must be unique. */
  async sole() {
    const rows = await this.limit(2).find();
    if (rows.length === 0) throw new RecordNotFoundError(this.table);
    if (rows.length > 1) throw Object.assign(new Error(`more than one row in ${this.table}`), {code: 'multiple_rows'});
    return rows[0];
  }

  /** One column's values: `pluck('email')`. */
  async pluck(column) {
    const rows = await this._with({select: [column], embeds: []}).find();
    return rows.map((r) => r[column]);
  }

  async count() {
    const {data} = await this._ctx.run(clean({op: 'aggregate', from: this.table, where: this._where(), count: true}));
    return Number(data.count);
  }
  async exists() { return (await this.limit(1)._with({select: [this._ctx.primaryKey], embeds: []}).find()).length > 0; }
  async sum(column) { return num((await this._aggregate({sum: [column]})).sum?.[column]); }
  async avg(column) { return num((await this._aggregate({avg: [column]})).avg?.[column]); }
  async min(column) { return (await this._aggregate({min: [column]})).min?.[column] ?? null; }
  async max(column) { return (await this._aggregate({max: [column]})).max?.[column] ?? null; }

  /**
   * Aggregates: `{count: true, sum: ['likes'], avg: [...], min: [...], max: [...]}`.
   * After groupBy(), one object per group, with its group columns.
   */
  async aggregate(spec = {count: true}) {
    if (this._s.groupBy?.length) {
      const having = this._s.having?.length ? (this._s.having.length === 1 ? this._s.having[0] : {and: this._s.having}) : undefined;
      const {data} = await this._ctx.run(clean({
        op: 'aggregate', from: this.table, where: this._where(), group_by: this._s.groupBy,
        having, order: this._s.order, limit: this._s.limit, ...aggSpec(spec)
      }));
      return data;
    }
    return this._aggregate(spec);
  }
  async _aggregate(spec) {
    const {data} = await this._ctx.run(clean({op: 'aggregate', from: this.table, where: this._where(), ...aggSpec(spec)}));
    return data;
  }

  /** `{data, total, page, perPage, totalPages}` for page `page` of `perPage` rows. */
  async paginate({page = 1, perPage = 20} = {}) {
    const q = this.page(page, perPage);
    const {data, count} = await this._ctx.run(q.toQuery({count: true}));
    const total = Number(count ?? 0);
    return {
      data: await this._ctx.afterFind(this._ctx.shape(data, q._s.embeds)),
      total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage))
    };
  }

  /**
   * Every row in batches (GORM's FindInBatches): ordered by primary key and
   * read page by page with a key cursor, so rows are neither skipped nor
   * repeated while the callback works. Return false to stop.
   */
  async findInBatches(size, callback) {
    const pk = this._ctx.primaryKey;
    const n = Math.min(Math.max(1, size), MAX_ROWS);
    let cursor;
    let batch = 0;
    for (;;) {
      let q = this._with({order: [{column: pk, dir: 'asc'}], limit: n});
      if (cursor !== undefined) q = q.where(pk, '>', cursor);
      const rows = await q.find();
      if (rows.length === 0) return;
      if ((await callback(rows, batch++)) === false) return;
      if (rows.length < n) return;
      cursor = rows.at(-1)[pk];
      if (cursor === undefined) throw new Error(`findInBatches needs ${pk} in the selected columns`);
    }
  }
  /** Each row, one at a time, read in batches of 500. */
  async each(callback) {
    await this.findInBatches(500, async (rows) => {
      for (const row of rows) if ((await callback(row)) === false) return false;
      return undefined;
    });
  }
  async *[Symbol.asyncIterator]() {
    const pk = this._ctx.primaryKey;
    let cursor;
    for (;;) {
      let q = this._with({order: [{column: pk, dir: 'asc'}], limit: 500});
      if (cursor !== undefined) q = q.where(pk, '>', cursor);
      const rows = await q.find();
      for (const row of rows) yield row;
      if (rows.length < 500) return;
      cursor = rows.at(-1)[pk];
    }
  }

  // ── writing ────────────────────────────────────────────────────────────

  /**
   * Inserts one row (returns it) or many (returns them). Options:
   * `returning: 'minimal'` (count only), `omit: [...]` or `only: [...]` keys.
   */
  create(values, options = {}) {
    const many = Array.isArray(values);
    const list = [].concat(values).map((r) => pick(r, options));
    if (list.length > MAX_ROWS && !options.__rows) {
      // More than one request: not atomic. Use createInBatches or a transaction to choose.
      return this.createInBatches(list, MAX_ROWS);
    }
    return this._ctx.send(
      async () => clean({op: 'insert', into: this.table, values: await this._ctx.beforeWrite('Create', list.map(({__rows, ...r}) => r)), returning: options.returning}),
      async ({data, count}) => {
        if (options.__rows) {
          if (options.returning === 'minimal') return resultOf([], count);
          await this._ctx.afterWrite('Create', data);
          return resultOf(data, count);
        }
        if (options.returning === 'minimal') return count;
        await this._ctx.afterWrite('Create', data);
        return many ? data : data[0];
      },
      many || options.__rows ? 'rows' : 'row'
    );
  }
  /** GORM's CreateInBatches: `size` rows per request. */
  async createInBatches(values, size = 100) {
    const out = [];
    for (let i = 0; i < values.length; i += size) out.push(...await this.create(values.slice(i, i + size)));
    return out;
  }
  /** The 0.1 API: inserts and returns what the Data API returns. */
  insert(values, options = {}) {
    if (this._ctx.deferred) return this.create(values, {...options, __rows: true});
    return this._with({write: {kind: 'insert', values, options}});
  }

  /**
   * Inserts, or on conflict updates: `upsert(rows, {onConflict: ['sku'], update: ['price']})`.
   * `update: false` (or `ignore: true`) keeps the existing row untouched.
   */
  upsert(values, options = {}) {
    if (this._ctx.deferred) return this._upsert(values, options);
    return this._with({write: {kind: 'upsert', values, options}});
  }
  _upsert(values, {onConflict, update, ignore, ignoreDuplicates, returning} = {}) {
    const many = Array.isArray(values);
    const conflict = onConflict ? (typeof onConflict === 'string' ? onConflict.split(',').map((c) => c.trim()) : [].concat(onConflict)) : [this._ctx.primaryKey];
    ignore = ignore || ignoreDuplicates;
    return this._ctx.send(
      async () => clean({
        op: 'insert', into: this.table, values: await this._ctx.beforeWrite('Save', [].concat(values)), on_conflict: conflict,
        upsert: ignore || update === false ? 'ignore' : 'merge',
        update_columns: Array.isArray(update) ? update : undefined, returning
      }),
      async ({data, count}) => {
        if (returning === 'minimal') return resultOf([], count);
        await this._ctx.afterWrite('Save', data);
        return resultOf(data, count);
      },
      'rows'
    );
  }
  /** GORM's Save: inserts a row without its primary key, otherwise updates every column it carries. */
  save(row) {
    const pk = this._ctx.primaryKey;
    if (row?.[pk] === undefined || row?.[pk] === null) return this.create(row);
    return this._upsert(row, {onConflict: [pk]}).then((rows) => rows[0]);
  }

  /**
   * Updates the matching rows; a filter is required. The 0.1 form
   * `update(id, values)` updates one row by primary key.
   */
  update(values, maybeValues, options = {}) {
    if (maybeValues !== undefined && (typeof values !== 'object' || values === null)) {
      return this.where(this._ctx.primaryKey, values)._update(maybeValues, options).then((rows) => {
        if (rows.length === 0) throw new RecordNotFoundError(this.table);
        return rows[0];
      });
    }
    if (this._ctx.deferred) return this._update(values, options);
    return this._with({write: {kind: 'update', values}, returning: options.returning ?? this._s.returning});
  }
  _update(values, options = {}) {
    let where;
    try { where = this._writeWhere('update'); } catch (e) { return Promise.reject(e); }
    return this._write(async () => {
      const [set] = await this._ctx.beforeWrite('Update', [values]);
      return {op: 'update', table: this.table, set, where, returning: options.returning};
    }, 'Update', options.returning);
  }
  /** One column: `updateColumn('status', 'archived')`. */
  updateColumn(column, value) { return this.update({[column]: value}); }
  /** Atomic counters: `increment('views')`, `increment('stock', -2, {updated_at: now})`. */
  increment(column, by = 1, extra = {}) {
    let where;
    try { where = this._writeWhere('update'); } catch (e) { return Promise.reject(e); }
    const op = {op: 'update', table: this.table, set: Object.keys(extra).length ? extra : undefined, inc: {[column]: by}, where};
    return this._write(() => op, 'Update');
  }
  decrement(column, by = 1, extra = {}) { return this.increment(column, -by, extra); }

  /**
   * Deletes the matching rows (a filter is required), or soft-deletes them
   * when the model has a soft-delete column. `delete(id)` deletes one by key.
   */
  delete(id, options = {}) {
    if (id !== undefined && (typeof id !== 'object' || id === null)) {
      return this.where(this._ctx.primaryKey, id)._delete(options).then((rows) => {
        if (rows.length === 0) throw new RecordNotFoundError(this.table);
        return rows[0];
      });
    }
    if (id && typeof id === 'object') options = id;
    if (this._ctx.deferred) return this._delete(options);
    return this._with({write: {kind: 'delete'}, returning: options.returning ?? this._s.returning});
  }
  _delete(options = {}) {
    let where;
    try { where = this._writeWhere('delete'); } catch (e) { return Promise.reject(e); }
    const soft = this._ctx.softDelete && !this._s.unscoped;
    return this._write(async () => {
      await this._ctx.beforeWrite('Delete', [this.toQuery()]);
      return soft
        ? {op: 'update', table: this.table, set: {[this._ctx.softDelete]: new Date().toISOString()}, where}
        : {op: 'delete', from: this.table, where, returning: options.returning};
    }, 'Delete', options.returning);
  }
  /** Deletes for good, even with a soft-delete column. */
  forceDelete() { return this.unscoped()._delete(); }
  /** Brings soft-deleted rows back. */
  restore() {
    if (!this._ctx.softDelete) throw new Error(`${this.table} has no soft-delete column`);
    const op = {op: 'update', table: this.table, set: {[this._ctx.softDelete]: null}, where: this.unscoped()._where()};
    return this._write(() => op, 'Update');
  }

  _write(build, hook, returning) {
    return this._ctx.send(
      async () => clean(await build()),
      async ({data, count}) => {
        if (returning === 'minimal') return resultOf([], count);
        await this._ctx.afterWrite(hook, data);
        return resultOf(data, count);
      },
      'rows'
    );
  }

  /** The first matching row, or a new one made from the filter's values and `defaults`. */
  async firstOrCreate(attributes, defaults = {}) {
    const found = await this.where(attributes).firstOrNull();
    return found ?? this.create({...attributes, ...defaults});
  }
  /** The first matching row, or (unsaved) the filter's values and `defaults`. */
  async firstOrInit(attributes, defaults = {}) {
    return (await this.where(attributes).firstOrNull()) ?? {...attributes, ...defaults};
  }
  /** Updates the matching row with `values`, or creates it. */
  async updateOrCreate(attributes, values = {}) {
    const rows = await this.where(attributes)._update(values);
    return rows[0] ?? this.create({...attributes, ...values});
  }
}

function single(rows, mode, table, count) {
  if (rows.length > 1) throw Object.assign(new Error(`more than one row in ${table}`), {code: 'multiple_rows', status: 406});
  if (rows.length === 0 && mode === 'one') throw new RecordNotFoundError(table);
  return {data: rows[0] ?? null, count: count ?? rows.length, error: null};
}

function havingNode(args) {
  if (args.length === 1 && typeof args[0] === 'object') return args[0];
  let fn, column, op, value;
  if (typeof args[0] === 'string' && /\?/.test(args[0])) {
    const m = args[0].match(/^\s*(count|sum|avg|min|max)\s*\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*)?\s*\)\s*(=|!=|<>|>=|<=|>|<)\s*\?\s*$/i);
    if (!m) throw new TypeError('having takes "fn(column) op ?" with one value');
    [fn, column, op, value] = [m[1].toLowerCase(), m[2] === '*' ? undefined : m[2], m[3], args[1]];
  } else if (args.length === 3) [fn, op, value] = args;
  else [fn, column, op, value] = args;
  const leaf = condition(['x', op, value]);
  return clean({fn: String(fn).toLowerCase(), column, op: leaf.op, value: leaf.value});
}

function aggSpec(spec) {
  const out = {};
  if (spec.count) out.count = true;
  for (const k of ['sum', 'avg', 'min', 'max']) if (spec[k]) out[k] = [].concat(spec[k]);
  return out;
}

const flip = (t) => ({...t, dir: t.dir === 'desc' ? 'asc' : 'desc'});
const num = (v) => (v === null || v === undefined ? null : Number(v));

function pick(row, {omit, only}) {
  if (!row || typeof row !== 'object') throw new TypeError('a row is an object of columns');
  let out = {...row};
  if (only) out = Object.fromEntries(Object.entries(out).filter(([k]) => only.includes(k)));
  if (omit) for (const k of omit) delete out[k];
  return out;
}

export function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

export {Embed, selectItems, orderTerm};
