const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { dwgToDxf, dxfToDwg } = require('../src/main/cad-dwg-convert');

// Fixture generated independently with GNU dwgadd:
// line (0 0 0) (20 10 0)
// circle (5 0 0) 2
test('DWG conversion preserves the source line and saves a changed circle radius', async (t) => {
  if (spawnSync('dwgread', ['--version']).error?.code === 'ENOENT') {
    return t.skip('GNU LibreDWG dwgread required for independent DWG validation');
  }
  const source = await fs.readFile(path.join(__dirname, '../resources/test/cad-line-circle.dwg'));
  const dxf = (await dwgToDxf(source)).toString('utf8').replace(/\r\n/g, '\n');
  const radius = /(\nAcDbCircle\n[\s\S]*?\n\s*40\n)2(?:\.0+)?\n/;
  assert.match(dxf, radius);
  const result = await dxfToDwg(Buffer.from(dxf.replace(radius, (_match, prefix) => prefix + '3.5\n')));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-cad-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'result.dwg');
  await fs.writeFile(file, result);
  const check = spawnSync('dwgread', ['-O', 'JSON', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const entities = JSON.parse(check.stdout).OBJECTS;
  const line = entities.find(e => e.entity === 'LINE');
  const circle = entities.find(e => e.entity === 'CIRCLE');
  assert.deepEqual(line.start, [0, 0, 0]);
  assert.deepEqual(line.end, [20, 10, 0]);
  assert.deepEqual(circle.center, [5, 0, 0]);
  assert.equal(circle.radius, 3.5);
});
