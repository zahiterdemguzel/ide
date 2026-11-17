const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const source = path.join(root, 'src', 'native', 'force-click.mm');
const output = path.join(root, 'vendor', 'force-click.node');
if (fs.existsSync(output) && [source, __filename].every((file) => (
  fs.statSync(file).mtimeMs <= fs.statSync(output).mtimeMs
))) process.exit(0);

fs.mkdirSync(path.dirname(output), { recursive: true });
const temp = `${output}.${process.pid}.tmp`;
try {
  execFileSync('xcrun', [
    'clang++', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
    '-bundle', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-framework', 'AppKit',
    '-I', require('node-api-headers').include_dir, source, '-o', temp,
  ], { stdio: 'inherit' });
  fs.renameSync(temp, output);
} finally {
  fs.rmSync(temp, { force: true });
}
