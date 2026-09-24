const MIN_GAP_MS = 4000;

const lastAttempt = new Map();
const queues = new Map();

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Serializes connection attempts to the same host:port across every bot
// session in this process, enforcing a minimum gap between them. Different
// hosts are unaffected — this only throttles bots hitting the SAME server.
async function waitForSlot(hostKey) {
  const previous = queues.get(hostKey) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  queues.set(hostKey, previous.then(() => current));

  await previous;
  const last = lastAttempt.get(hostKey) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < MIN_GAP_MS) await wait(MIN_GAP_MS - elapsed);
  lastAttempt.set(hostKey, Date.now());
  release();
}

module.exports = { waitForSlot };
