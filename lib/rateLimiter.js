const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function isRateLimited(key) {
  const entry = attempts.get(key) || [];
  const recent = entry.filter(ts => Date.now() - ts < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

function recordAttempt(key) {
  const entry = attempts.get(key) || [];
  entry.push(Date.now());
  attempts.set(key, entry);
}

function clearAttempts(key) {
  attempts.delete(key);
}

module.exports = { isRateLimited, recordAttempt, clearAttempts };
