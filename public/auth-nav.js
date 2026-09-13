(async function initAuthNav() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const { user } = await res.json();
    const chip = document.querySelector('#user-chip');
    if (chip) chip.textContent = `${user.username} · ${user.role}`;
    const adminLink = document.querySelector('#admin-link');
    if (adminLink) adminLink.hidden = user.role !== 'admin';
  } catch {
    window.location.href = '/login';
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const logoutButton = document.querySelector('#logout-button');
  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }
});

// Lightweight, styled confirm dialog used in place of window.confirm() for
// destructive actions. Resolves true/false.
window.confirmAction = function confirmAction(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${message.replaceAll('<', '&lt;')}</p>
        <div class="confirm-actions">
          <button class="button" data-choice="cancel">Cancel</button>
          <button class="button button-danger" data-choice="confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      const choice = event.target?.dataset?.choice;
      if (choice) {
        overlay.remove();
        resolve(choice === 'confirm');
      } else if (event.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
  });
};
