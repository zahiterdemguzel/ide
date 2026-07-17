// ESLint flat config. The three layers run in different environments, so each
// gets its own globals/module system:
//   main/ + preload/  -> CommonJS, Node globals (require, process, __dirname)
//   renderer/         -> ES modules, browser globals (window, document) + the
//                        hljs CDN global pulled in by index.html
//   i18n/             -> ES modules, browser globals (loaded via <script type=module>)
//   test/             -> Node; *.mjs is ESM, *.js is CommonJS
// The rules are intentionally light: catch undefined vars / typos / unused
// bindings (the things that otherwise only fail at runtime in the GUI), not style.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // .test-workspace is a throwaway sandbox the "Start IDE" launch config opens;
  // it's not part of this codebase, so don't lint scratch files in it.
  { ignores: ['node_modules/**', 'dist/**', '.test-workspace/**'] },

  js.configs.recommended,
  {
    rules: {
      // The codebase uses _-prefixed throwaways (e.g. ipcMain handler `_e`) and
      // empty catch blocks for best-effort IO — allow both.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // server/ is the Electron-free remote-access backend — Node CommonJS like main/.
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'server/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 'latest', globals: { ...globals.browser, hljs: 'readonly' } },
  },
  {
    files: ['src/i18n/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 'latest', globals: { ...globals.browser } },
  },

  {
    files: ['test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },

  {
    // build/ holds electron-builder's packaging hooks — it loads them in Node.
    files: ['eslint.config.js', 'scripts/**/*.js', 'build/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // scripts/*.mjs import the renderer's ESM modules directly (e.g. the mobile
    // asset generator reads shared/file-icons.js), so they're ESM, not CommonJS.
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
