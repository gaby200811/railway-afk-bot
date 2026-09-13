const { BotSession } = require('./botSession');

const sessions = new Map();

function getOrCreate(username, io) {
  if (!sessions.has(username)) sessions.set(username, new BotSession(username, io));
  return sessions.get(username);
}

function get(username) {
  return sessions.get(username);
}

function remove(username) {
  const session = sessions.get(username);
  if (session) {
    session.dispose();
    sessions.delete(username);
  }
}

function all() {
  return Array.from(sessions.values());
}

module.exports = { getOrCreate, get, remove, all };
