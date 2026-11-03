// The Run panel's terminal helpers (mobile/src/lib/terminals.js): phone-owned shell
// bookkeeping and how a listed terminal is restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markPhoneOwned, isPhoneOwned, rememberGrid, gridFor, forgetTerminal, restartPlan,
} from '../mobile/src/lib/terminals.js';

const CONFIGS = { launch: [{ name: 'dev' }], tasks: [{ name: 'build' }] };

test('a phone-owned shell remembers the grid it was sized to', () => {
  assert.equal(isPhoneOwned('t1'), false);
  rememberGrid('t1', 40, 20); // not owned yet: ignored
  assert.equal(gridFor('t1'), null);
  markPhoneOwned('t1');
  assert.equal(isPhoneOwned('t1'), true);
  assert.equal(gridFor('t1'), null);
  rememberGrid('t1', 0, 20); // a degenerate grid is ignored
  assert.equal(gridFor('t1'), null);
  rememberGrid('t1', 42, 30);
  assert.deepEqual(gridFor('t1'), { cols: 42, rows: 30 });
  markPhoneOwned('t1'); // re-marking keeps the grid
  assert.deepEqual(gridFor('t1'), { cols: 42, rows: 30 });
  forgetTerminal('t1');
  assert.equal(isPhoneOwned('t1'), false);
});

test('a config terminal reruns through run-config-start, launch before task', () => {
  assert.deepEqual(restartPlan({ id: 'a', name: 'dev', kind: 'config' }, CONFIGS), {
    via: 'run-config-start', args: { kind: 'launch', name: 'dev' },
  });
  assert.deepEqual(restartPlan({ id: 'b', name: 'build', kind: 'config' }, CONFIGS), {
    via: 'run-config-start', args: { kind: 'task', name: 'build' },
  });
  assert.equal(restartPlan({ id: 'c', name: 'gone', kind: 'config' }, CONFIGS), null);
});

test('a shell respawns in place, at the phone grid when it has one', () => {
  assert.deepEqual(restartPlan({ id: 's', name: 'zsh', kind: 'shell' }, CONFIGS), {
    via: 'term-restart', args: { id: 's' },
  });
  assert.deepEqual(restartPlan({ id: 's', name: 'zsh', kind: 'shell' }, CONFIGS, { cols: 40, rows: 22 }), {
    via: 'term-restart', args: { id: 's', cols: 40, rows: 22 },
  });
});

test('terminals whose command only the desktop knows are not restartable', () => {
  assert.equal(restartPlan({ id: 'r', name: 'main.py', kind: 'run' }, CONFIGS), null);
  assert.equal(restartPlan({ id: 'l', name: 'Claude login', kind: 'login' }, CONFIGS), null);
});
