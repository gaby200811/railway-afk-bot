document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#login-message');
  const button = event.target.querySelector('button[type="submit"]');
  const payload = {
    username: document.querySelector('#login-username').value.trim(),
    password: document.querySelector('#login-password').value
  };

  button.disabled = true;
  button.classList.add('is-loading');
  message.textContent = '';
  message.className = 'form-message';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      message.textContent = data.error || 'Sign in failed.';
      message.className = 'form-message error';
      return;
    }
    window.location.href = '/';
  } catch {
    message.textContent = 'Could not reach the server. Try again.';
    message.className = 'form-message error';
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
});
