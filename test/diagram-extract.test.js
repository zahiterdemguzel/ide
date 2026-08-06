const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  QUERIES, langForPath, flattenCaptures, fromCaptures, extractGdscript,
  packageOf, cleanTypeName, signatureOf, splitQualified, visibilityOf,
} = require('../src/main/diagram-extract');

// The tree-sitter half of the extractor is exercised against the real grammars:
// a query that silently stops matching after a grammar bump is exactly the bug
// that hand-written capture fixtures would hide. Everything the six languages
// have in common is asserted through one table so adding a language means adding
// a row, not a test.

let TS = null;
const loaded = new Map();

async function parse(lang, text) {
  if (!TS) {
    TS = require('web-tree-sitter');
    await TS.Parser.init();
  }
  if (!loaded.has(lang)) {
    const dir = path.dirname(require.resolve('@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm'));
    const language = await TS.Language.load(path.join(dir, `tree-sitter-${lang}.wasm`));
    const parser = new TS.Parser();
    parser.setLanguage(language);
    loaded.set(lang, { parser, query: new TS.Query(language, QUERIES[lang]) });
  }
  const { parser, query } = loaded.get(lang);
  const tree = parser.parse(text);
  try {
    return fromCaptures(`sample.${lang}`, lang, flattenCaptures(query.matches(tree.rootNode)), text);
  } finally {
    tree.delete();
  }
}

const nameOf = (rec, kind) => rec.symbols.filter((s) => s.kind === kind).map((s) => s.name).sort();
const find = (rec, name) => rec.symbols.find((s) => s.name === name);

// One equivalent program per language: a base type, a derived type that extends
// it, a method on the derived type that calls a free function and instantiates
// the base, and one import.
const SAMPLES = {
  python: {
    text: `import os.path
from .helpers import shout

class Animal:
    legs = 4
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        helper()
        return shout()

def helper():
    pass
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'speak',
    imports: ['os.path', '.helpers'],
  },

  java: {
    text: `package app;
import java.util.List;

interface Greeter { void greet(); }

class Animal {
    int legs = 4;
    void speak() {}
}

class Dog extends Animal implements Greeter {
    public void greet() {
        helper();
        Animal a = new Animal();
    }
    static void helper() {}
}
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'greet',
    imports: ['java.util.List'],
  },

  c_sharp: {
    text: `using System.Collections;

namespace App {
    interface IGreeter { void Greet(); }

    class Animal {
        public int Legs = 4;
        public virtual void Speak() {}
    }

    class Dog : Animal, IGreeter {
        public void Greet() {
            Helper();
            var a = new Animal();
        }
        static void Helper() {}
    }
}
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'Greet',
    imports: ['System.Collections'],
  },

  cpp: {
    text: `#include <vector>
#include "helpers.h"

class Animal {
public:
    int legs;
    void speak();
};

class Dog : public Animal {
public:
    void greet() {
        helper();
    }
};

void helper() {}
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'greet',
    imports: ['vector', 'helpers.h'],
  },

  javascript: {
    text: `import { shout } from './helpers.js';

class Animal {
  legs = 4;
  speak() {}
}

class Dog extends Animal {
  greet() {
    helper();
    const a = new Animal();
    return shout();
  }
}

function helper() {}
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'greet',
    imports: ['./helpers.js'],
  },

  typescript: {
    text: `import { shout } from './helpers';

interface Greeter { greet(): void }

class Animal {
  legs: number = 4;
  speak(): void {}
}

class Dog extends Animal implements Greeter {
  greet(): void {
    helper();
    const a = new Animal();
  }
}

function helper(): void {}
`,
    classes: ['Animal', 'Dog'],
    derived: 'Dog',
    superName: 'Animal',
    method: 'greet',
    imports: ['./helpers'],
  },
};

describe('tree-sitter extraction', () => {
  for (const [lang, spec] of Object.entries(SAMPLES)) {
    describe(lang, () => {
      let rec;
      before(async () => { rec = await parse(lang, spec.text); });

      test('finds every class', () => {
        assert.deepEqual(nameOf(rec, 'class'), spec.classes);
      });

      test('records the supertype on the derived class', () => {
        assert.deepEqual(find(rec, spec.derived).extends, [spec.superName]);
      });

      test('nests methods inside their class', () => {
        const method = rec.symbols.find((s) => s.name === spec.method && s.parent === spec.derived);
        assert.ok(method, `${spec.method} should be a member of ${spec.derived}`);
        assert.ok(method.line > 1, 'method should carry its own line, not the file start');
      });

      test('captures imports', () => {
        assert.deepEqual(rec.imports.map((i) => i.target).sort(), [...spec.imports].sort());
      });

      test('attributes calls to the enclosing definition', () => {
        const call = rec.calls.find((c) => c.name === 'helper' || c.name === 'Helper');
        assert.ok(call, 'the helper() call should be found');
        assert.equal(call.from, `${spec.derived}.${spec.method}`);
      });
    });
  }
});

test('tree-sitter: a bare call and a receiver call are told apart', async () => {
  const rec = await parse('javascript', 'function f() { helper(); obj.trim(); }');
  const plain = rec.calls.find((c) => c.name === 'helper');
  const method = rec.calls.find((c) => c.name === 'trim');
  assert.equal(plain.method, undefined);
  assert.equal(method.method, true);
});

test('tree-sitter: interfaces and implements land on the right symbols', async () => {
  const rec = await parse('typescript', SAMPLES.typescript.text);
  assert.deepEqual(nameOf(rec, 'interface'), ['Greeter']);
  assert.deepEqual(find(rec, 'Dog').implements, ['Greeter']);
});

test('c#: the base list is split into base class and interfaces by convention', async () => {
  const rec = await parse('c_sharp', SAMPLES.c_sharp.text);
  assert.deepEqual(find(rec, 'Dog').extends, ['Animal']);
  assert.deepEqual(find(rec, 'Dog').implements, ['IGreeter']);
});

test('tree-sitter: C++ out-of-line definitions land inside their class', async () => {
  const rec = await parse('cpp', 'class A { void run(); };\nvoid A::run() { helper(); }\n');
  const outOfLine = rec.symbols.filter((s) => s.name === 'run');
  assert.ok(outOfLine.some((s) => s.parent === 'A'), 'A::run should be a member of A');
});

test('tree-sitter: nested classes keep their qualified parent', async () => {
  const rec = await parse('python', 'class Outer:\n    class Inner:\n        def go(self): pass\n');
  assert.equal(find(rec, 'Inner').parent, 'Outer');
  assert.equal(find(rec, 'go').parent, 'Outer.Inner');
});

// --- GDScript --------------------------------------------------------------
// No wasm grammar exists for GDScript, so this scanner is the whole
// implementation for the language and is tested on its own terms.

describe('gdscript', () => {
  const source = `extends Node2D
class_name Player

signal died
const SPEED = 300
@export var health: int = 100
var _secret = 1

const Bullet = preload("res://src/bullet.gd")

func _ready() -> void:
    spawn_bullet()

func spawn_bullet():
    var b = Bullet.new()
    add_child(b)

class Inventory:
    var items = []
    func add(item):
        pass
`;
  const rec = extractGdscript('src/player.gd', source);

  test('the script itself is a class, named by class_name', () => {
    const self = rec.symbols[0];
    assert.equal(self.kind, 'class');
    assert.equal(self.name, 'Player');
    assert.deepEqual(self.extends, ['Node2D']);
  });

  test('falls back to the file stem when class_name is absent', () => {
    const anon = extractGdscript('src/enemy.gd', 'extends Node\n');
    assert.equal(anon.symbols[0].name, 'enemy');
  });

  test('collects funcs, vars, consts and signals as members', () => {
    assert.deepEqual(nameOf(rec, 'method').sort(), ['_ready', 'add', 'spawn_bullet']);
    assert.ok(nameOf(rec, 'field').includes('health'));
    assert.ok(nameOf(rec, 'field').includes('died'), 'signals are members too');
  });

  test('inner classes nest, and their funcs nest inside them', () => {
    assert.equal(find(rec, 'Inventory').parent, 'Player');
    assert.equal(find(rec, 'add').parent, 'Player.Inventory');
  });

  test('leading underscore marks a member private', () => {
    assert.equal(find(rec, '_secret').visibility, 'private');
    assert.equal(find(rec, 'health').visibility, 'public');
  });

  test('preload paths become imports', () => {
    assert.deepEqual(rec.imports.map((i) => i.target), ['res://src/bullet.gd']);
  });

  test('Klass.new() is an instantiation attributed to its func', () => {
    const nw = rec.news.find((n) => n.name === 'Bullet');
    assert.ok(nw);
    assert.equal(nw.from, 'Player.spawn_bullet');
  });

  test('calls are attributed to the enclosing func, keywords are not calls', () => {
    const call = rec.calls.find((c) => c.name === 'spawn_bullet');
    assert.equal(call.from, 'Player._ready');
    assert.equal(rec.calls.some((c) => c.name === 'if' || c.name === 'return'), false);
  });

  test('comments do not produce symbols', () => {
    const commented = extractGdscript('a.gd', 'extends Node\n# func ghost():\nfunc real():\n    pass\n');
    assert.deepEqual(nameOf(commented, 'method'), ['real']);
  });
});

// --- helpers ---------------------------------------------------------------

test('langForPath maps extensions, and ignores what we cannot parse', () => {
  assert.equal(langForPath('a/b/c.gd'), 'gdscript');
  assert.equal(langForPath('Main.cs'), 'c_sharp');
  assert.equal(langForPath('view.tsx'), 'tsx');
  assert.equal(langForPath('lib.hpp'), 'cpp');
  assert.equal(langForPath('README.md'), null);
  assert.equal(langForPath('noext'), null);
});

test('packageOf keeps scopes and collapses subpaths, and ignores local paths', () => {
  assert.equal(packageOf('lodash/fp'), 'lodash');
  assert.equal(packageOf('@scope/pkg/sub'), '@scope/pkg');
  assert.equal(packageOf('java.util.List'), 'java');
  assert.equal(packageOf('./local.js'), null);
  assert.equal(packageOf('res://x.gd'), null);
});

test('cleanTypeName strips generics, namespaces and pointer noise', () => {
  assert.equal(cleanTypeName('std::vector<Foo>*'), 'vector');
  assert.equal(cleanTypeName('ns.Base'), 'Base');
  assert.equal(cleanTypeName('Base'), 'Base');
});

test('splitQualified separates a C++ out-of-line owner', () => {
  assert.deepEqual(splitQualified('A::B::run'), { owner: 'A.B', name: 'run' });
  assert.deepEqual(splitQualified('run'), { owner: null, name: 'run' });
});

test('signatureOf takes the balanced parameter list and truncates', () => {
  assert.equal(signatureOf('func f(a, b)'), '(a, b)');
  assert.equal(signatureOf('void g(std::map<int,int> m)'), '(std::map<int,int> m)');
  assert.equal(signatureOf('no parens here'), undefined);
  assert.ok(signatureOf(`f(${'x'.repeat(100)})`).endsWith('…'));
});

test('visibilityOf reads modifiers, then naming convention', () => {
  assert.equal(visibilityOf('private void x()', 'x', 'java'), 'private');
  assert.equal(visibilityOf('protected void x()', 'x', 'java'), 'protected');
  assert.equal(visibilityOf('def _x(self)', '_x', 'python'), 'private');
  assert.equal(visibilityOf('  #y = 1', '#y', 'javascript'), 'private');
  assert.equal(visibilityOf('def x(self)', 'x', 'python'), 'public');
  // A leading underscore means nothing in Java or C#.
  assert.equal(visibilityOf('void _x()', '_x', 'java'), 'public');
});
