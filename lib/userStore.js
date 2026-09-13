const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const usersFile = path.join(dataDir, 'users.json');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function loadUsers() {
  ensureDataDir();
  if (!fs.existsSync(usersFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  ensureDataDir();
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function findUser(username) {
  return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
}

function createUser(username, password) {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 characters: letters, numbers, underscore, or hyphen only');
  }
  if (username.toLowerCase() === 'admin') throw new Error('That username is reserved for the admin account');
  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('That username already exists');
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = { username, passwordHash, role: 'user', createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  return { username: user.username, role: user.role, createdAt: user.createdAt };
}

function deleteUser(username) {
  const users = loadUsers();
  const next = users.filter(u => u.username.toLowerCase() !== username.toLowerCase());
  saveUsers(next);
  return next.length !== users.length;
}

function verifyUser(username, password) {
  const user = findUser(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.passwordHash)) return null;
  return { username: user.username, role: user.role };
}

function listUsers() {
  return loadUsers().map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt }));
}

module.exports = { createUser, deleteUser, verifyUser, listUsers, findUser };
