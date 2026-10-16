// Models: what GORM learns from a struct, said once — the table, its primary
// key, relations, hooks, scopes, soft deletes and (for migrations) columns.
//
//   const Post = db.model('posts', {
//     softDelete: 'deleted_at',
//     relations: {
//       author: belongsTo('authors', {foreignKey: 'author_id'}),
//       comments: hasMany('comments', {foreignKey: 'post_id'}),
//       tags: manyToMany('tags', {through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id'})
//     },
//     hooks: {beforeCreate: (row) => ({...row, slug: slugify(row.title)})},
//     scopes: {published: (q) => q.where('published', true)}
//   });
//
//   await Post.query().scopes('published').preload('author').preload('tags').find();
//   await Post.association(post, 'tags').append([elixir, postgres]);
//
// Without a model, relations are table names and the database's foreign keys
// decide how rows relate.

import {QueryBuilder, Embed} from './query.js';

/** This table holds the foreign key: `posts.author_id → authors.id`. */
export const belongsTo = (table, options = {}) => ({kind: 'belongsTo', table, ...options});
/** The other table holds the foreign key, one row per row here. */
export const hasOne = (table, options = {}) => ({kind: 'hasOne', table, ...options});
/** The other table holds the foreign key, many rows per row here. */
export const hasMany = (table, options = {}) => ({kind: 'hasMany', table, ...options});
/** Related through a link table: `posts ⇄ post_tags ⇄ tags`. */
export const manyToMany = (table, options = {}) => {
  if (!options.through) throw new TypeError('manyToMany needs {through: "link_table"}');
  return {kind: 'manyToMany', table, ...options};
};

const HOOKS = ['beforeSave', 'beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'afterSave', 'beforeDelete', 'afterDelete', 'afterFind'];

/** The per-table context a QueryBuilder compiles and runs against. */
export function tableContext(client, table, model = {}) {
  const relations = model.relations || {};
  const hooks = model.hooks || {};
  for (const name of Object.keys(hooks)) if (!HOOKS.includes(name)) throw new TypeError(`Unknown hook ${name}; hooks are ${HOOKS.join(', ')}`);

  const relation = (name) => {
    if (relations[name]) return {name, ...relations[name]};
    const [t, hint] = String(name).split('!');
    return {name: t, kind: 'auto', table: t, constraint: hint};
  };

  const sub = (ctxTable, callback) => {
    const target = client._model(ctxTable);
    const q = new Embed(tableContext(client, ctxTable, target));
    const out = callback ? callback(q) : q;
    return out instanceof Embed ? out : q;
  };

  const embedOf = (rel, q, inner, as) => {
    const s = q._s;
    const softWhere = (t) => {
      const soft = client._model(t)?.softDelete;
      return soft ? {column: soft, op: 'is', value: null} : null;
    };
    const where = (node, t) => {
      const parts = [node, softWhere(t)].filter(Boolean);
      return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : {and: parts};
    };
    const select = [...(s.select || []), ...(s.embeds || [])];
    const selectList = select.length ? (s.select?.length ? select : ['*', ...select]) : undefined;
    if (rel.kind === 'manyToMany') {
      return clean({
        embed: rel.through, as: `__m2m_${as}`, hint: rel.throughConstraint, inner,
        limit: s.limit, offset: s.offset,
        select: [clean({embed: rel.table, as: '__target', hint: rel.constraint, inner: true, select: selectList, where: where(q.node(), rel.table)})],
        __m2m: {as, order: s.order}
      });
    }
    return clean({
      embed: rel.table, as, hint: rel.constraint, inner,
      select: selectList, where: where(q.node(), rel.table), order: s.order, limit: s.limit, offset: s.offset,
      __hasOne: rel.kind === 'hasOne' ? as : undefined
    });
  };

  const ctx = {
    table,
    primaryKey: model.primaryKey || 'id',
    softDelete: model.softDelete,
    // Inside a transaction every write is recorded at once, in call order.
    deferred: client._deferred === true,
    model,
    run: (op) => client._query(stripPrivate(op)),
    send: (build, finish, shape) => client._send(async () => stripPrivate(await build()), finish, shape),
    relation,

    embed(name, callback, inner, as) {
      const rel = relation(name);
      return embedOf(rel, sub(rel.table, callback), inner, as || rel.name);
    },

    aggregateEmbed(name, callback, spec, as, countOnly) {
      const rel = relation(name);
      const q = sub(rel.table, callback);
      const out = as || `${rel.name}_${countOnly ? 'count' : 'aggregate'}`;
      const node = q.node();
      if (rel.kind === 'manyToMany') {
        return clean({aggregate: rel.through, as: out, hint: rel.throughConstraint, ...spec,
          where: node ? {has: rel.table, hint: rel.constraint, where: node} : undefined, __count: countOnly ? out : undefined});
      }
      return clean({aggregate: rel.table, as: out, hint: rel.constraint, ...spec, where: node || undefined, __count: countOnly ? out : undefined});
    },

    has(name, callback) {
      const rel = relation(name);
      const node = callback ? sub(rel.table, callback).node() : null;
      const soft = client._model(rel.table)?.softDelete;
      const inner = [node, soft ? {column: soft, op: 'is', value: null} : null].filter(Boolean);
      const where = inner.length === 0 ? undefined : inner.length === 1 ? inner[0] : {and: inner};
      if (rel.kind === 'manyToMany') {
        return {has: rel.through, ...(rel.throughConstraint ? {hint: rel.throughConstraint} : {}), where: clean({has: rel.table, hint: rel.constraint, where})};
      }
      return clean({has: rel.table, hint: rel.constraint, where});
    },

    scope(name) {
      const fn = model.scopes?.[name];
      if (!fn) throw new TypeError(`${table} has no scope ${name}`);
      return fn;
    },

    // Shapes what the server returned into what the relations promise.
    shape(rows, embeds = []) {
      if (!embeds?.length) return rows;
      return rows.map((row) => shapeRow(row, embeds));
    },

    async afterFind(rows) {
      if (!hooks.afterFind) return rows;
      const out = [];
      for (const r of rows) out.push((await hooks.afterFind(r, ctx)) ?? r);
      return out;
    },

    async beforeWrite(kind, rows) {
      const chain = {Create: ['beforeSave', 'beforeCreate'], Update: ['beforeSave', 'beforeUpdate'], Save: ['beforeSave'], Delete: ['beforeDelete']}[kind];
      let out = rows;
      for (const name of chain) {
        if (!hooks[name]) continue;
        const next = [];
        for (const r of out) next.push((await hooks[name](r, ctx)) ?? r);
        out = next;
      }
      return out;
    },

    async afterWrite(kind, rows) {
      const chain = {Create: ['afterCreate', 'afterSave'], Update: ['afterUpdate', 'afterSave'], Save: ['afterSave'], Delete: ['afterDelete']}[kind];
      for (const name of chain) if (hooks[name]) for (const r of rows || []) await hooks[name](r, ctx);
    }
  };
  return ctx;
}

function shapeRow(row, embeds) {
  const out = {...row};
  for (const e of embeds) {
    if (e.__m2m) {
      const key = `__m2m_${e.__m2m.as}`;
      let list = (out[key] || []).map((link) => link.__target).filter(Boolean);
      const nested = e.select?.[0]?.select?.filter((x) => x && typeof x === 'object' && (x.embed || x.aggregate)) || [];
      if (nested.length) list = list.map((r) => shapeRow(r, nested));
      if (e.__m2m.order?.length) list = sortRows(list, e.__m2m.order);
      delete out[key];
      out[e.__m2m.as] = list;
    } else if (e.__hasOne) {
      out[e.__hasOne] = Array.isArray(out[e.__hasOne]) ? out[e.__hasOne][0] ?? null : out[e.__hasOne] ?? null;
    } else if (e.__count) {
      out[e.__count] = Number(out[e.__count]?.count ?? 0);
    }
    const name = e.as || e.embed;
    const nested = (e.select || []).filter((x) => x && typeof x === 'object' && (x.embed || x.aggregate) && !e.__m2m);
    if (nested.length && out[name]) out[name] = Array.isArray(out[name]) ? out[name].map((r) => shapeRow(r, nested)) : shapeRow(out[name], nested);
  }
  return out;
}

function sortRows(rows, order) {
  return [...rows].sort((a, b) => {
    for (const t of order) {
      const x = a[t.column], y = b[t.column];
      if (x === y) continue;
      if (x === null || x === undefined) return t.nulls === 'first' ? -1 : 1;
      if (y === null || y === undefined) return t.nulls === 'first' ? 1 : -1;
      const c = x < y ? -1 : 1;
      return t.dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

// Private shaping markers never reach the server.
function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('__')) out[k] = stripPrivate(v);
    return out;
  }
  return value;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
}

/** A model: a table with its relations, hooks and scopes, and shortcuts to query it. */
export function defineModel(client, table, options = {}) {
  const pk = options.primaryKey || 'id';
  const model = {
    table,
    ...options,
    primaryKey: pk,
    query: () => client.from(table),
    association: (row, name) => association(client, model, row, name)
  };
  // GORM-style shortcuts: Post.where(...), Post.first(1), Post.create({...}) …
  // — every query builder method, except names the model itself uses.
  const reserved = new Set(['constructor', 'then', 'catch', 'finally', 'table', 'node', ...Object.keys(model)]);
  for (let proto = QueryBuilder.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name.startsWith('_') || reserved.has(name) || name in model) continue;
      if (typeof Object.getOwnPropertyDescriptor(proto, name).value !== 'function') continue;
      model[name] = (...args) => client.from(table)[name](...args);
    }
  }
  return model;
}

/**
 * GORM's association mode for one row: find, append, replace, delete (the
 * link, not the related row), clear and count. Multi-step changes run in one
 * transaction.
 */
function association(client, model, row, name) {
  const rel = model.relations?.[name];
  if (!rel) throw new TypeError(`${model.table} has no relation ${name}`);
  const pk = model.primaryKey;
  const id = row && typeof row === 'object' ? row[pk] : row;
  if (id === undefined || id === null) throw new TypeError(`association needs the ${model.table} row or its ${pk}`);
  const target = client._model(rel.table);
  const targetPk = rel.references || target?.primaryKey || 'id';
  const keyOf = (v) => (v && typeof v === 'object' ? v[targetPk] : v);
  const fk = rel.foreignKey;

  if (rel.kind === 'belongsTo') {
    if (!fk) throw new TypeError(`belongsTo ${name} needs foreignKey`);
    return {
      find: () => client.from(model.table).where(pk, id).select(fk).first().then((r) => (r[fk] == null ? null : client.from(rel.table).firstOrNull(r[fk]))),
      append: (related) => client.from(model.table).where(pk, id).update({[fk]: keyOf([].concat(related)[0])}),
      replace: (related) => client.from(model.table).where(pk, id).update({[fk]: keyOf(related)}),
      delete: () => client.from(model.table).where(pk, id).update({[fk]: null}),
      clear: () => client.from(model.table).where(pk, id).update({[fk]: null}),
      count: () => client.from(model.table).where(pk, id).whereNotNull(fk).count()
    };
  }

  if (rel.kind === 'hasOne' || rel.kind === 'hasMany') {
    if (!fk) throw new TypeError(`${rel.kind} ${name} needs foreignKey (the column on ${rel.table})`);
    const owner = rel.references ? row[rel.references] : id;
    const children = () => client.from(rel.table).where(fk, owner);
    const attach = (tx, list) => {
      const existing = list.filter((r) => r && typeof r === 'object' && r[targetPk] != null || (typeof r !== 'object'));
      const fresh = list.filter((r) => r && typeof r === 'object' && r[targetPk] == null);
      if (existing.length) tx.from(rel.table).whereIn(targetPk, existing.map(keyOf)).update({[fk]: owner});
      if (fresh.length) tx.from(rel.table).create(fresh.map((r) => ({...r, [fk]: owner})));
    };
    return {
      find: (callback) => (callback ? callback(children()) : children()).find(),
      append: (related) => client.transaction((tx) => attach(tx, [].concat(related))),
      replace: (related) => client.transaction((tx) => {
        const list = [].concat(related);
        const keep = list.map(keyOf).filter((v) => v != null && typeof v !== 'object');
        let q = tx.from(rel.table).where(fk, owner);
        if (keep.length) q = q.whereNotIn(targetPk, keep);
        q.update({[fk]: null});
        attach(tx, list);
      }),
      delete: (related) => client.from(rel.table).where(fk, owner).whereIn(targetPk, [].concat(related).map(keyOf)).update({[fk]: null}),
      clear: () => children().update({[fk]: null}),
      count: () => children().count()
    };
  }

  if (rel.kind === 'manyToMany') {
    const {through, foreignKey, otherKey} = rel;
    if (!foreignKey || !otherKey) throw new TypeError(`manyToMany ${name} needs foreignKey and otherKey (the link table's columns)`);
    const links = () => client.from(through).where(foreignKey, id);
    const linkRows = (list) => list.map((r) => ({[foreignKey]: id, [otherKey]: keyOf(r)}));
    return {
      find: (callback) => {
        const q = client.from(rel.table).whereHas(through, (l) => l.where(foreignKey, id));
        return (callback ? callback(q) : q).find();
      },
      append: (related) => client.from(through).upsert(linkRows([].concat(related)), {onConflict: [foreignKey, otherKey], ignore: true}),
      replace: (related) => client.transaction((tx) => {
        const keys = [].concat(related).map(keyOf);
        let q = tx.from(through).where(foreignKey, id);
        if (keys.length) q = q.whereNotIn(otherKey, keys);
        q.delete();
        if (keys.length) tx.from(through).upsert(linkRows([].concat(related)), {onConflict: [foreignKey, otherKey], ignore: true});
      }),
      delete: (related) => links().whereIn(otherKey, [].concat(related).map(keyOf)).delete(),
      clear: () => links().delete(),
      count: () => links().count()
    };
  }
  throw new TypeError(`unknown relation kind ${rel.kind}`);
}

export {QueryBuilder};
