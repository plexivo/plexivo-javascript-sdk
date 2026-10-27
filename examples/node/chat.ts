// Realtime chat: new messages arrive as row changes; "typing…" and who is
// online travel through a room with broadcast and presence. Two users in
// one script, so you can watch both sides.
// Needs Realtime switched on for the messages table.
//
//   node --env-file=examples/node/.env examples/node/chat.ts
import type { Change } from '@plexivo/client';
import type { Database } from '../database.types.ts';
import { connect, signIn } from './config.ts';

type Message = Database['public']['Tables']['messages']['Row'];

const asha = connect();
const ben = connect();
await signIn(asha);
await signIn(ben, { fresh: true }); // a second, separate user

// Ben listens for new messages in the lobby. Each subscriber receives only
// the rows their own row-level security lets them read.
const received = new Promise<Message>((resolve) => {
  const feed = ben.channel<Message>('changes:messages', { filter: 'room=eq.lobby' })
    .onChange((change: Change<Message>) => {
      if (change.type === 'insert' && change.record) {
        console.log(`ben sees: "${change.record.body}"`);
        feed.unsubscribe();
        resolve(change.record);
      }
    })
    .onError((error) => console.error('feed error:', error.code))
    .subscribe();
  void feed.ready().then(() => console.log('ben is listening'));
});

// A room for typing indicators and presence: nothing is stored.
const benRoom = ben.channel('room:lobby', { presence: { name: 'Ben' } })
  .onBroadcast('typing', (payload) => console.log(`ben sees: ${payload.name} is typing…`))
  .onPresence(({ event }) => console.log(`ben sees presence: ${event}`))
  .subscribe();
const ashaRoom = asha.channel('room:lobby', { presence: { name: 'Asha' } }).subscribe();
await Promise.all([benRoom.ready(), ashaRoom.ready()]);

ashaRoom.sendBroadcast('typing', { name: 'Asha' });

// Asha posts; the insert reaches Ben over the feed.
await new Promise((r) => setTimeout(r, 300));
await asha.from('messages').create({ body: 'Hello from Asha 👋' });

const message = await Promise.race([
  received,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No message within 10 s: is Realtime on for messages?')), 10_000))
]);
console.log('delivered message', message.id);

// The latest messages, oldest first, for a chat window.
const history = await asha.from('messages').where('room', 'lobby').order('id', 'desc').limit(20);
console.log(`${history.length} message(s) in the lobby`);

benRoom.unsubscribe();
ashaRoom.unsubscribe();
