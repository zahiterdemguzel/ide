// --- diagram: per-language structure extraction ---
// One record per source file, in one shape, for every supported language:
//
//   { path, lang, symbols[], imports[], calls[], news[] }
//   symbols: { kind, name, parent, line, endLine, signature, visibility, static,
//              extends[], implements[] }
//   imports: { target, package, line }     calls/news: { from, name, line }
//
// Six languages go through tree-sitter (the queries below), and GDScript goes
// through a hand-written scanner because no prebuilt GDScript wasm grammar
// exists. Both paths produce the identical record, so diagram-lib.js never
// learns that the difference exists.
//
// This module is pure: it takes source text (and, for the tree-sitter path, an
// already-parsed tree) and returns data. Loading grammars and reading files is
// diagram-worker.js's job.

// Extension -> the grammar/scanner to use. Header files map to cpp so a C++
// project's declarations are picked up alongside its definitions.
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  py: 'python', pyi: 'python',
  java: 'java',
  cs: 'c_sharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', h: 'cpp', c: 'cpp',
  gd: 'gdscript',
};

// Languages served by a tree-sitter wasm grammar (everything except GDScript).
const WASM_LANGS = ['javascript', 'typescript', 'tsx', 'python', 'java', 'c_sharp', 'cpp'];

const langForPath = (file) => LANG_BY_EXT[(file.split('.').pop() || '').toLowerCase()] || null;

// --- tree-sitter queries ---------------------------------------------------
// Captures follow one convention so a single walker handles every language:
//   @def.<kind>   the whole definition node (its extent becomes line..endLine)
//   @name         the definition's name
//   @super        a supertype written on that definition
//   @iface        an implemented interface
//   @call         a plain call, `foo()` — the callee must be in lexical scope
//   @call.method  a call through a receiver, `x.foo()` — only ever a method, so
//                 resolution must not let `s.trim()` land on a repo-level
//                 `function trim()` that merely shares the name
//   @new          an instantiation's type name
//   @import       an import specifier (string literal or dotted path)
// A definition's owner is derived from tree position, not from the query, so
// nesting works the same everywhere.

// Shared by JavaScript and TypeScript. What differs between the two grammars —
// how a heritage clause and a class field are spelled — lives in the two
// dialect blocks below, because the node names genuinely are not the same.
const JS_CORE = `
  (class_declaration name: (_) @name) @def.class
  (class name: (_) @name) @def.class
  (method_definition name: (_) @name) @def.method
  (function_declaration name: (_) @name) @def.function
  (generator_function_declaration name: (_) @name) @def.function
  (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
  (call_expression function: (identifier) @call)
  (call_expression function: (member_expression property: (property_identifier) @call.method))
  (new_expression constructor: (identifier) @new)
  (new_expression constructor: (member_expression property: (property_identifier) @new))
  (import_statement source: (string (string_fragment) @import))
  (call_expression function: (identifier) @_req arguments: (arguments (string (string_fragment) @import))
    (#eq? @_req "require"))
`;

// JavaScript writes `class A extends B` as a bare expression under
// class_heritage, and a class field as `field_definition property:`.
const JS_ONLY = `
  (class_heritage (identifier) @super)
  (class_heritage (member_expression) @super)
  (field_definition property: (_) @name) @def.field
`;

// TypeScript wraps the same heritage in extends_clause/implements_clause, names
// class fields public_field_definition, and adds the type-only declarations.
const TS_ONLY = `
  (extends_clause value: (identifier) @super)
  (extends_clause value: (member_expression) @super)
  (extends_type_clause (type_identifier) @super)
  (implements_clause (type_identifier) @iface)
  (public_field_definition name: (_) @name) @def.field
  (interface_declaration name: (_) @name) @def.interface
  (enum_declaration name: (_) @name) @def.enum
  (abstract_class_declaration name: (_) @name) @def.class
  (abstract_method_signature name: (_) @name) @def.method
  (method_signature name: (_) @name) @def.method
  (property_signature name: (_) @name) @def.field
`;

const QUERIES = {
  javascript: JS_CORE + JS_ONLY,
  typescript: JS_CORE + TS_ONLY,
  tsx: JS_CORE + TS_ONLY,

  python: `
    (class_definition name: (identifier) @name superclasses: (argument_list)? ) @def.class
    (class_definition superclasses: (argument_list [(identifier) @super (attribute) @super]))
    (function_definition name: (identifier) @name) @def.function
    (call function: (identifier) @call)
    (call function: (attribute attribute: (identifier) @call.method))
    (import_statement name: [(dotted_name) @import (aliased_import (dotted_name) @import)])
    (import_from_statement module_name: [(dotted_name) @import (relative_import) @import])
  `,

  java: `
    (class_declaration name: (identifier) @name) @def.class
    (interface_declaration name: (identifier) @name) @def.interface
    (enum_declaration name: (identifier) @name) @def.enum
    (record_declaration name: (identifier) @name) @def.class
    (superclass (type_identifier) @super)
    (super_interfaces (type_list (type_identifier) @iface))
    (extends_interfaces (type_list (type_identifier) @iface))
    (method_declaration name: (identifier) @name) @def.method
    (constructor_declaration name: (identifier) @name) @def.method
    (field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
    (method_invocation name: (identifier) @call)
    (object_creation_expression type: (type_identifier) @new)
    (import_declaration (scoped_identifier) @import)
  `,

  c_sharp: `
    (class_declaration name: (identifier) @name) @def.class
    (interface_declaration name: (identifier) @name) @def.interface
    (enum_declaration name: (identifier) @name) @def.enum
    (struct_declaration name: (identifier) @name) @def.struct
    (record_declaration name: (identifier) @name) @def.class
    (base_list (identifier) @super)
    (method_declaration name: (identifier) @name) @def.method
    (constructor_declaration name: (identifier) @name) @def.method
    (property_declaration name: (identifier) @name) @def.field
    (field_declaration (variable_declaration (variable_declarator (identifier) @name))) @def.field
    (invocation_expression function: (identifier) @call)
    (invocation_expression function: (member_access_expression name: (identifier) @call.method))
    (object_creation_expression type: (identifier) @new)
    (using_directive (qualified_name) @import)
    (using_directive (identifier) @import)
  `,

  cpp: `
    (class_specifier name: (type_identifier) @name) @def.class
    (struct_specifier name: (type_identifier) @name) @def.struct
    (enum_specifier name: (type_identifier) @name) @def.enum
    (base_class_clause (type_identifier) @super)
    (function_definition declarator: (function_declarator declarator: [(identifier) @name (field_identifier) @name (qualified_identifier) @name])) @def.function
    (field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
    (field_declaration declarator: (field_identifier) @name) @def.field
    (call_expression function: (identifier) @call)
    (call_expression function: (field_expression field: (field_identifier) @call.method))
    (preproc_include path: [(string_literal) @import (system_lib_string) @import])
  `,
};

// C++ writes members out-of-line as `Klass::method`, which the grammar hands us
// as one qualified_identifier. Split it so the member lands inside its class.
function splitQualified(name) {
  const i = name.lastIndexOf('::');
  return i < 0 ? { owner: null, name } : { owner: name.slice(0, i).replace(/::/g, '.'), name: name.slice(i + 2) };
}

const DEF_PREFIX = 'def.';
const KIND_OF_CAPTURE = (capture) => (capture.startsWith(DEF_PREFIX) ? capture.slice(DEF_PREFIX.length) : null);

// A definition owns another when it strictly encloses it; the innermost such
// definition is the parent. Definitions arrive in query order, so sort by start
// offset and scan with a stack rather than doing an O(n^2) containment search.
function nestDefinitions(defs) {
  defs.sort((a, b) => a.start - b.start || b.end - a.end);
  const stack = [];
  for (const def of defs) {
    while (stack.length && stack[stack.length - 1].end <= def.start) stack.pop();
    const owner = stack[stack.length - 1];
    def.parent = owner ? (owner.parent ? `${owner.parent}.${owner.name}` : owner.name) : '';
    // An out-of-line C++ definition names its owner itself; trust that over the
    // (file-level) tree position.
    if (def.ownerOverride) def.parent = def.ownerOverride;
    stack.push(def);
  }
  return defs;
}

// Which definition a use site (a call, a `new`) sits inside — the caller.
function enclosingDef(defs, offset) {
  let best = null;
  for (const def of defs) {
    if (def.start <= offset && offset < def.end) {
      if (!best || def.start > best.start) best = def;
    }
  }
  return best ? (best.parent ? `${best.parent}.${best.name}` : best.name) : null;
}

// A method's parameter list, trimmed to something that fits in a class box.
function signatureOf(text, maxLen = 60) {
  const open = text.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) {
      const sig = text.slice(open, i + 1).replace(/\s+/g, ' ');
      return sig.length > maxLen ? sig.slice(0, maxLen - 1) + '…' : sig;
    }
  }
  return undefined;
}

function visibilityOf(text, name, lang) {
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  if (/\bpublic\b/.test(text)) return 'public';
  // Python and JS spell "private" with a leading underscore / hash instead.
  if (name.startsWith('#')) return 'private';
  if ((lang === 'python' || lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && name.startsWith('_')) return 'private';
  return 'public';
}

// Bare import specifiers name a package, not a file. Strip subpaths so
// `lodash/fp` and `lodash` collapse to one external node; keep the scope on
// scoped packages.
function packageOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('res://')) return null;
  const parts = spec.replace(/^<|>$/g, '').split(/[/.]/);
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return parts[0];
}

// tree-sitter hands back capture objects wrapping live syntax nodes. Flatten
// them to plain data here, at the single point of contact with the parser API,
// so everything below is ordinary objects.
function flattenCaptures(matches) {
  const out = [];
  for (const m of matches) {
    for (const c of m.captures) {
      out.push({
        name: c.name,
        text: c.node.text,
        start: c.node.startIndex,
        end: c.node.endIndex,
        line: c.node.startPosition.row,
        endLine: c.node.endPosition.row,
      });
    }
  }
  return out;
}

// Build one record from flattened captures plus the original source text.
function fromCaptures(file, lang, captures, text) {
  const defs = [];
  const calls = [];
  const news = [];
  const imports = [];
  const supers = []; // { offset, kind: 'extends'|'implements', name }

  for (const cap of captures) {
    const kind = KIND_OF_CAPTURE(cap.name);
    if (kind) { defs.push({ kind, start: cap.start, end: cap.end, line: cap.line, endLine: cap.endLine }); continue; }
    switch (cap.name) {
      case 'name': {
        // The name belongs to the innermost still-unnamed definition enclosing
        // it — innermost being the one that starts latest.
        const owner = defs
          .filter((d) => d.start <= cap.start && cap.end <= d.end && !d.name)
          .sort((a, b) => a.start - b.start).pop();
        if (owner) {
          const { owner: qual, name } = splitQualified(cap.text);
          owner.name = name;
          owner.nameLine = cap.line;
          if (qual) owner.ownerOverride = qual;
        }
        break;
      }
      case 'super': supers.push({ offset: cap.start, kind: 'extends', name: cleanTypeName(cap.text) }); break;
      case 'iface': supers.push({ offset: cap.start, kind: 'implements', name: cleanTypeName(cap.text) }); break;
      case 'call': calls.push({ offset: cap.start, name: cap.text, line: cap.line }); break;
      case 'call.method': calls.push({ offset: cap.start, name: cap.text, line: cap.line, method: true }); break;
      case 'new': news.push({ offset: cap.start, name: cleanTypeName(cap.text), line: cap.line }); break;
      case 'import': imports.push({ target: cleanImport(cap.text), line: cap.line }); break;
      default: break; // helper captures (@_req) carry no meaning of their own
    }
  }

  const named = defs.filter((d) => d.name);
  nestDefinitions(named);

  // C# writes base classes and interfaces in one undifferentiated list
  // (`class Dog : Animal, IGreeter`), so the grammar cannot tell them apart and
  // neither can we — except by the naming convention the whole .NET ecosystem
  // follows. Splitting on it is what makes a C# class diagram show inheritance
  // and interface implementation as the different relationships they are.
  const csharpInterface = (name) => /^I[A-Z]/.test(name);

  // Attach each supertype to the definition it was written on: the innermost
  // definition containing it. Type-position captures always sit inside their own
  // declaration, so this is unambiguous.
  for (const s of supers) {
    const owner = named.filter((d) => d.start <= s.offset && s.offset < d.end).sort((a, b) => a.start - b.start).pop();
    if (!owner) continue;
    const asInterface = s.kind === 'implements' || (lang === 'c_sharp' && csharpInterface(s.name));
    const list = asInterface ? (owner.implements ||= []) : (owner.extends ||= []);
    if (!list.includes(s.name)) list.push(s.name);
  }

  const symbols = named.map((d) => {
    const body = text.slice(d.start, Math.min(d.end, d.start + 400));
    return {
      kind: d.kind, name: d.name, parent: d.parent || '',
      line: (d.nameLine ?? d.line ?? 0) + 1,
      endLine: d.endLine + 1,
      signature: d.kind === 'method' || d.kind === 'function' ? signatureOf(body) : undefined,
      visibility: visibilityOf(body.split('\n')[0], d.name, lang),
      static: /\bstatic\b/.test(body.split('\n')[0]) || undefined,
      extends: d.extends || [],
      implements: d.implements || [],
    };
  });

  return {
    path: file, lang, symbols,
    imports: imports.map((i) => ({ ...i, package: packageOf(i.target) })),
    calls: calls.map((c) => ({ from: enclosingDef(named, c.offset), name: c.name, line: c.line + 1, method: c.method })),
    news: news.map((n) => ({ from: enclosingDef(named, n.offset), name: n.name, line: n.line + 1 })),
  };
}

// Drop generic arguments, namespace qualifiers and pointer/reference noise so
// `std::vector<Foo>*` and `Foo` compare equal.
function cleanTypeName(text) {
  return text.replace(/<[^>]*>/g, '').replace(/[*&\s]/g, '').split(/::|\./).pop() || text;
}

const cleanImport = (text) => text.replace(/^["'<]|[">']$/g, '');

// --- GDScript --------------------------------------------------------------
// No prebuilt wasm grammar exists for GDScript, so this scanner covers it. The
// language is line-oriented and indentation-scoped, which makes a scanner both
// adequate and predictable: `class_name`/`extends` at file scope define the
// script's own type, `func`/`var`/`signal` define members, `preload`/`load`
// name other scripts, and `Klass.new()` instantiates.

const GD_STRIP = /#.*$/;

function extractGdscript(file, text) {
  const lines = text.split(/\r?\n/);
  const symbols = [];
  const imports = [];
  const calls = [];
  const news = [];

  // A .gd file *is* a class. Its name comes from `class_name`, else the file
  // stem — that is the name other scripts refer to it by.
  const stem = (file.split('/').pop() || file).replace(/\.gd$/, '');
  const self = {
    kind: 'class', name: stem, parent: '', line: 1, endLine: lines.length,
    visibility: 'public', extends: [], implements: [],
  };
  symbols.push(self);

  let currentFunc = null;      // qualified name of the func we are inside
  let currentFuncIndent = 0;
  let innerClass = null;       // name of an enclosing `class Foo:` block
  let innerClassIndent = 0;

  lines.forEach((raw, i) => {
    const line = raw.replace(GD_STRIP, '');
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const lineNo = i + 1;

    if (innerClass !== null && indent <= innerClassIndent && !body.startsWith('class ')) innerClass = null;
    if (currentFunc && indent <= currentFuncIndent) currentFunc = null;

    let m;
    if ((m = body.match(/^class_name\s+([A-Za-z_]\w*)/))) { self.name = m[1]; return; }
    if ((m = body.match(/^extends\s+("?)([A-Za-z_][\w./]*)\1/))) {
      const target = m[2];
      if (target.includes('/') || target.endsWith('.gd')) imports.push({ target, line: lineNo });
      self.extends.push(target.replace(/^.*\//, '').replace(/\.gd$/, ''));
      return;
    }
    if ((m = body.match(/^class\s+([A-Za-z_]\w*)/))) {
      innerClass = m[1]; innerClassIndent = indent;
      symbols.push({ kind: 'class', name: m[1], parent: self.name, line: lineNo, endLine: lineNo, visibility: 'public', extends: [], implements: [] });
      return;
    }
    if ((m = body.match(/^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*(\([^)]*\))/))) {
      const parent = innerClass ? `${self.name}.${innerClass}` : self.name;
      symbols.push({
        kind: 'method', name: m[1], parent, line: lineNo, endLine: lineNo,
        signature: m[2].replace(/\s+/g, ' '),
        visibility: m[1].startsWith('_') ? 'private' : 'public',
        static: /^static\s/.test(body) || undefined,
        extends: [], implements: [],
      });
      currentFunc = `${parent}.${m[1]}`;
      currentFuncIndent = indent;
      return;
    }
    if ((m = body.match(/^(?:@export\s+)?(?:static\s+)?var\s+([A-Za-z_]\w*)/)) || (m = body.match(/^const\s+([A-Za-z_]\w*)/)) || (m = body.match(/^signal\s+([A-Za-z_]\w*)/))) {
      const parent = innerClass ? `${self.name}.${innerClass}` : self.name;
      symbols.push({
        kind: 'field', name: m[1], parent, line: lineNo, endLine: lineNo,
        visibility: m[1].startsWith('_') ? 'private' : 'public',
        extends: [], implements: [],
      });
    }

    // preload/load reference other scripts and scenes by res:// path.
    for (const im of body.matchAll(/\b(?:preload|load)\s*\(\s*["']([^"']+)["']/g)) imports.push({ target: im[1], line: lineNo });
    // `Klass.new()` is GDScript's constructor call.
    for (const nw of body.matchAll(/\b([A-Z]\w*)\s*\.\s*new\s*\(/g)) news.push({ from: currentFunc, name: nw[1], line: lineNo });
    for (const cl of body.matchAll(/\b([a-z_]\w*)\s*\(/g)) {
      if (!GD_KEYWORDS.has(cl[1])) calls.push({ from: currentFunc, name: cl[1], line: lineNo });
    }
  });

  // Give the script class a real extent and let members close over their body:
  // the scanner records single-line extents, which is enough for click-to-open.
  self.endLine = lines.length;

  return {
    path: file, lang: 'gdscript', symbols,
    imports: imports.map((i) => ({ ...i, package: null })),
    calls, news,
  };
}

const GD_KEYWORDS = new Set([
  'if', 'elif', 'while', 'for', 'match', 'return', 'func', 'var', 'const', 'and', 'or', 'not',
  'in', 'is', 'as', 'await', 'assert', 'print', 'range', 'super', 'yield', 'breakpoint',
]);

module.exports = {
  LANG_BY_EXT, WASM_LANGS, QUERIES, langForPath,
  flattenCaptures, fromCaptures, extractGdscript,
  splitQualified, nestDefinitions, enclosingDef, signatureOf, visibilityOf,
  packageOf, cleanTypeName, cleanImport,
};
