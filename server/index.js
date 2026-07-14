// Standalone entry point for deploying the relay (e.g. Render.com):
//   Root Directory: server / Build: npm install / Start: node index.js
// Listens on the platform-injected PORT. This process only bridges sockets —
// all IDE logic and auth verification stays inside the desktop app.
const { startRelay } = require('./relay');

startRelay({ port: Number(process.env.PORT) || 8080 }).then(({ port }) => {
  console.log(`ide-relay listening on :${port}`);
});
