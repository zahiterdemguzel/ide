// GDScript (Godot) for Monaco: Monaco ships no grammar for it, and treating .gd
// as Python (the old highlight.js mapping) mis-colours its annotations, node
// paths and StringName/NodePath literals. This is a Monarch tokenizer plus
// Python-style indentation rules. Code intelligence comes from the Godot
// editor's own language server when it's running (see lsp.md).

const KEYWORDS = [
  'if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return',
  'class', 'class_name', 'extends', 'is', 'in', 'as', 'self', 'super', 'signal', 'func', 'static',
  'const', 'enum', 'var', 'breakpoint', 'preload', 'await', 'yield', 'assert', 'void', 'and', 'or',
  'not', 'tool', 'onready', 'export', 'setget', 'remote', 'master', 'puppet', 'get', 'set',
];

const CONSTANTS = ['true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN'];

const BUILTIN_TYPES = [
  'bool', 'int', 'float', 'String', 'StringName', 'NodePath', 'Vector2', 'Vector2i', 'Vector3',
  'Vector3i', 'Vector4', 'Vector4i', 'Rect2', 'Rect2i', 'Transform2D', 'Transform3D', 'Plane',
  'Quaternion', 'AABB', 'Basis', 'Projection', 'Color', 'RID', 'Object', 'Callable', 'Signal',
  'Dictionary', 'Array', 'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array',
  'PackedFloat32Array', 'PackedFloat64Array', 'PackedStringArray', 'PackedVector2Array',
  'PackedVector3Array', 'PackedColorArray', 'PackedVector4Array', 'Variant',
];

export function registerGdscript(monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === 'gdscript')) return;
  monaco.languages.register({ id: 'gdscript', extensions: ['.gd'], aliases: ['GDScript', 'gdscript'] });

  monaco.languages.setLanguageConfiguration('gdscript', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    folding: { offSide: true, markers: { start: /^\s*#\s*region\b/, end: /^\s*#\s*endregion\b/ } },
    onEnterRules: [
      {
        // A line ending in ':' (func, if, for, class…) opens a block.
        beforeText: /:\s*(#.*)?$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
    wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  });

  monaco.languages.setMonarchTokensProvider('gdscript', {
    defaultToken: '',
    keywords: KEYWORDS,
    constants: CONSTANTS,
    typeKeywords: BUILTIN_TYPES,
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.bracket' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
    ],
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/@[a-zA-Z_]\w*/, 'annotation'],
        // $Node/Path and %UniqueName node references.
        [/\$"[^"]*"|\$[A-Za-z_][\w/]*/, 'variable.predefined'],
        [/%[A-Za-z_]\w*/, 'variable.predefined'],
        // &"StringName" and ^"Node/Path" literals.
        [/[&^]"/, { token: 'string.special', next: '@dstring' }],
        [/"""/, { token: 'string', next: '@tdstring' }],
        [/'''/, { token: 'string', next: '@tsstring' }],
        [/"/, { token: 'string', next: '@dstring' }],
        [/'/, { token: 'string', next: '@sstring' }],
        [/0x[0-9a-fA-F_]+/, 'number.hex'],
        [/0b[01_]+/, 'number.binary'],
        [/\d[\d_]*\.\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?|\d[\d_]*[eE][-+]?\d+/, 'number.float'],
        [/\d[\d_]*/, 'number'],
        [/(func)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'entity.name.function']],
        [/(class_name|extends|class)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'type.identifier']],
        [/[A-Za-z_]\w*(?=\s*\()/, {
          cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'function' },
        }],
        [/[A-Za-z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@constants': 'constant',
            '@typeKeywords': 'type',
            '[A-Z][A-Z0-9_]+': 'constant',
            '[A-Z]\\w*': 'type.identifier',
            '@default': 'identifier',
          },
        }],
        [/[{}()[\]]/, '@brackets'],
        [/->|:=|[-+*/%=<>!&|^~]=?|\*\*/, 'operator'],
        [/[;,.:]/, 'delimiter'],
      ],
      dstring: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string', next: '@pop' }],
      ],
      sstring: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, { token: 'string', next: '@pop' }],
      ],
      tdstring: [
        [/[^"\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"""/, { token: 'string', next: '@pop' }],
        [/"/, 'string'],
      ],
      tsstring: [
        [/[^'\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/'''/, { token: 'string', next: '@pop' }],
        [/'/, 'string'],
      ],
    },
  });
}
