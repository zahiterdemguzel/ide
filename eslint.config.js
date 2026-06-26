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
  { ignores: ['node_modules/**', 'dist/**'] },

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
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
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
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
