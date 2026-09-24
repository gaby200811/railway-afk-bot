const mineflayer = require('mineflayer');
const minecraftData = require('minecraft-data');
const fs = require('fs');
const path = require('path');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const { getVersion: getViewerSupportedVersion } = require('prismarine-viewer/viewer/lib/version');
const { SocksClient } = require('socks');
const { allocatePort, releasePort } = require('./viewerPorts');
const connectThrottle = require('./connectThrottle');

// FIX: prismarine-viewer's bundled client only ships texture/model data for
// a small hardcoded list of releases. If the bot's actual server version
// (e.g. a snapshot string, or anything outside that list) doesn't resolve,
// its own client-side code crashes with the unhelpful alert "null is not
// supported". We clamp to the closest version it actually supports before
// handing the bot off to it, with a hard fallback so this can never be null.
const VIEWER_FALLBACK_VERSION = '1.21.4';

function clampVersionForViewer(version) {
  try {
    return getViewerSupportedVersion(version) || VIEWER_FALLBACK_VERSION;
  } catch {
    return VIEWER_FALLBACK_VERSION;
  }
}

function wrapBotForViewer(bot) {
  return new Proxy(bot, {
    get(target, prop, receiver) {
      if (prop === 'version') return clampVersionForViewer(target.version);
      return Reflect.get(target, prop, receiver);
    }
  });
}

function createProxyConnector(proxyAddress, targetHost, targetPort) {
  if (!proxyAddress) return undefined;

  const proxyUrl = new URL(proxyAddress);
  if (proxyUrl.protocol !== 'socks5:' && proxyUrl.protocol !== 'socks5h:') {
    throw new Error('MC_PROXY must use a socks5:// or socks5h:// URL');
  }
  if (!proxyUrl.hostname || !proxyUrl.port) {
    throw new Error('MC_PROXY must include a proxy hostname and port');
  }

  return client => {
    SocksClient.createConnection({
      proxy: {
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        type: 5,
        userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
        password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
      },
      command: 'connect',
      destination: { host: targetHost, port: targetPort }
    }).then(({ socket }) => {
      client.setSocket(socket);
      client.emit('connect');
    }).catch(error => client.emit('error', error));
  };
}

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');

const allSupportedVersions = minecraftData.supportedVersions.pc;
const PREFERRED_LATEST = '1.21.11';
const latestSupportedIndex = allSupportedVersions.indexOf(PREFERRED_LATEST);
// FIX: if minecraft-data ever drops this exact version string, indexOf returns
// -1 and the old code's slice(0, 0) silently produced an EMPTY version list.
// Fall back to the full supported list instead of quietly breaking the dropdown.
const supportedJavaVersions = latestSupportedIndex === -1
  ? allSupportedVersions.slice()
  : allSupportedVersions.slice(0, latestSupportedIndex + 1);

const MOVEMENT_WATCHDOG_MS = 15000;
const MOVEMENT_STUCK_RETRY_MS = 3000;
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 120000;
const RATE_LIMIT_COOLDOWN_MS = 45000;

class BotSession {
  constructor(username, io) {
    this.ownerUsername = username;
    this.io = io;
    this.room = `bot:${username}`;
    this.bot = null;
    this.shouldRun = false;
    this.proxyFallbackActive = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.movementTimers = [];
    this.activeDirection = undefined;
    this.navigationMode = 'idle';
    this.routeRecording = false;
    this.lastWatchdogPosition = null;
    this.logs = [];
    this._pendingEndResolve = null;
    this.viewerPort = null;

    this.dataFile = path.join(dataDir, 'bots', `${username}.json`);
    const saved = this._load();

    this.loginPassword = saved.password || '';
    this.route = saved.route || [];
    this.watchedPlayers = saved.watchedPlayers || [];
    this.state = {
      status: 'offline',
      host: saved.host || '',
      port: saved.port || 25565,
      username: saved.mcUsername || `${username}_bot`,
      version: saved.version || 'auto',
      supportedVersions: supportedJavaVersions,
      lastEvent: 'Waiting to connect',
      health: null,
      food: null,
      ping: null,
      position: null,
      navigation: 'idle',
      viewerAvailable: false
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.dataFile)) return JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    } catch {
      /* ignore corrupt/missing file, start fresh */
    }
    return {};
  }

  persist() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify({
      host: this.state.host,
      port: this.state.port,
      mcUsername: this.state.username,
      version: this.state.version,
      password: this.loginPassword,
      route: this.route,
      watchedPlayers: this.watchedPlayers
    }, null, 2));
  }

  emit(event, payload) {
    this.io.to(this.room).emit(event, payload);
  }

  addLog(message, level = 'info') {
    const entry = { message, level, time: new Date().toISOString() };
    this.logs.push(entry);
    if (this.logs.length > 150) this.logs.shift();
    this.state.lastEvent = message;
    this.emit('log', entry);
    this.emit('state', this.state);
    console.log(`[${this.ownerUsername}] ${message}`);
  }

  updateTelemetry() {
    this.state.navigation = this.navigationMode;
    if (this.bot?.entity) {
      this.state.health = Math.round(this.bot.health * 10) / 10;
      this.state.food = Math.round(this.bot.food * 10) / 10;
      this.state.ping = this.bot.player?.ping ?? null;
      this.state.position = `${Math.floor(this.bot.entity.position.x)}, ${Math.floor(this.bot.entity.position.y)}, ${Math.floor(this.bot.entity.position.z)}`;
    } else {
      this.state.health = null;
      this.state.food = null;
      this.state.ping = null;
      this.state.position = null;
    }
    this.emit('state', this.state);
  }

  sendChat(message) {
    if (!this.bot?.entity) {
      this.addLog('Command skipped: bot is not connected', 'warning');
      return false;
    }
    this.bot.chat(message);
    this.addLog(`You: ${message}`, 'command');
    return true;
  }

  stopMovement() {
    this.movementTimers.forEach(timer => clearTimeout(timer));
    this.movementTimers = [];
    if (this.bot) {
      if (this.activeDirection) this.bot.setControlState(this.activeDirection, false);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('jump', false);
    }
    if (this.bot?.pathfinder) this.bot.pathfinder.setGoal(null);
    this.activeDirection = undefined;
  }

  emitWatchlist() {
    this.emit('watchlist', this.watchedPlayers);
  }

  addWatchedPlayer(username) {
    const name = username.trim();
    if (!name) return { ok: false, error: 'Username is required' };
    if (this.watchedPlayers.some(p => p.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'Already watching that name' };
    }
    this.watchedPlayers.push(name);
    this.persist();
    this.emitWatchlist();
    this.addLog(`Now watching for "${name}" to join`, 'system');
    return { ok: true };
  }

  removeWatchedPlayer(username) {
    const before = this.watchedPlayers.length;
    this.watchedPlayers = this.watchedPlayers.filter(p => p.toLowerCase() !== username.toLowerCase());
    if (this.watchedPlayers.length === before) return { ok: false, error: 'Not found' };
    this.persist();
    this.emitWatchlist();
    this.addLog(`Stopped watching for "${username}"`, 'system');
    return { ok: true };
  }

  emitRoute() {
    this.emit('route', { recording: this.routeRecording, points: this.route });
  }

  addCheckpoint(label) {
    if (!this.bot?.entity) return false;
    const point = {
      label: label || `Checkpoint ${this.route.length + 1}`,
      x: Math.round(this.bot.entity.position.x * 100) / 100,
      y: Math.round(this.bot.entity.position.y * 100) / 100,
      z: Math.round(this.bot.entity.position.z * 100) / 100
    };
    this.route.push(point);
    this.persist();
    this.addLog(`Route checkpoint saved: ${point.label} (${point.x}, ${point.y}, ${point.z})`, 'success');
    this.emitRoute();
    return true;
  }

  startViewer() {
    if (this.viewerPort) return;
    try {
      this.viewerPort = allocatePort();
      mineflayerViewer(wrapBotForViewer(this.bot), { port: this.viewerPort, firstPerson: false, viewDistance: 4 });
      this.state.viewerAvailable = true;
      this.addLog('Live 3D view ready', 'success');
    } catch (err) {
      this.state.viewerAvailable = false;
      this.addLog(`Could not start live view: ${err.message}`, 'warning');
    }
  }

  stopViewer() {
    if (this.viewerPort) {
      try { this.bot?.viewer?.close?.(); } catch { /* best effort */ }
      releasePort(this.viewerPort);
      this.viewerPort = null;
    }
    this.state.viewerAvailable = false;
  }

  clearWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  // FIX: dead-man switch. Pathfinder can sometimes neither succeed nor emit a
  // clean failure event (e.g. against certain server anti-cheat/lag spikes).
  // If AFK mode hasn't moved the bot in 15s, force a fresh movement target.
  startWatchdog() {
    this.clearWatchdog();
    this.lastWatchdogPosition = null;
    this.watchdogTimer = setInterval(() => {
      if (!this.bot?.entity || this.navigationMode !== 'afk') return;
      const pos = this.bot.entity.position;
      const key = `${Math.round(pos.x)}:${Math.round(pos.y)}:${Math.round(pos.z)}`;
      if (this.lastWatchdogPosition === key) {
        this.addLog('Movement watchdog: bot appears stuck, forcing a new target', 'warning');
        this.stopMovement();
        this.navigationMode = 'idle';
        this.attemptMovement();
      }
      this.lastWatchdogPosition = key;
    }, MOVEMENT_WATCHDOG_MS);
  }

  randomMovement() {
    if (!this.bot?.entity || !this.shouldRun || this.navigationMode === 'route') return;
    const x = this.bot.entity.position.x + (Math.random() > 0.5 ? 1 : -1) * (3 + Math.floor(Math.random() * 5));
    const z = this.bot.entity.position.z + (Math.random() > 0.5 ? 1 : -1) * (3 + Math.floor(Math.random() * 5));
    this.navigationMode = 'afk';
    this.bot.pathfinder.setGoal(new goals.GoalNear(x, this.bot.entity.position.y, z, 1));
    this.addLog(`AFK movement target: ${Math.round(x)}, ${Math.round(z)}`, 'system');
  }

  // FIX: A* pathfinding can legitimately fail to find any route at all in a
  // tight AFK pen/cage — every random target ends up unreachable, so the bot
  // keeps "trying" (repeated path_reset) without ever actually moving. After
  // a few consecutive failures, fall back to plain WASD-style walking, which
  // can shuffle around a small enclosed space where A* gives up outright.
  simpleWander() {
    if (!this.bot?.entity || !this.shouldRun) return;
    this.navigationMode = 'afk';
    const yaw = Math.random() * Math.PI * 2;
    this.bot.look(yaw, 0, true).catch(() => {});
    this.bot.setControlState('forward', true);
    if (Math.random() < 0.3) this.bot.setControlState('jump', true);
    const walkMs = 700 + Math.floor(Math.random() * 500);
    this.movementTimers.push(setTimeout(() => {
      if (!this.bot) return;
      this.bot.setControlState('forward', false);
      this.bot.setControlState('jump', false);
      this.navigationMode = 'idle';
      if (this.shouldRun) this.movementTimers.push(setTimeout(() => this.attemptMovement(), 1500));
    }, walkMs));
  }

  attemptMovement() {
    if ((this._consecutiveFailures || 0) >= 3) {
      this._consecutiveFailures = 0;
      this.addLog('Pathfinding kept failing — trying a simple walk instead', 'system');
      this.simpleWander();
    } else {
      this.randomMovement();
    }
  }

  async createBot() {
    if (this.bot || this._connecting || !this.shouldRun) return;
    this._connecting = true;

    const hostKey = `${this.state.host}:${this.state.port}`.toLowerCase();
    await connectThrottle.waitForSlot(hostKey);

    // Re-check: stop()/reconnect() or another call may have run while we
    // were queued waiting for a free connection slot on this host.
    if (this.bot || !this.shouldRun) { this._connecting = false; return; }

    this.state.status = 'connecting';
    this.addLog(`Connecting to ${this.state.host}:${this.state.port} on ${this.state.version}...`);

    let proxyConnector;
    try {
      const proxyAddress = this.proxyFallbackActive ? process.env.MC_PROXY : undefined;
      proxyConnector = createProxyConnector(proxyAddress, this.state.host, this.state.port);
      if (proxyConnector) this.addLog('Using SOCKS5 fallback proxy', 'system');
    } catch (err) {
      this._connecting = false;
      this.state.status = 'offline';
      this.addLog(`Invalid MC_PROXY configuration: ${err.message}`, 'error');
      return;
    }

    const bot = mineflayer.createBot({
      host: this.state.host,
      port: this.state.port,
      username: this.state.username,
      version: this.state.version === 'auto' ? false : this.state.version,
      connect: proxyConnector
    });
    this._connecting = false;
    this.bot = bot;
    bot.loadPlugin(pathfinder);

    const handleServerMessage = message => {
      const text = message.toString();
      const msg = text.toLowerCase();
      this.addLog(text, 'server');

      if (msg.includes('/register') || msg.includes('please register')) {
        this.addLog('Registration prompt detected', 'system');
        this.sendChat(`/register ${this.loginPassword} ${this.loginPassword}`);
      } else if (msg.includes('/login') || msg.includes('please login')) {
        this.addLog('Login prompt detected', 'system');
        this.sendChat(`/login ${this.loginPassword}`);
      }

      if (msg.includes('teleport to you') || msg.includes('teleport to them')) {
        this.addLog('Teleport request detected. Accepting...', 'system');
        this.sendChat('/tpaccept');
      }
    };
    bot.on('messagestr', handleServerMessage);

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      const lower = message.toLowerCase();

      if (lower.startsWith('!')) {
        const args = lower.slice(1).split(' ');
        const command = args.shift();
        switch (command) {
          case 'help':
            this.sendChat(`Hi ${username}, I respond to hello, how are you, and commands like !help, !ping.`);
            break;
          case 'ping':
            this.sendChat(`Pong, ${username}!`);
            break;
          default:
            this.sendChat(`Unknown command: ${command}`);
        }
      } else if (lower.includes('hello')) {
        this.sendChat(`Hi ${username}!`);
      } else if (lower.includes('how are you')) {
        this.sendChat(`I'm just a bot, but thanks for asking!`);
      }
      this.addLog(`${username}: ${message}`, 'chat');
    });

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      this.addLog(`[Whisper] <${username}>: ${message}`, 'chat');
      this.sendChat(`/tell ${username} Hello ${username}, I got your message!`);
    });

    bot.once('spawn', () => {
      this.state.status = 'online';
      this.addLog(`Connected as ${bot.username}`, 'success');
      bot.pathfinder.setMovements(new Movements(bot));
      this._reconnectDelayMs = null; // successful connection: reset backoff
      this.startViewer();
      this.startWatchdog();
      this.movementTimers.push(setTimeout(() => this.attemptMovement(), 1000));
    });

    bot.on('goal_reached', goal => {
      const wasRoute = this.navigationMode === 'route';
      this._consecutiveFailures = 0;
      this.addLog(wasRoute ? `Reached route checkpoint near ${goal.x}, ${goal.y}, ${goal.z}` : 'AFK movement target reached', 'success');
      this.navigationMode = 'idle';
      if (this.shouldRun) {
        this.movementTimers.push(setTimeout(() => wasRoute ? this.randomMovement() : this.attemptMovement(), wasRoute ? 1000 : 2000));
      }
    });

    bot.on('path_reset', reason => {
      if (reason === 'goal_updated') return;
      this.addLog(`Pathfinding stopped: ${reason}`, 'warning');
      if (this.navigationMode === 'route') return;
      this.navigationMode = 'idle';
      this._consecutiveFailures = (this._consecutiveFailures || 0) + 1;
      // FIX (was the root cause of "bot never moves"): the old code only
      // retried when reason === 'stuck'. Pathfinder emits many other reset
      // reasons (dig_error, no_scaffolding_blocks, block_interact_timeout,
      // chunk_not_loaded, etc.) and every one of those used to permanently
      // freeze AFK movement with no retry. Now we retry on any reason, and
      // escalate to simple walking after repeated failures (see attemptMovement).
      if (this.shouldRun) {
        this.movementTimers.push(setTimeout(() => this.attemptMovement(), MOVEMENT_STUCK_RETRY_MS));
      }
    });

    bot.on('end', () => {
      this.clearWatchdog();
      this.stopViewer();
      this.movementTimers.forEach(timer => clearTimeout(timer));
      this.movementTimers = [];
      this.bot = null;
      this.state.status = 'offline';
      this.addLog('Bot disconnected', 'warning');
      if (this.shouldRun) {
        // FIX: a fixed 5s reconnect delay creates a kick/reconnect death
        // loop against servers that rate-limit logins ("logging in too
        // fast"). Back off exponentially on repeated failures, with jitter,
        // and reset to the base delay as soon as a connection succeeds.
        const base = this._reconnectDelayMs || RECONNECT_BASE_MS;
        const delay = Math.min(base, RECONNECT_MAX_MS);
        const jitter = Math.floor(delay * 0.2 * Math.random());
        this._reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
        this.addLog(`Reconnecting in ${Math.round((delay + jitter) / 1000)} seconds...`, 'system');
        this.reconnectTimer = setTimeout(() => this.createBot(), delay + jitter);
      }
      if (this._pendingEndResolve) {
        const resolve = this._pendingEndResolve;
        this._pendingEndResolve = null;
        resolve();
      }
    });

    bot.on('error', err => this.addLog(`Bot error: ${err.message}`, 'error'));
    bot.on('kicked', reason => {
      this.addLog(`Bot was kicked: ${JSON.stringify(reason)}`, 'error');
      const text = JSON.stringify(reason).toLowerCase();

      if (text.includes('too many players') && text.includes('ip address')) {
        if (process.env.MC_PROXY) {
          this.proxyFallbackActive = true;
          this.addLog('IP connection limit detected. The next reconnect will use the configured SOCKS5 proxy.', 'system');
        } else {
          this.addLog('IP connection limit detected, but MC_PROXY is not configured. The next reconnect will use the normal connection.', 'warning');
        }
      }

      // FIX: retrying forever with a password the server has already
      // rejected multiple times doesn't just fail again — it's the exact
      // behavior that gets an account (or this app's whole outbound IP)
      // temporarily or permanently banned. Stop auto-reconnecting and
      // surface a clear, actionable message instead of silently looping.
      if (text.includes('wrong password') || text.includes('incorrect password') || text.includes('invalid password')) {
        this.shouldRun = false;
        this.addLog('Login stopped: the server rejected the configured password too many times. Update the password in Server settings, then Start the bot again.', 'error');
        return;
      }

      if (text.includes('too fast') || text.includes('rate limit') || text.includes('throttle')) {
        this._reconnectDelayMs = Math.max(this._reconnectDelayMs || 0, RATE_LIMIT_COOLDOWN_MS);
      }
    });
  }

  _waitForEnd() {
    if (!this.bot) return Promise.resolve();
    return new Promise(resolve => { this._pendingEndResolve = resolve; });
  }

  stop() {
    this.shouldRun = false;
    this.navigationMode = 'idle';
    clearTimeout(this.reconnectTimer);
    this.clearWatchdog();
    this.stopMovement();
    if (this.bot) this.bot.quit('Stopped from control panel');
    this.stopViewer();
    this.bot = null;
    this.state.status = 'offline';
    this.addLog('Bot stopped from control panel', 'warning');
  }

  start() {
    if (this.bot) return;
    this._reconnectDelayMs = null;
    this.proxyFallbackActive = false;
    this.shouldRun = true;
    this.createBot();
  }

  // FIX: the old reconnectBot() set shouldRun=false then flipped it back to
  // true after a fixed 250ms guess, racing against the previous bot's async
  // 'end' event. Now we actually await 'end' (bounded by a 3s safety cap)
  // before spinning up the replacement bot.
  async reconnect() {
    this.shouldRun = false;
    this.navigationMode = 'idle';
    clearTimeout(this.reconnectTimer);
    this.clearWatchdog();
    this.stopMovement();
    const pendingEnd = this._waitForEnd();
    if (this.bot) this.bot.quit('Reconnecting from control panel');
    this.stopViewer();
    await Promise.race([pendingEnd, new Promise(resolve => setTimeout(resolve, 3000))]);
    this.bot = null;
    this.state.status = 'offline';
    this.shouldRun = true;
    this.createBot();
  }

  updateConfig({ host, port, username, version, password }) {
    const nextPort = Number(port);
    if (
      !host ||
      !Number.isInteger(nextPort) ||
      nextPort < 1 ||
      nextPort > 65535 ||
      !username ||
      !version ||
      (version !== 'auto' && !supportedJavaVersions.includes(version))
    ) {
      return { ok: false, error: 'Host, port, username, and version are required' };
    }
    this.state.host = host.trim();
    this.state.port = nextPort;
    this.state.username = username.trim();
    this.state.version = version.trim();
    if (typeof password === 'string' && password.length > 0) this.loginPassword = password;
    this.persist();
    this.addLog(`Configuration updated for ${this.state.host}:${this.state.port}`, 'system');
    return { ok: true };
  }

  dispose() {
    this.stop();
    this.stopViewer();
    this.clearWatchdog();
  }
}

module.exports = { BotSession, supportedJavaVersions };