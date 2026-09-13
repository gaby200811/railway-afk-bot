const mineflayer = require('mineflayer');
const minecraftData = require('minecraft-data');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

let bot;
let reconnectTimer;
let shouldRun = true;
let movementTimers = [];
let activeDirection;
let navigationMode = 'idle';
let routeRecording = false;
let loginPassword = process.env.MC_PASSWORD || 'Bot@12345';
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const logs = [];
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const routeFile = path.join(dataDir, 'route.json');
let route = fs.existsSync(routeFile) ? JSON.parse(fs.readFileSync(routeFile, 'utf8')) : [];
const supportedVersions = minecraftData.supportedVersions.pc;
const latestSupportedIndex = supportedVersions.indexOf('1.21.11');
const supportedJavaVersions = supportedVersions.slice(0, latestSupportedIndex + 1);

const state = {
  status: 'offline',
  host: 'pmcnet.in',
  port: 19132,
  username: process.env.MC_USERNAME || 'chill_dude1',
  version: '1.21.11',
  supportedVersions: supportedJavaVersions,
  lastEvent: 'Waiting to connect',
  health: null,
  food: null,
  ping: null,
  position: null,
  navigation: 'idle'
};

function updateTelemetry() {
  state.navigation = navigationMode;
  if (bot?.entity) {
    state.health = Math.round(bot.health * 10) / 10;
    state.food = Math.round(bot.food * 10) / 10;
    state.ping = bot.player?.ping ?? null;
    state.position = `${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)}`;
  } else {
    state.health = null;
    state.food = null;
    state.ping = null;
    state.position = null;
  }
  io.emit('state', state);
}

function addLog(message, level = 'info') {
  const entry = {
    message,
    level,
    time: new Date().toISOString()
  };

  logs.push(entry);
  if (logs.length > 100) logs.shift();
  state.lastEvent = message;
  io.emit('log', entry);
  io.emit('state', state);
  console.log(message);
}

function sendChat(message) {
  if (!bot?.entity) {
    addLog('Command skipped: bot is not connected', 'warning');
    return false;
  }

  bot.chat(message);
  addLog(`You: ${message}`, 'command');
  return true;
}

function stopMovement() {
  movementTimers.forEach(timer => clearTimeout(timer));
  movementTimers = [];
  if (bot && activeDirection) bot.setControlState(activeDirection, false);
  if (bot?.pathfinder) bot.pathfinder.setGoal(null);
  activeDirection = undefined;
}

function emitRoute() {
  io.emit('route', { recording: routeRecording, points: route });
}

function saveRoute() {
  fs.writeFileSync(routeFile, JSON.stringify(route, null, 2));
}

function addCheckpoint(label) {
  if (!bot?.entity) return false;
  const point = {
    label: label || `Checkpoint ${route.length + 1}`,
    x: Math.round(bot.entity.position.x * 100) / 100,
    y: Math.round(bot.entity.position.y * 100) / 100,
    z: Math.round(bot.entity.position.z * 100) / 100
  };
  route.push(point);
  saveRoute();
  addLog(`Route checkpoint saved: ${point.label} (${point.x}, ${point.y}, ${point.z})`, 'success');
  emitRoute();
  return true;
}

function createBot() {
  if (bot || !shouldRun) return;

  state.status = 'connecting';
  addLog(`Connecting to ${state.host}:${state.port} on ${state.version}...`);

  bot = mineflayer.createBot({
    host: state.host,
    port: state.port,
    username: state.username,
    version: state.version === 'auto' ? false : state.version
  });
  bot.loadPlugin(pathfinder);

  function handleServerMessage(message) {
    const text = message.toString();
    const msg = text.toLowerCase();
    addLog(text, 'server');

    if (msg.includes('/register') || msg.includes('please register')) {
      addLog('Registration prompt detected', 'system');
      sendChat(`/register ${loginPassword}`);
    } else if (msg.includes('/login') || msg.includes('please login')) {
      addLog('Login prompt detected', 'system');
      sendChat(`/login ${loginPassword}`);
    }

    if (
      msg.includes('teleport to you') ||
      msg.includes('teleport to them')
    ) {
      addLog('Teleport request detected. Accepting...', 'system');
      sendChat('/tpaccept');
    }
  }

  bot.on('messagestr', handleServerMessage);

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const lower = message.toLowerCase();

    if (lower.startsWith('!')) {
      const args = lower.slice(1).split(' ');
      const command = args.shift();

      switch (command) {
        case 'help':
          sendChat(`Hi ${username}, I respond to hello, how are you, and commands like !help, !ping.`);
          break;
        case 'sunilgaming':
          sendChat(`Hey ${username}, sunilgaming created me!`);
          break;
        case 'ping':
          sendChat(`Pong, ${username}!`);
          break;
        default:
          sendChat(`Unknown command: ${command}`);
      }
    } else {
      if (lower.includes('hello')) sendChat(`Hi ${username}!`);
      else if (lower.includes('how are you')) sendChat(`I'm just a bot, but thanks for asking!`);
    }
    addLog(`${username}: ${message}`, 'chat');
  });

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return;
    addLog(`[Whisper] <${username}>: ${message}`, 'chat');
    sendChat(`/tell ${username} Hello ${username}, I got your message!`);
  });

  function randomMovement() {
    if (!bot?.entity || !shouldRun || navigationMode === 'route') return;
    const x = bot.entity.position.x + (Math.random() > 0.5 ? 1 : -1) * (3 + Math.floor(Math.random() * 5));
    const z = bot.entity.position.z + (Math.random() > 0.5 ? 1 : -1) * (3 + Math.floor(Math.random() * 5));
    navigationMode = 'afk';
    bot.pathfinder.setGoal(new goals.GoalNear(x, bot.entity.position.y, z, 1));
    addLog(`AFK movement target: ${Math.round(x)}, ${Math.round(z)}`, 'system');
  }

  bot.once('spawn', () => {
    state.status = 'online';
    addLog(`Connected as ${bot.username}`, 'success');
    bot.pathfinder.setMovements(new Movements(bot));
    setTimeout(() => {
      randomMovement();
    }, 1000);
  });

  bot.on('goal_reached', goal => {
    const wasRoute = navigationMode === 'route';
    addLog(wasRoute ? `Reached route checkpoint near ${goal.x}, ${goal.y}, ${goal.z}` : 'AFK movement target reached', 'success');
    navigationMode = 'idle';
    if (shouldRun) setTimeout(randomMovement, wasRoute ? 1000 : 2000);
  });

  bot.on('path_reset', reason => {
    if (reason === 'goal_updated') return;
    addLog(`Pathfinding stopped: ${reason}`, 'warning');
    if (navigationMode === 'route') return;
    navigationMode = 'idle';
    if (shouldRun && reason === 'stuck') setTimeout(randomMovement, 2000);
  });

  bot.on('end', () => {
    movementTimers.forEach(timer => clearTimeout(timer));
    movementTimers = [];
    bot = null;
    state.status = 'offline';
    addLog('Bot disconnected', 'warning');
    if (shouldRun) {
      addLog('Reconnecting in 5 seconds...', 'system');
      reconnectTimer = setTimeout(createBot, 5000);
    }
  });

  bot.on('error', err => {
    addLog(`Bot error: ${err.message}`, 'error');
  });

  bot.on('kicked', reason => {
    addLog(`Bot was kicked: ${JSON.stringify(reason)}`, 'error');
  });
}

function stopBot() {
  shouldRun = false;
  navigationMode = 'idle';
  clearTimeout(reconnectTimer);
  stopMovement();
  if (bot) bot.quit('Stopped from control panel');
  bot = null;
  state.status = 'offline';
  addLog('Bot stopped from control panel', 'warning');
}

function startBot() {
  if (bot) return;
  shouldRun = true;
  createBot();
}

function reconnectBot() {
  shouldRun = false;
  navigationMode = 'idle';
  clearTimeout(reconnectTimer);
  stopMovement();
  if (bot) bot.quit('Reconnecting from control panel');
  bot = null;
  state.status = 'offline';
  setTimeout(() => {
    shouldRun = true;
    createBot();
  }, 250);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/state', (request, response) => {
  response.json({ state, logs, supportedVersions: supportedJavaVersions });
});

io.on('connection', socket => {
  socket.emit('state', state);
  socket.emit('history', logs);
  socket.emit('versions', supportedJavaVersions);
  socket.emit('route', { recording: routeRecording, points: route });
});

app.post('/api/chat', (request, response) => {
  const message = typeof request.body.message === 'string' ? request.body.message.trim() : '';
  if (!message) return response.status(400).json({ error: 'Message is required' });
  response.json({ sent: sendChat(message) });
});

app.post('/api/config', (request, response) => {
  const { host, port, username, version, password } = request.body;
  const nextPort = Number(port);

  if (!host || !Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535 || !username || !version || (version !== 'auto' && !supportedJavaVersions.includes(version))) {
    return response.status(400).json({ error: 'Host, port, username, and version are required' });
  }

  state.host = host.trim();
  state.port = nextPort;
  state.username = username.trim();
  state.version = version.trim();
  if (typeof password === 'string' && password.length > 0) loginPassword = password;
  addLog(`Configuration updated for ${state.host}:${state.port}`, 'system');
  response.json({ state });
});

app.post('/api/route/:action', (request, response) => {
  const { action } = request.params;
  if (action === 'start') {
    routeRecording = true;
    addLog('Route recording started', 'system');
  } else if (action === 'stop') {
    routeRecording = false;
    saveRoute();
    addLog(`Route recording stopped with ${route.length} checkpoints`, 'system');
  } else if (action === 'checkpoint') {
    if (!routeRecording) return response.status(400).json({ error: 'Start route recording first' });
    if (!addCheckpoint(request.body.label)) return response.status(400).json({ error: 'Bot is not connected' });
  } else if (action === 'clear') {
    route = [];
    saveRoute();
    addLog('Route checkpoints cleared', 'warning');
  } else if (action === 'goto') {
    const point = route[Number(request.body.index)];
    if (!point) return response.status(404).json({ error: 'Checkpoint not found' });
    if (!bot?.entity) return response.status(400).json({ error: 'Bot is not connected' });
    stopMovement();
    navigationMode = 'route';
    const goal = new goals.GoalNear(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z), 1);
    bot.pathfinder.setMovements(new Movements(bot));
    const navigation = bot.pathfinder.goto(goal);
    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('timed out after 60 seconds')), 60000);
    });
    Promise.race([navigation, timeout])
      .then(() => {
        navigationMode = 'idle';
        addLog(`Reached route checkpoint: ${point.label}`, 'success');
      })
      .catch(error => {
        navigationMode = 'idle';
        bot?.pathfinder?.setGoal(null);
        addLog(`Could not reach ${point.label}: ${error.message}`, 'error');
      });
    addLog(`Walking to checkpoint: ${point.label}`, 'system');
  } else return response.status(404).json({ error: 'Unknown route action' });
  emitRoute();
  response.json({ recording: routeRecording, points: route });
});

app.post('/api/action/:action', (request, response) => {
  const { action } = request.params;
  if (action === 'start') startBot();
  else if (action === 'stop') stopBot();
  else if (action === 'reconnect') reconnectBot();
  else return response.status(404).json({ error: 'Unknown action' });
  response.json(state);
});

const panelPort = Number(process.env.PORT || process.env.PANEL_PORT || 3000);
setInterval(updateTelemetry, 1000);
httpServer.listen(panelPort, process.env.PANEL_HOST || '0.0.0.0', () => {
  addLog(`Control panel running on port ${panelPort}`, 'success');
});

createBot();
