// Standalone entry point for deploying the relay (e.g. Render.com):
//   Root Directory: server / Build: npm install / Start: node index.js
// Listens on the platform-injected PORT. This process only bridges sockets —
// all IDE logic and auth verification stays inside the desktop app.
const { startRelay } = require('./relay');
const { resolveKeepAlive, startSelfPing } = require('./keepalive');
const { debugFor, debugEnabled, DEBUG_ENV } = require('./debug');

const debug = debugFor('relay');

startRelay({ port: Number(process.env.PORT) || 8080 }).then(({ port }) => {
  console.log(`ide-relay listening on :${port}`);
  console.log(debugEnabled
    ? `ide-relay debug tracing on (${DEBUG_ENV}=${process.env[DEBUG_ENV]})`
    : `ide-relay debug tracing off (set ${DEBUG_ENV}=1 to trace every operation)`);
  debug('started', { pid: process.pid, node: process.version });

  const keepAlive = resolveKeepAlive(process.env);
  if (keepAlive) {
    startSelfPing({ ...keepAlive, log: (msg) => console.log(msg) });
    console.log(`ide-relay self-ping every ${keepAlive.intervalMs}ms -> ${keepAlive.url}`);
  }
});
