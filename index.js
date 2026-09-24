require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('node:http');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { Server } = require('socket.io');
const { Movements, goals } = require('mineflayer-pathfinder');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { requireAuth, requireAdmin } = require('./lib/auth');
const userStore = require('./lib/userStore');
const botManager = require('./lib/botManager');
const { isRateLimited, recordAttempt, clearAttempts } = require('./lib/rateLimiter');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Refuse to boot with insecure defaults rather than silently running unprotected.
if (!ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is not set. Create a .env file (see .env.example) or set it in your host\'s environment variables.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.set('trust proxy', 1); // required for secure cookies behind Railway/most PaaS reverse proxies
app.use(express.json());

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');

const sessionMiddleware = session({
  name: 'aurora.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: path.join(dataDir, 'sessions'),
    ttl: 60 * 60 * 24 * 7, // seconds, matches cookie maxAge below
    logFn: () => {} // the default store logging is noisy; our own logs cover errors
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

  let authedUser = null;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    authedUser = { username: ADMIN_USERNAME, role: 'admin' };
  } else {
    authedUser = userStore.verifyUser(username, password);
  }

  if (!authedUser) {
    recordAttempt(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearAttempts(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Login failed, please try again' });
    req.session.user = authedUser;
    res.json({ user: authedUser });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.session.user });
});

// ---------------------------------------------------------------------------
// Admin: user management (no public self-registration exists anywhere)
// ---------------------------------------------------------------------------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: userStore.listUsers() });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password of at least 6 characters are required' });
  }
  try {
    const user = userStore.createUser(username.trim(), password);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;
  botManager.remove(username);
  const removed = userStore.deleteUser(username);
  res.json({ removed });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Bot control API — every route below is scoped to req.session.user.username,
// so each logged-in user only ever sees and controls their own bot instance.
// ---------------------------------------------------------------------------
app.get('/api/state', requireAuth, (req, res) => {
  const bot = botManager.getOrCreate(req.session.user.username, io);
  res.json({ state: bot.state, logs: bot.logs, supportedVersions: bot.state.supportedVersions });
});

app.post('/api/chat', requireAuth, (req, res) => {
  const bot = botManager.getOrCreate(req.session.user.username, io);
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Message is required' });
  res.json({ sent: bot.sendChat(message) });
});

app.post('/api/config', requireAuth, (req, res) => {
  const bot = botManager.getOrCreate(req.session.user.username, io);
  const result = bot.updateConfig(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ state: bot.state });
});

app.post('/api/route/:action', requireAuth, (req, res) => {
  const bot = botManager.getOrCreate(req.session.user.username, io);
  const { action } = req.params;

  if (action === 'start') {
    bot.routeRecording = true;
    bot.addLog('Route recording started', 'system');
  } else if (action === 'stop') {
    bot.routeRecording = false;
    bot.persist();
    bot.addLog(`Route recording stopped with ${bot.route.length} checkpoints`, 'system');
  } else if (action === 'checkpoint') {
    if (!bot.routeRecording) return res.status(400).json({ error: 'Start route recording first' });
    if (!bot.addCheckpoint(req.body.label)) return res.status(400).json({ error: 'Bot is not connected' });
  } else if (action === 'clear') {
    bot.route = [];
    bot.persist();
    bot.addLog('Route checkpoints cleared', 'warning');
  } else if (action === 'goto') {
    const point = bot.route[Number(req.body.index)];
    if (!point) return res.status(404).json({ error: 'Checkpoint not found' });
    if (!bot.bot?.entity) return res.status(400).json({ error: 'Bot is not connected' });
    bot.stopMovement();
    bot.navigationMode = 'route';
    const goal = new goals.GoalNear(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z), 1);
    bot.bot.pathfinder.setMovements(new Movements(bot.bot));
    const navigation = bot.bot.pathfinder.goto(goal);
    const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out after 60 seconds')), 60000));
    Promise.race([navigation, timeout])
      .then(() => {
        bot.navigationMode = 'idle';
        bot.addLog(`Reached route checkpoint: ${point.label}`, 'success');
      })
      .catch(error => {
        bot.navigationMode = 'idle';
        bot.bot?.pathfinder?.setGoal(null);
        bot.addLog(`Could not reach ${point.label}: ${error.message}`, 'error');
      });
    bot.addLog(`Walking to checkpoint: ${point.label}`, 'system');
  } else {
    return res.status(404).json({ error: 'Unknown route action' });
  }
  bot.emitRoute();
  res.json({ recording: bot.routeRecording, points: bot.route });
});

app.post('/api/action/:action', requireAuth, (req, res) => {
  const bot = botManager.getOrCreate(req.session.user.username, io);
  const { action } = req.params;
  if (action === 'start') bot.start();
  else if (action === 'stop') bot.stop();
  else if (action === 'reconnect') bot.reconnect();
  else return res.status(404).json({ error: 'Unknown action' });
  res.json(bot.state);
});

// ---------------------------------------------------------------------------
// Socket.io — authenticated via the same session cookie, each socket only
// joins its own user's private room.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const user = socket.request.session?.user;
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  const bot = botManager.getOrCreate(socket.user.username, io);
  socket.join(bot.room);
  socket.emit('state', bot.state);
  socket.emit('history', bot.logs);
  socket.emit('versions', bot.state.supportedVersions);
  socket.emit('route', { recording: bot.routeRecording, points: bot.route });
});

// ---------------------------------------------------------------------------
// Live 3D viewer — each connected bot runs its own prismarine-viewer server
// on a loopback-only internal port. We proxy it through the single public
// port so it works behind Railway/any PaaS without exposing extra ports.
// ---------------------------------------------------------------------------
function getViewerProxyForUser(username) {
  const bot = botManager.get(username);
  if (!bot?.viewerPort) return null;
  if (bot._viewerProxy && bot._viewerProxyPort === bot.viewerPort) return bot._viewerProxy;
  bot._viewerProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${bot.viewerPort}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: { '^/viewer': '' }
  });
  bot._viewerProxyPort = bot.viewerPort;
  return bot._viewerProxy;
}

app.use('/viewer', requireAuth, (req, res, next) => {
  const proxy = getViewerProxyForUser(req.session.user.username);
  if (!proxy) return res.status(503).send('Live view is not available yet. Start the bot and wait for it to connect.');
  return proxy(req, res, next);
});

// Express doesn't forward WebSocket 'upgrade' events to middleware on its
// own, so we handle it manually — reusing the same session cookie to figure
// out which user's (and therefore which internal port's) viewer to proxy to.
httpServer.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith('/viewer')) return; // let socket.io's own listener handle the rest
  const fakeRes = { getHeader() {}, setHeader() {}, end() {}, writeHead() {}, on() {}, once() {}, emit() {} };
  sessionMiddleware(request, fakeRes, () => {
    const username = request.session?.user?.username;
    const proxy = username ? getViewerProxyForUser(username) : null;
    if (!proxy) { socket.destroy(); return; }
    proxy.upgrade(request, socket, head);
  });
});


process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

function shutdown() {
  console.log('Shutting down, disconnecting all bots...');
  for (const bot of botManager.all()) {
    try { bot.stop(); } catch (err) { console.error(err); }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const panelPort = Number(process.env.PORT || process.env.PANEL_PORT || 3000);
setInterval(() => { for (const bot of botManager.all()) bot.updateTelemetry(); }, 1000);

httpServer.listen(panelPort, process.env.PANEL_HOST || '0.0.0.0', () => {
  console.log(`Control panel running on port ${panelPort}`);
  console.log(`Admin login: ${ADMIN_USERNAME}`);
});