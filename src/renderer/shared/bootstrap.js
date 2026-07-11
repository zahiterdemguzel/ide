// Surface any uncaught renderer error in the `npm start` terminal (main.js
// forwards renderer console output there). Imported first from index.js so the
// handlers are installed before the rest of the app wires itself up.
// Prefer the Error's stack (points at the real throw site); fall back to the
// event's own location/message when no Error object is attached.
window.addEventListener('error', (e) => console.error('Renderer error:', (e.error && e.error.stack) || `${e.message} (${e.filename || ''}:${e.lineno}:${e.colno})`));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled promise:', (e.reason && e.reason.stack) || (e.reason && e.reason.message) || e.reason));
