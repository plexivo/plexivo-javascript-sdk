// Plexivo Postgres in the browser: sign in, a live todo list, a realtime
// chat with a typing indicator, a GraphQL live count and a Plexivo Function.
// Only the publishable key is here; row-level security does the rest.
import { createClient, PlexivoError, type RealtimeChannel, type Session } from '@plexivo/client';
import type { Database } from '../../database.types';

type Todo = Database['public']['Tables']['todos']['Row'];
type Message = Database['public']['Tables']['messages']['Row'];

const url = import.meta.env.VITE_PLEXIVO_URL;
const key = import.meta.env.VITE_PLEXIVO_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Copy .env.example to .env.local and fill in your project URL and publishable key.');

// The session is kept in localStorage and refreshed for you.
const db = createClient<Database>(url, key);

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const show = (error: unknown) => {
  const el = $('#error');
  el.hidden = false;
  el.textContent = error instanceof PlexivoError ? `${error.message} (${error.code ?? error.status})` : String(error);
};
const clearError = () => ($('#error').hidden = true);
const text = (value: string) => document.createTextNode(value);

// ── auth ─────────────────────────────────────────────────────────────────

$<HTMLFormElement>('#sign-in').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  const form = new FormData(event.target as HTMLFormElement);
  const credentials = { email: String(form.get('email')), password: String(form.get('password')) };
  const mode = (event.submitter as HTMLButtonElement | null)?.value;
  try {
    if (mode === 'up') await db.auth.signUp(credentials);
    else await db.auth.signInWithPassword(credentials);
  } catch (error) {
    show(error);
  }
});

$('#sign-out').addEventListener('click', () => db.auth.signOut());

let stop: Array<() => void> = [];
db.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED') return;
  render(session);
});
render(db.auth.getSession());

function render(session: Session | null) {
  stop.forEach((fn) => fn());
  stop = [];
  $('#status').textContent = session ? `Signed in as ${session.user.email}` : 'Signed out';
  $('#auth').hidden = Boolean(session);
  $('#app').hidden = !session;
  if (session) void start().catch(show);
}

// ── todos: CRUD, plus row changes from other tabs and devices ────────────

async function loadTodos() {
  const todos = await db.from('todos').order('done').order('created_at', 'desc').limit(50);
  const list = $('#todos');
  list.replaceChildren(...todos.map(todoItem));
}

function todoItem(todo: Todo) {
  const li = document.createElement('li');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = todo.done;
  box.addEventListener('change', () => db.from('todos').where('id', todo.id).update({ done: box.checked }).then(loadTodos, show));
  const remove = document.createElement('button');
  remove.textContent = '×';
  remove.addEventListener('click', () => db.from('todos').where('id', todo.id).delete().then(loadTodos, show));
  li.append(box, text(` ${todo.title} `), remove);
  return li;
}

$<HTMLFormElement>('#add-todo').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const title = String(new FormData(form).get('title')).trim();
  try {
    await db.from('todos').create({ title });
    form.reset();
    await loadTodos();
  } catch (error) {
    show(error);
  }
});

// ── chat: messages as row changes, typing over a room ────────────────────

function messageItem(message: Message) {
  const li = document.createElement('li');
  li.textContent = message.body;
  return li;
}

let room: RealtimeChannel | null = null;
let typingTimer: ReturnType<typeof setTimeout> | undefined;

$<HTMLFormElement>('#send').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const body = String(new FormData(form).get('body')).trim();
  try {
    await db.from('messages').create({ body });
    form.reset();
  } catch (error) {
    show(error);
  }
});
$<HTMLInputElement>('#send input').addEventListener('input', () => {
  try {
    room?.sendBroadcast('typing', { email: db.auth.getSession()?.user.email ?? 'someone' });
  } catch {
    // Not connected yet: a missed typing hint is harmless.
  }
});

async function start() {
  await loadTodos();

  // Todos changed elsewhere (another tab, another device): reload.
  const todoFeed = db.channel<Todo>('changes:todos').onChange(() => void loadTodos()).subscribe();
  stop.push(() => todoFeed.unsubscribe());

  // The last 20 messages, then each new one as it is inserted.
  const recent = await db.from('messages').where('room', 'lobby').order('id', 'desc').limit(20);
  $('#messages').replaceChildren(...recent.reverse().map(messageItem));
  const feed = db.channel<Message>('changes:messages', { filter: 'room=eq.lobby' })
    .onChange(({ type, record }) => {
      if (type === 'insert' && record) $('#messages').append(messageItem(record));
    })
    .subscribe();
  stop.push(() => feed.unsubscribe());

  room = db.channel('room:lobby')
    .onBroadcast('typing', ({ email }) => {
      $('#typing').textContent = `${email} is typing…`;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => ($('#typing').textContent = ''), 1500);
    })
    .subscribe();
  stop.push(() => { room?.unsubscribe(); room = null; });

  // A GraphQL live query: the count updates by itself.
  const live = db.graphql.subscribe<{ todosAggregate: { count: number } }>(
    'subscription { todosAggregate { count } }', {},
    ({ data }) => ($('#live-count').textContent = data ? `${data.todosAggregate.count} in total` : '')
  );
  stop.push(() => live.unsubscribe());
}

// ── Plexivo Functions ────────────────────────────────────────────────────

$('#call-hello').addEventListener('click', async () => {
  try {
    const { data } = await db.functions.invoke<{ message: string }>('hello', { body: { name: 'browser' } });
    $('#hello-result').textContent = data.message;
  } catch (error) {
    show(error);
  }
});
