// Surface any uncaught renderer error in the `npm start` terminal (main.js
// forwards renderer console output there). Imported first from index.js so the
// handlers are installed before the rest of the app wires itself up.
window.addEventListener('error', (e) => console.error('Renderer error:', e.message, (e.filename || '') + ':' + e.lineno + ':' + e.colno));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled promise:', (e.reason && e.reason.message) || e.reason));
