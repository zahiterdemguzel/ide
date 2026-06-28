// A small, dependency-free spreadsheet formula engine: tokenizer →
// recursive-descent parser → evaluator. Covers the arithmetic/text/logical
// operators and the common worksheet functions (SUM, IF, VLOOKUP, …). It does
// NOT own the dependency graph — the caller passes a `ctx` whose getCell()
// returns the already-computed value of another cell and is responsible for
// recompute order and cycle detection (the grid does this with memoization).
// No DOM, no deps; unit-tested in test/sheet-formula.test.mjs.

import { parseA1, parseRange } from './sheet-model.js';

// Excel-style error values are plain strings beginning with '#'. We throw them
// as exceptions during evaluation and surface the code as the cell result.
export class FormulaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const ERR = (code) => { throw new FormulaError(code); };
export function isError(v) { return typeof v === 'string' && /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|ERROR!)$/.test(v); }

// ── tokenizer ────────────────────────────────────────────────────────────────
function tokenize(s) {
  const toks = [];
  let i = 0;
  const two = ['<=', '>=', '<>'];
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"') { // string literal; "" is an escaped quote
      let j = i + 1, str = '';
      while (j < s.length) {
        if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j += 2; continue; } break; }
        str += s[j++];
      }
      if (s[j] !== '"') ERR('#ERROR!');
      toks.push({ t: 'str', v: str }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1]))) {
      let j = i;
      while (j < s.length && /[0-9.eE+-]/.test(s[j])) {
        // only let +/- belong to the number right after an exponent marker
        if ((s[j] === '+' || s[j] === '-') && !/[eE]/.test(s[j - 1])) break;
        j++;
      }
      const num = Number(s.slice(i, j));
      if (Number.isNaN(num)) ERR('#ERROR!');
      toks.push({ t: 'num', v: num }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { // identifier: function name, cell ref, or bool
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$.]/.test(s[j])) j++;
      toks.push({ t: 'ident', v: s.slice(i, j) }); i = j; continue;
    }
    if (two.includes(s.slice(i, i + 2))) { toks.push({ t: 'op', v: s.slice(i, i + 2) }); i += 2; continue; }
    if ('+-*/^&=<>%(),:'.includes(c)) {
      const type = c === '(' ? 'lparen' : c === ')' ? 'rparen' : c === ',' ? 'comma' : c === ':' ? 'colon' : 'op';
      toks.push({ t: type, v: c }); i++; continue;
    }
    ERR('#ERROR!');
  }
  return toks;
}

// ── parser (→ AST) ───────────────────────────────────────────────────────────
// Precedence, lowest→highest: comparison, & (concat), +/-, * /, ^, unary, %.
class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  eat(type) { const tk = this.toks[this.i]; if (!tk || tk.t !== type) ERR('#ERROR!'); return this.toks[this.i++]; }

  parse() { const node = this.comparison(); if (this.i !== this.toks.length) ERR('#ERROR!'); return node; }

  comparison() {
    let left = this.concat();
    while (this.peek() && this.peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek().v)) {
      const op = this.next().v; left = { k: 'bin', op, left, right: this.concat() };
    }
    return left;
  }
  concat() {
    let left = this.additive();
    while (this.peek() && this.peek().t === 'op' && this.peek().v === '&') {
      this.next(); left = { k: 'bin', op: '&', left, right: this.additive() };
    }
    return left;
  }
  additive() {
    let left = this.multiplicative();
    while (this.peek() && this.peek().t === 'op' && (this.peek().v === '+' || this.peek().v === '-')) {
      const op = this.next().v; left = { k: 'bin', op, left, right: this.multiplicative() };
    }
    return left;
  }
  multiplicative() {
    let left = this.power();
    while (this.peek() && this.peek().t === 'op' && (this.peek().v === '*' || this.peek().v === '/')) {
      const op = this.next().v; left = { k: 'bin', op, left, right: this.power() };
    }
    return left;
  }
  power() {
    let left = this.unary();
    while (this.peek() && this.peek().t === 'op' && this.peek().v === '^') {
      this.next(); left = { k: 'bin', op: '^', left, right: this.unary() };
    }
    return left;
  }
  unary() {
    const tk = this.peek();
    if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) { this.next(); return { k: 'unary', op: tk.v, arg: this.unary() }; }
    return this.percent();
  }
  percent() {
    let node = this.primary();
    while (this.peek() && this.peek().t === 'op' && this.peek().v === '%') { this.next(); node = { k: 'unary', op: '%', arg: node }; }
    return node;
  }
  primary() {
    const tk = this.next();
    if (!tk) ERR('#ERROR!');
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'lparen') { const e = this.comparison(); this.eat('rparen'); return e; }
    if (tk.t === 'ident') {
      const up = tk.v.toUpperCase();
      if (this.peek() && this.peek().t === 'lparen') { // function call
        this.next();
        const args = [];
        if (this.peek() && this.peek().t !== 'rparen') {
          args.push(this.comparison());
          while (this.peek() && this.peek().t === 'comma') { this.next(); args.push(this.comparison()); }
        }
        this.eat('rparen');
        return { k: 'func', name: up, args };
      }
      if (up === 'TRUE') return { k: 'bool', v: true };
      if (up === 'FALSE') return { k: 'bool', v: false };
      // a cell ref, optionally the start of a range (A1:B2)
      if (this.peek() && this.peek().t === 'colon' && this.toks[this.i + 1] && this.toks[this.i + 1].t === 'ident') {
        this.next(); const end = this.next();
        return { k: 'range', v: tk.v + ':' + end.v };
      }
      if (parseA1(tk.v)) return { k: 'ref', v: tk.v };
      ERR('#NAME?');
    }
    ERR('#ERROR!');
  }
}

// ── evaluator ────────────────────────────────────────────────────────────────
const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isError(v)) ERR(v);
  const n = Number(v);
  if (Number.isNaN(n)) ERR('#VALUE!');
  return n;
};
const str = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isError(v)) ERR(v);
  return String(v);
};
const bool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined || v === '') return false;
  if (isError(v)) ERR(v);
  const s = String(v).toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return num(v) !== 0;
};

// A range node evaluates to a 2D array of cell values; aggregation functions
// flatten it. `flat` pulls every scalar out of a mix of scalars and ranges.
function flat(values) {
  const out = [];
  for (const v of values) { if (Array.isArray(v)) { for (const row of v) for (const c of row) out.push(c); } else out.push(v); }
  return out;
}
const nums = (values) => flat(values).filter((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)))).map(Number);

function evalNode(node, ctx) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'ref': { const a = parseA1(node.v); if (!a) ERR('#REF!'); return ctx.getCell(a.col, a.row); }
    case 'range': return rangeValues(node.v, ctx);
    case 'unary': {
      if (node.op === '%') return num(evalNode(node.arg, ctx)) / 100;
      const v = num(evalNode(node.arg, ctx));
      return node.op === '-' ? -v : v;
    }
    case 'bin': return evalBin(node, ctx);
    case 'func': return callFunc(node.name, node.args, ctx);
    default: ERR('#ERROR!');
  }
}

function rangeValues(ref, ctx) {
  const r = parseRange(ref);
  if (!r) ERR('#REF!');
  const grid = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const line = [];
    for (let col = r.c1; col <= r.c2; col++) line.push(ctx.getCell(col, row));
    grid.push(line);
  }
  return grid;
}

function evalBin(node, ctx) {
  const op = node.op;
  if (op === '&') return str(scalar(evalNode(node.left, ctx))) + str(scalar(evalNode(node.right, ctx)));
  const l = scalar(evalNode(node.left, ctx)); const r = scalar(evalNode(node.right, ctx));
  switch (op) {
    case '+': return num(l) + num(r);
    case '-': return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': { const d = num(r); if (d === 0) ERR('#DIV/0!'); return num(l) / d; }
    case '^': return Math.pow(num(l), num(r));
    case '=': return looseEq(l, r);
    case '<>': return !looseEq(l, r);
    case '<': return cmp(l, r) < 0;
    case '>': return cmp(l, r) > 0;
    case '<=': return cmp(l, r) <= 0;
    case '>=': return cmp(l, r) >= 0;
    default: ERR('#ERROR!');
  }
}

// A range used where a single value is needed collapses to its first cell.
function scalar(v) { return Array.isArray(v) ? (v[0] ? v[0][0] : null) : v; }
function looseEq(a, b) {
  if (typeof a === 'number' || typeof b === 'number') { try { return num(a) === num(b); } catch { /* fall through */ } }
  return str(a).toUpperCase() === str(b).toUpperCase();
}
function cmp(a, b) {
  if ((typeof a === 'number' || a === null || a === '') && (typeof b === 'number' || b === null || b === '')) return num(a) - num(b);
  const sa = str(a).toUpperCase(); const sb = str(b).toUpperCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ── worksheet functions ──────────────────────────────────────────────────────
const FUNCS = {
  SUM: (a) => nums(a.map((x) => x.val)).reduce((s, n) => s + n, 0),
  PRODUCT: (a) => nums(a.map((x) => x.val)).reduce((s, n) => s * n, 1),
  AVERAGE: (a) => { const ns = nums(a.map((x) => x.val)); if (!ns.length) ERR('#DIV/0!'); return ns.reduce((s, n) => s + n, 0) / ns.length; },
  COUNT: (a) => nums(a.map((x) => x.val)).length,
  COUNTA: (a) => flat(a.map((x) => x.val)).filter((v) => v !== null && v !== undefined && v !== '').length,
  MIN: (a) => { const ns = nums(a.map((x) => x.val)); return ns.length ? Math.min(...ns) : 0; },
  MAX: (a) => { const ns = nums(a.map((x) => x.val)); return ns.length ? Math.max(...ns) : 0; },
  ROUND: (a) => { const f = Math.pow(10, num(a[1] ? a[1].s() : 0)); return Math.round(num(a[0].s()) * f) / f; },
  ROUNDUP: (a) => { const f = Math.pow(10, num(a[1] ? a[1].s() : 0)); return Math.ceil(Math.abs(num(a[0].s())) * f) / f * Math.sign(num(a[0].s())); },
  ROUNDDOWN: (a) => { const f = Math.pow(10, num(a[1] ? a[1].s() : 0)); return Math.floor(Math.abs(num(a[0].s())) * f) / f * Math.sign(num(a[0].s())); },
  INT: (a) => Math.floor(num(a[0].s())),
  ABS: (a) => Math.abs(num(a[0].s())),
  SQRT: (a) => { const v = num(a[0].s()); if (v < 0) ERR('#NUM!'); return Math.sqrt(v); },
  POWER: (a) => Math.pow(num(a[0].s()), num(a[1].s())),
  MOD: (a) => { const d = num(a[1].s()); if (d === 0) ERR('#DIV/0!'); return num(a[0].s()) % d; },
  FLOOR: (a) => { const sig = num(a[1] ? a[1].s() : 1) || 1; return Math.floor(num(a[0].s()) / sig) * sig; },
  CEILING: (a) => { const sig = num(a[1] ? a[1].s() : 1) || 1; return Math.ceil(num(a[0].s()) / sig) * sig; },
  IF: (a) => bool(a[0].s()) ? a[1].s() : (a[2] ? a[2].s() : false),
  IFERROR: (a) => { try { const v = a[0].s(); return isError(v) ? a[1].s() : v; } catch { return a[1].s(); } },
  AND: (a) => flat(a.map((x) => x.val)).every((v) => bool(v)),
  OR: (a) => flat(a.map((x) => x.val)).some((v) => bool(v)),
  NOT: (a) => !bool(a[0].s()),
  TRUE: () => true,
  FALSE: () => false,
  CONCAT: (a) => flat(a.map((x) => x.val)).map(str).join(''),
  CONCATENATE: (a) => a.map((x) => str(x.s())).join(''),
  LEN: (a) => str(a[0].s()).length,
  LEFT: (a) => str(a[0].s()).slice(0, a[1] ? num(a[1].s()) : 1),
  RIGHT: (a) => { const s = str(a[0].s()); const n = a[1] ? num(a[1].s()) : 1; return s.slice(s.length - n); },
  MID: (a) => str(a[0].s()).substr(num(a[1].s()) - 1, num(a[2].s())),
  UPPER: (a) => str(a[0].s()).toUpperCase(),
  LOWER: (a) => str(a[0].s()).toLowerCase(),
  TRIM: (a) => str(a[0].s()).trim(),
  COUNTIF: (a) => { const cells = flat([a[0].val]); const pred = matcher(a[1].s()); return cells.filter(pred).length; },
  SUMIF: (a) => {
    const range = flat([a[0].val]); const pred = matcher(a[1].s());
    const sumRange = a[2] ? flat([a[2].val]) : range;
    let total = 0;
    range.forEach((v, idx) => { if (pred(v)) total += num(sumRange[idx] ?? 0); });
    return total;
  },
  VLOOKUP: (a) => {
    const key = a[0].s(); const table = a[1].val; const colIdx = num(a[2].s()) - 1;
    const approx = a[3] ? bool(a[3].s()) : true;
    if (!Array.isArray(table)) ERR('#VALUE!');
    let match = null;
    for (const row of table) {
      if (looseEq(row[0], key)) { match = row; break; }
      if (approx && cmp(row[0], key) <= 0) match = row; else if (approx && cmp(row[0], key) > 0) break;
    }
    if (!match || colIdx < 0 || colIdx >= match.length) ERR('#N/A');
    return match[colIdx];
  },
};
// COUNTIF/SUMIF criteria: a bare value means equality; ">5"/"<=3"/"<>x" compare.
function matcher(criteria) {
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(String(criteria));
  const op = m[1] || '='; const raw = m[2];
  // A numeric criterion ("10", ">10") must compare numerically — otherwise cmp()
  // falls back to lexical order and "5" > "10".
  const rhs = (raw !== '' && !Number.isNaN(Number(raw))) ? Number(raw) : raw;
  return (v) => {
    switch (op) {
      case '=': return looseEq(v, rhs);
      case '<>': return !looseEq(v, rhs);
      case '<': return cmp(v, rhs) < 0;
      case '>': return cmp(v, rhs) > 0;
      case '<=': return cmp(v, rhs) <= 0;
      case '>=': return cmp(v, rhs) >= 0;
      default: return false;
    }
  };
}

function callFunc(name, argNodes, ctx) {
  const fn = FUNCS[name];
  if (!fn) ERR('#NAME?');
  // Each arg is exposed lazily so IF/IFERROR don't eval the untaken branch eagerly
  // for errors: .val is the raw (possibly array) value; .s() collapses to a scalar.
  const args = argNodes.map((n) => {
    let cached; let done = false;
    const val = () => { if (!done) { cached = evalNode(n, ctx); done = true; } return cached; };
    return { get val() { return val(); }, s: () => scalar(val()) };
  });
  return fn(args, ctx);
}

// Evaluate a formula string (with or without the leading '='). Returns a scalar
// value or an Excel error string. `ctx.getCell(col,row)` supplies other cells'
// computed values; it may throw a FormulaError (e.g. #REF!/cycle) which surfaces
// as the result.
export function evaluateFormula(src, ctx) {
  try {
    const text = String(src).replace(/^\s*=/, '');
    if (text.trim() === '') return '';
    const ast = new Parser(tokenize(text)).parse();
    return scalar(evalNode(ast, ctx));
  } catch (e) {
    if (e instanceof FormulaError) return e.code;
    return '#ERROR!';
  }
}
