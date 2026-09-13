async function loadUsers() {
  const response = await fetch('/api/admin/users');
  if (!response.ok) return;
  const { users } = await response.json();
  renderUsers(users);
}

function renderUsers(users) {
  document.querySelector('#user-count').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  const list = document.querySelector('#user-list');
  if (!users.length) {
    list.innerHTML = '<span class="empty-route">No users yet. Create the first one →</span>';
    return;
  }
  list.innerHTML = users.map(user => `
    <div class="route-point user-row">
      <div>
        <strong>${user.username.replaceAll('<', '&lt;')}</strong>
        <span>${user.role} · added ${new Date(user.createdAt).toLocaleDateString()}</span>
      </div>
      <button class="point-go delete-user" data-username="${user.username}">Remove</button>
    </div>
  `).join('');

  list.querySelectorAll('.delete-user').forEach(button => {
    button.addEventListener('click', async () => {
      const username = button.dataset.username;
      const confirmed = await window.confirmAction(`Remove "${username}"? Their bot will be stopped and they'll lose access immediately.`);
      if (!confirmed) return;
      await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      loadUsers();
    });
  });
}

document.querySelector('#create-user-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#create-message');
  const button = event.target.querySelector('button[type="submit"]');
  const payload = {
    username: document.querySelector('#new-username').value.trim(),
    password: document.querySelector('#new-password').value
  };

  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      message.textContent = data.error || 'Could not create user.';
      message.className = 'form-message error';
      return;
    }
    message.textContent = `Created "${data.user.username}".`;
    message.className = 'form-message success';
    document.querySelector('#new-username').value = '';
    document.querySelector('#new-password').value = '';
    loadUsers();
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
});

setInterval(() => { document.querySelector('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);

const snowfield = document.querySelector('#snowfield');
for (let index = 0; index < 34; index += 1) {
  const flake = document.createElement('span');
  flake.className = 'flake';
  flake.style.left = `${Math.random() * 100}%`;
  flake.style.animationDelay = `${Math.random() * -18}s`;
  flake.style.animationDuration = `${12 + Math.random() * 13}s`;
  flake.style.opacity = `${0.12 + Math.random() * 0.3}`;
  flake.style.setProperty('--drift', `${-30 + Math.random() * 60}px`);
  snowfield.appendChild(flake);
}

loadUsers();
