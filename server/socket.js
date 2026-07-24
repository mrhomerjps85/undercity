// socket.js - Real-time layer: live "who's in this room" presence, plus global and
// clan chat. Uses the same express-session middleware as the REST API so the server
// can trust req.session/socket.request.session rather than whatever the client claims.
const db = require('./db/db');

let io = null;

function roomChannel(roomId) {
  return `room:${roomId}`;
}
function clanChannel(clanId) {
  return `clan:${clanId}`;
}

function getCharacterForSocket(socket) {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return null;
  return db.prepare('SELECT * FROM characters WHERE user_id = ?').get(userId) || null;
}

function getRoomPlayers(roomId) {
  return db.prepare('SELECT id, name, level FROM characters WHERE current_room_id = ?').all(roomId);
}

function broadcastRoomPresence(roomId) {
  if (!io) return;
  io.to(roomChannel(roomId)).emit('presence_update', { roomId, players: getRoomPlayers(roomId) });
}

function recentChatHistory(channel, limit = 30) {
  return db.prepare(`
    SELECT character_name, text, created_at FROM chat_messages
    WHERE channel = ? ORDER BY id DESC LIMIT ?
  `).all(channel, limit).reverse();
}

function init(httpServer, sessionMiddleware) {
  const { Server } = require('socket.io');
  io = new Server(httpServer);

  // Share the same session store the REST API uses, so sockets are authenticated
  // via the existing login cookie rather than trusting anything the client sends.
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.on('connection', (socket) => {
    const character = getCharacterForSocket(socket);
    if (!character) {
      socket.disconnect(true);
      return;
    }

    socket.data.characterId = character.id;
    socket.data.currentRoomId = character.current_room_id;

    socket.join(roomChannel(character.current_room_id));
    socket.join('global');
    if (character.clan_id) socket.join(clanChannel(character.clan_id));

    // Send recent history so joining a channel doesn't look empty.
    socket.emit('chat_history', { channel: 'global', messages: recentChatHistory('global') });
    if (character.clan_id) {
      socket.emit('chat_history', { channel: `clan:${character.clan_id}`, messages: recentChatHistory(clanChannel(character.clan_id)) });
    }

    broadcastRoomPresence(character.current_room_id);

    // Client calls this right after a successful REST move/teleport. We re-read the
    // character's room from the DB ourselves rather than trusting a client-supplied id.
    socket.on('room_changed', () => {
      const fresh = db.prepare('SELECT current_room_id, clan_id FROM characters WHERE id = ?').get(socket.data.characterId);
      if (!fresh) return;
      const oldRoomId = socket.data.currentRoomId;
      const newRoomId = fresh.current_room_id;
      if (newRoomId === oldRoomId) return;

      socket.leave(roomChannel(oldRoomId));
      socket.join(roomChannel(newRoomId));
      socket.data.currentRoomId = newRoomId;

      broadcastRoomPresence(oldRoomId);
      broadcastRoomPresence(newRoomId);
    });

    // Re-sync clan channel membership (e.g. after joining/leaving/creating a clan via REST).
    socket.on('clan_changed', () => {
      const fresh = db.prepare('SELECT clan_id FROM characters WHERE id = ?').get(socket.data.characterId);
      // Leave all clan:* rooms this socket might be in, then rejoin the current one if any.
      for (const room of socket.rooms) {
        if (room.startsWith('clan:')) socket.leave(room);
      }
      if (fresh && fresh.clan_id) {
        const channel = clanChannel(fresh.clan_id);
        socket.join(channel);
        socket.emit('chat_history', { channel, messages: recentChatHistory(channel) });
      }
    });

    socket.on('chat_message', ({ channel, text }) => {
      if (typeof text !== 'string') return;
      const trimmed = text.trim().slice(0, 300); // hard cap so nobody can flood with huge messages
      if (!trimmed) return;

      const current = db.prepare('SELECT clan_id FROM characters WHERE id = ?').get(socket.data.characterId);
      let targetChannel;
      if (channel === 'global') {
        targetChannel = 'global';
      } else if (channel === 'clan') {
        if (!current || !current.clan_id) return; // not in a clan, can't send to clan chat
        targetChannel = clanChannel(current.clan_id);
      } else {
        return;
      }

      db.prepare('INSERT INTO chat_messages (channel, character_id, character_name, text) VALUES (?, ?, ?, ?)')
        .run(targetChannel, character.id, character.name, trimmed);

      io.to(targetChannel).emit('chat_message', {
        channel: targetChannel,
        characterName: character.name,
        text: trimmed,
        createdAt: new Date().toISOString(),
      });
    });

    socket.on('disconnect', () => {
      broadcastRoomPresence(socket.data.currentRoomId);
    });
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { init, getIO, roomChannel, clanChannel, broadcastRoomPresence };
