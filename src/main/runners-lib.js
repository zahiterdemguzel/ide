// Pure "run a single source file" translation: map a file extension to a
// language, and turn a resolved interpreter binary + file path into a shell
// command line. No electron, no file IO, no PATH probing (that lives in
// runners.js) — so this stays unit-testable, same split as run-configs-lib.js.
const { quoteArg } = require('./run-configs-lib');

// Languages the app can run from a single file. `bins` is the ordered list of
// candidate interpreter names to look for on PATH (first found wins); `build`
// turns the resolved binary + file into command-line parts. Add a language by
// adding an entry here (and, for editor highlighting, an EXT_LANG mapping).
const LANGUAGES = [
  { id: 'python', name: 'Python', exts: ['py', 'pyw'], bins: ['python3', 'python', 'py'], build: (bin, file) => [bin, file] },
  { id: 'node', name: 'Node.js', exts: ['js', 'mjs', 'cjs'], bins: ['node'], build: (bin, file) => [bin, file] },
  { id: 'typescript', name: 'TypeScript', exts: ['ts', 'mts', 'cts'], bins: ['tsx', 'ts-node', 'bun', 'deno'], build: (bin, file) => (bin === 'deno' ? [bin, 'run', file] : [bin, file]) },
  { id: 'ruby', name: 'Ruby', exts: ['rb'], bins: ['ruby'], build: (bin, file) => [bin, file] },
  { id: 'go', name: 'Go', exts: ['go'], bins: ['go'], build: (bin, file) => [bin, 'run', file] },
  { id: 'php', name: 'PHP', exts: ['php'], bins: ['php'], build: (bin, file) => [bin, file] },
  { id: 'perl', name: 'Perl', exts: ['pl'], bins: ['perl'], build: (bin, file) => [bin, file] },
  { id: 'lua', name: 'Lua', exts: ['lua'], bins: ['lua'], build: (bin, file) => [bin, file] },
  { id: 'shell', name: 'Shell', exts: ['sh', 'bash'], bins: ['bash', 'sh'], build: (bin, file) => [bin, file] },
  { id: 'powershell', name: 'PowerShell', exts: ['ps1'], bins: ['pwsh', 'powershell'], build: (bin, file) => [bin, '-File', file] },
];

function extOf(file) {
  const m = /\.([^.\\/]+)$/.exec(String(file || ''));
  return m ? m[1].toLowerCase() : '';
}

function langForFile(file) {
  const ext = extOf(file);
  return LANGUAGES.find((l) => l.exts.includes(ext)) || null;
}

function langById(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

// Build the command line that runs `file` with interpreter `bin` under `lang`.
// `args` is an optional, already-formed extra-argument string appended verbatim.
function buildRunCommand(lang, bin, file, args = '') {
  const parts = lang.build(bin, file).map(quoteArg);
  const tail = args && String(args).trim() ? ' ' + String(args).trim() : '';
  return parts.join(' ') + tail;
}

module.exports = { LANGUAGES, extOf, langForFile, langById, buildRunCommand };
