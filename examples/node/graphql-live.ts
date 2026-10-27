// GraphQL on your tables, generated from your schema and limited by
// row-level security: a query, a mutation, and a live query that answers
// again whenever a row it reads changes.
// Live queries need Realtime on for every table they read (here: todos).
//
//   node --env-file=examples/node/.env examples/node/graphql-live.ts
import { connect, signIn } from './config.ts';

// GraphQL carries bigint ids as strings, so no digit is lost.
type Todo = { id: string; title: string; done: boolean };

const db = connect();
await signIn(db);

// A mutation. GraphQL errors come back as data, the way GraphQL returns them.
const created = await db.graphql<{ insertTodosOne: Todo }>(
  `mutation Add($title: String!) { insertTodosOne(object: { title: $title }) { id title done } }`,
  { title: 'Write the launch post' }
);
if (created.errors) throw new Error(created.errors[0].message);
console.log('created', created.data?.insertTodosOne);

// A query with a filter, order and limit; persisted: true sends only the
// query's hash after the first time.
const open = await db.graphql<{ todos: Todo[] }>(
  `query Open { todos(where: { done: { eq: false } }, orderBy: [{ id: DESC }], limit: 10) { id title } }`,
  {},
  { persisted: true }
);
console.log('open todos', open.data?.todos);

// A live query: the answer now, then again after every change it can see.
let answers = 0;
const done = new Promise<void>((resolve) => {
  const live = db.graphql.subscribe<{ todosAggregate: { count: number } }>(
    `subscription { todosAggregate { count } }`,
    {},
    ({ data, errors }) => {
      if (errors) return console.error('live query error:', errors[0].message);
      console.log(`live: you have ${data?.todosAggregate.count} todo(s)`);
      if (++answers === 2) {
        live.unsubscribe();
        resolve();
      }
    }
  );
});

// Change something the live query reads; the new count arrives on its own.
await new Promise((r) => setTimeout(r, 500));
await db.from('todos').create({ title: 'Seen by the live query' });

await Promise.race([
  done,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No live update within 10 s: is Realtime on for todos?')), 10_000))
]);
