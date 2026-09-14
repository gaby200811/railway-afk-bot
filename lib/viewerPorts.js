const RANGE_START = 4100;
const RANGE_END = 4300;

const used = new Set();

function allocatePort() {
  for (let port = RANGE_START; port <= RANGE_END; port += 1) {
    if (!used.has(port)) {
      used.add(port);
      return port;
    }
  }
  throw new Error('No free viewer ports available');
}

function releasePort(port) {
  used.delete(port);
}

module.exports = { allocatePort, releasePort };
