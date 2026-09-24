const socket = io();
const consoleElement = document.querySelector('#console');
const eventCount = document.querySelector('#event-count');
let eventTotal = 0;
let versionOptions = [];

function renderVersionOptions(versions) {
  if (!versions?.length || versions.join(',') === versionOptions.join(',')) return;
  versionOptions = versions;
  const select = document.querySelector('#config-version');
  select.innerHTML = '<option value="auto">Auto detect server version</option>';
  versions.slice().reverse().forEach(version => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = `Java ${version}`;
    select.appendChild(option);
  });
}

function updateState(state) {
  const status = document.querySelector('#status');
  status.textContent = state.status[0].toUpperCase() + state.status.slice(1);
  const statusMark = document.querySelector('#status-mark');
  statusMark.style.background = state.status === 'online' ? 'var(--ok)' : state.status === 'connecting' ? 'var(--warn)' : 'var(--text-faint)';
  document.querySelector('#endpoint').textContent = `${state.host}:${state.port} · Java ${state.version}`;
  document.querySelector('#username').textContent = state.username;
  document.querySelector('#last-event').textContent = state.lastEvent;
  document.querySelector('#navigation-mode').textContent = state.navigation[0].toUpperCase() + state.navigation.slice(1);
  document.querySelector('#health').textContent = state.health ?? '--';
  document.querySelector('#food').textContent = state.food ?? '--';
  document.querySelector('#position').textContent = state.position ?? '--';
  document.querySelector('#ping').textContent = state.ping ?? '--';
  const viewerButton = document.querySelector('#toggle-viewer');
  viewerButton.disabled = !state.viewerAvailable;
  if (!state.viewerAvailable) closeViewer();
  setIfClean('#config-host', state.host);
  setIfClean('#config-port', state.port);
  setIfClean('#config-username', state.username);
  renderVersionOptions(state.supportedVersions);
  setIfClean('#config-version', state.version);
}

const dirtyFields = new Set();
const configFieldIds = ['#config-host', '#config-port', '#config-username', '#config-version'];

configFieldIds.forEach(selector => {
  const el = document.querySelector(selector);
  const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(eventName, () => dirtyFields.add(selector));
});

function setIfClean(selector, value) {
  if (dirtyFields.has(selector)) return;
  document.querySelector(selector).value = value;
}

function addLog(entry) {
  const line = document.createElement('div');
  const time = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.className = `log-line ${entry.level}`;
  line.innerHTML = `<span class="log-time">${time}</span><span>${entry.message.replaceAll('<', '&lt;')}</span>`;
  consoleElement.appendChild(line);
  consoleElement.scrollTop = consoleElement.scrollHeight;
  eventTotal += 1;
  eventCount.textContent = `${eventTotal} event${eventTotal === 1 ? '' : 's'}`;
}

function updateRoute(route) {
  document.querySelector('#route-status').textContent = route.recording ? 'Recording active' : 'Not recording';
  document.querySelector('#route-indicator').classList.toggle('active', route.recording);
  document.querySelector('#route-count').textContent = `${route.points.length} point${route.points.length === 1 ? '' : 's'}`;
  const list = document.querySelector('#route-list');
  list.innerHTML = route.points.length ? route.points.map((point, index) => `<div class="route-point"><div><strong>${point.label.replaceAll('<', '&lt;')}</strong><span>${point.x}, ${point.y}, ${point.z}</span></div><button class="point-go" data-goto="${index}">Go</button></div>`).join('') : '<span class="empty-route">No checkpoints saved</span>';
  list.querySelectorAll('[data-goto]').forEach(button => {
    button.addEventListener('click', () => fetch('/api/route/goto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: button.dataset.goto }) }));
  });
}

socket.on('state', updateState);
socket.on('log', addLog);
socket.on('history', entries => entries.forEach(addLog));
socket.on('versions', renderVersionOptions);
socket.on('route', updateRoute);

socket.on('connect_error', err => {
  if (err.message === 'unauthorized') window.location.href = '/login';
});

function withLoading(button, fn) {
  return async event => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-loading');
    try {
      await fn(event);
    } finally {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  };
}

document.querySelector('#command-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#command');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
});

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', withLoading(button, async () => {
    if (button.dataset.action === 'stop') {
      const confirmed = await window.confirmAction('Stop the bot? It will disconnect until you start it again.');
      if (!confirmed) return;
    }
    await fetch(`/api/action/${button.dataset.action}`, { method: 'POST' });
  }));
});

document.querySelector('#config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const formMessage = document.querySelector('#form-message');
  const payload = {
    host: document.querySelector('#config-host').value,
    port: document.querySelector('#config-port').value,
    username: document.querySelector('#config-username').value,
    version: document.querySelector('#config-version').value,
    password: document.querySelector('#config-password').value
  };
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  formMessage.textContent = response.ok ? 'Saved. Reconnect to apply.' : 'Check the connection values.';
  formMessage.className = `form-message ${response.ok ? 'success' : 'error'}`;
  if (response.ok) {
    document.querySelector('#config-password').value = '';
    dirtyFields.clear();
  }
});

document.querySelectorAll('[data-route]').forEach(button => {
  button.addEventListener('click', withLoading(button, async () => {
    const action = button.dataset.route;
    if (action === 'clear') {
      const confirmed = await window.confirmAction('Clear all saved checkpoints? This cannot be undone.');
      if (!confirmed) return;
    }
    const label = document.querySelector('#checkpoint-label').value.trim();
    const response = await fetch(`/api/route/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    if (response.ok && action === 'checkpoint') document.querySelector('#checkpoint-label').value = '';
  }));
});

function closeViewer() {
  const wrap = document.querySelector('#viewer-frame-wrap');
  const frame = document.querySelector('#viewer-frame');
  const button = document.querySelector('#toggle-viewer');
  wrap.hidden = true;
  frame.src = 'about:blank';
  if (button) button.innerHTML = 'Open 3D view <span>▶</span>';
}

document.querySelector('#toggle-viewer').addEventListener('click', () => {
  const wrap = document.querySelector('#viewer-frame-wrap');
  const frame = document.querySelector('#viewer-frame');
  const button = document.querySelector('#toggle-viewer');
  const opening = wrap.hidden;
  if (opening) {
    frame.src = '/viewer/';
    wrap.hidden = false;
    button.innerHTML = 'Close 3D view <span>▼</span>';
  } else {
    closeViewer();
  }
});

setInterval(() => { document.querySelector('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);