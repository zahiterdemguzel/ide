const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSqliteBuffer, SQLITE_HEADER, DB_EXT, engineForFile,
  quoteIdent, quoteLiteral, rowIdentity, whereClause,
  buildSelect, buildCount, buildUpdate, buildInsert, buildDelete,
  affinity, coerceInput, isReadOnlySql,
} = require('../src/main/db-sql');

test('isSqliteBuffer: matches the 16-byte magic header, rejects others', () => {
  const ok = Buffer.from(SQLITE_HEADER + 'rest of file', 'binary');
  assert.equal(isSqliteBuffer(ok), true);
  assert.equal(isSqliteBuffer(Buffer.from('not a database at all')), false);
  assert.equal(isSqliteBuffer(Buffer.from('SQLite')), false); // too short
  assert.equal(isSqliteBuffer(Buffer.alloc(0)), false);
  assert.equal(isSqliteBuffer(null), false);
});

test('engineForFile: maps extensions to engines, editable only for SQLite family', () => {
  assert.equal(engineForFile('data.sqlite').id, 'sqlite');
  assert.equal(engineForFile('data.sqlite').editable, true);
  assert.equal(engineForFile('tiles.mbtiles').editable, true);
  assert.equal(engineForFile('world.gpkg').editable, true);
  assert.equal(engineForFile('legacy.mdb').id, 'access');
  assert.equal(engineForFile('legacy.mdb').editable, false);
  assert.equal(engineForFile('analytics.duckdb').editable, false);
  assert.equal(engineForFile('table.dbf').id, 'dbase');
  assert.equal(engineForFile('notes.txt'), null);
});

test('DB_EXT covers the common SQLite spellings and the recognized engines', () => {
  for (const e of ['sqlite', 'sqlite3', 'db', 'db3', 'duckdb', 'mdb', 'accdb', 'gpkg', 'mbtiles']) {
    assert.ok(DB_EXT.has(e), `DB_EXT missing ${e}`);
  }
  assert.ok(!DB_EXT.has('sql')); // .sql is DDL text — stays in the code editor
});

test('quoteIdent / quoteLiteral escape embedded quotes', () => {
  assert.equal(quoteIdent('users'), '"users"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
  assert.equal(quoteLiteral("O'Brien"), "'O''Brien'");
});

test('rowIdentity: rowid wins, then pk, then all columns', () => {
  const cols = [{ name: 'id', pk: true }, { name: 'name', pk: false }];
  assert.deepEqual(rowIdentity(cols, true), { kind: 'rowid', cols: ['rowid'] });
  assert.deepEqual(rowIdentity(cols, false), { kind: 'pk', cols: ['id'] });
  assert.deepEqual(rowIdentity([{ name: 'a', pk: false }, { name: 'b', pk: false }], false),
    { kind: 'all', cols: ['a', 'b'] });
});

test('whereClause: = for rowid/pk, NULL-safe IS for all-column identity', () => {
  assert.equal(whereClause(['rowid'], 'rowid'), '"rowid" = ?');
  assert.equal(whereClause(['a', 'b'], 'pk'), '"a" = ? AND "b" = ?');
  assert.equal(whereClause(['a', 'b'], 'all'), '"a" IS ? AND "b" IS ?');
});

test('statement builders produce parameterized SQL', () => {
  assert.equal(buildSelect('t', { limit: 50, offset: 100, withRowid: true }),
    'SELECT rowid AS _rowid_, * FROM "t" LIMIT 50 OFFSET 100');
  assert.equal(buildSelect('t', { limit: 50 }), 'SELECT * FROM "t" LIMIT 50');
  assert.equal(buildCount('t'), 'SELECT COUNT(*) AS n FROM "t"');
  assert.equal(buildUpdate('t', 'name', ['rowid'], 'rowid'),
    'UPDATE "t" SET "name" = ? WHERE "rowid" = ?');
  assert.equal(buildInsert('t', ['a', 'b']), 'INSERT INTO "t" ("a", "b") VALUES (?, ?)');
  assert.equal(buildDelete('t', ['id'], 'pk'), 'DELETE FROM "t" WHERE "id" = ?');
});

test('buildSelect: a non-integer limit/offset collapses to 0 (no injection)', () => {
  assert.equal(buildSelect('t', { limit: '50; DROP TABLE t', offset: '5x' }),
    'SELECT * FROM "t" LIMIT 0 OFFSET 0');
});

test('affinity: follows SQLite type-affinity rules', () => {
  assert.equal(affinity('INTEGER'), 'INTEGER');
  assert.equal(affinity('BIGINT'), 'INTEGER');
  assert.equal(affinity('VARCHAR(80)'), 'TEXT');
  assert.equal(affinity('TEXT'), 'TEXT');
  assert.equal(affinity('REAL'), 'REAL');
  assert.equal(affinity('DOUBLE'), 'REAL');
  assert.equal(affinity(''), 'BLOB');
  assert.equal(affinity('DECIMAL(10,2)'), 'NUMERIC');
});

test('coerceInput: empty -> NULL, numeric columns parse numbers, text stays text', () => {
  assert.equal(coerceInput('', 'TEXT'), null);
  assert.equal(coerceInput(null, 'INTEGER'), null);
  assert.equal(coerceInput('42', 'INTEGER'), 42);
  assert.equal(coerceInput('3.14', 'REAL'), 3.14);
  assert.equal(coerceInput('hello', 'INTEGER'), 'hello'); // non-numeric stays a string
  assert.equal(coerceInput('hello', 'TEXT'), 'hello');
  assert.equal(coerceInput('007', 'TEXT'), '007'); // text column keeps the string
});

test('isReadOnlySql: SELECT/PRAGMA read; INSERT/UPDATE/DDL write', () => {
  assert.equal(isReadOnlySql('SELECT * FROM t'), true);
  assert.equal(isReadOnlySql('  pragma table_info(t)'), true);
  assert.equal(isReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'), true);
  assert.equal(isReadOnlySql('-- a comment\nSELECT 1'), true);
  assert.equal(isReadOnlySql('UPDATE t SET a = 1'), false);
  assert.equal(isReadOnlySql('INSERT INTO t VALUES (1)'), false);
  assert.equal(isReadOnlySql('DROP TABLE t'), false);
  assert.equal(isReadOnlySql('WITH x AS (SELECT 1) DELETE FROM t'), false);
});
