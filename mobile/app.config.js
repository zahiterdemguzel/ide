// app.json holds the static config; this wrapper only picks the launcher icon,
// the desktop app's mark, in the same dev/prod split the desktop window uses
// (src/main/window.js). Both files are generated from assets/icon.png by
// scripts/gen-icons.js and gitignored, so a build must run that script first —
// scripts/build-android.mjs and mobile's `prestart` both do.
// No adaptiveIcon: the artwork is full-bleed and Android's adaptive mask would
// crop a fifth of it away, so the legacy `icon` path is the faithful one.
const { expo } = require('./app.json');

const isDev = process.env.APP_VARIANT !== 'production';

module.exports = {
  expo: {
    ...expo,
    icon: isDev ? './assets/icon-dev.png' : './assets/icon.png',
  },
};
