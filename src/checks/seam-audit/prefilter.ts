// Mechanically proven leaf classification (check design: a proof, never a
// smell blacklist). "No imports" is not proof — an import-free file can still
// call Date.now(), read process.env, or run code at module evaluation. This
// recognizer accepts only declarative forms whose evaluation provably
// acquires no dependency, reads no ambient state, and executes nothing:
// comments, const declarations initialized to literals, type aliases,
// interfaces, local export lists, and a literal default export. Everything
// else — any import/require, call-like syntax, function/class/enum, template
// interpolation, or unknown syntax — is "unproven" and goes to the judge. A
// false negative costs one judge call; a false positive would silently hide
// debt, so every ambiguity resolves to unproven.

interface Token {
  kind: 'ident' | 'string' | 'number' | 'punct';
  text: string;
}

const PUNCT = '{}[]()<>:;,=|&?.-+*/%!';

function tokenize(content: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') i += 1;
    } else if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < n && content[i] !== c) {
        if (content[i] === '\n' && c !== '`') return null;
        if (content[i] === '$' && content[i + 1] === '{' && c === '`') return null; // interpolation executes
        i += content[i] === '\\' ? 2 : 1;
      }
      if (i >= n) return null;
      i += 1;
      tokens.push({ kind: 'string', text: '' });
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(content[j]!)) j += 1;
      tokens.push({ kind: 'number', text: content.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(content[j]!)) j += 1;
      tokens.push({ kind: 'ident', text: content.slice(i, j) });
      i = j;
    } else if (c === '=' && content[i + 1] === '>') {
      tokens.push({ kind: 'punct', text: '=>' });
      i += 2;
    } else if (PUNCT.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i += 1;
    } else {
      return null;
    }
  }
  return tokens;
}

class Cursor {
  private i = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  next(): Token | undefined {
    return this.tokens[this.i++];
  }
  atEnd(): boolean {
    return this.i >= this.tokens.length;
  }
  isPunct(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'punct' && t.text === text;
  }
  isIdent(text?: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'ident' && (text === undefined || t.text === text);
  }
}

/** A token that, at nesting depth 0 inside skipped type text, means we have
 * walked past the type and into a statement (ASI) — never provable. */
const STOP_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'enum', 'return',
  'if', 'for', 'while', 'do', 'switch', 'throw', 'new', 'async', 'await', 'declare',
  'namespace', 'module', 'yield', 'delete', 'try',
]);

const OPEN = new Set(['(', '[', '{', '<']);
const CLOSE = new Set([')', ']', '}', '>']);

/**
 * Skip type-level text, which cannot execute in valid TS. Ends by consuming
 * `;` (or reaching `=` unconsumed, for annotations) at depth 0. Bails on
 * anything call-like or statement-like at depth 0 — with ASI, a missing
 * semicolon could otherwise swallow executable code into "type text".
 */
function skipType(c: Cursor, endAt: 'semicolon' | 'equals'): boolean {
  let depth = 0;
  let previous: Token | undefined;
  while (!c.atEnd()) {
    const t = c.peek()!;
    if (depth === 0) {
      if (endAt === 'semicolon' && t.kind === 'punct' && t.text === ';') {
        c.next();
        return true;
      }
      if (endAt === 'equals' && t.kind === 'punct' && t.text === '=') return true;
      if (t.kind === 'ident' && STOP_KEYWORDS.has(t.text)) return endAt === 'semicolon'; // ASI end for aliases; annotations must reach '='
      if (t.kind === 'punct' && t.text === '(' && (previous?.kind === 'ident' || previous?.text === ')' || previous?.text === ']')) {
        return false; // call-like
      }
    }
    if (t.kind === 'punct' && OPEN.has(t.text)) depth += 1;
    if (t.kind === 'punct' && CLOSE.has(t.text)) {
      depth -= 1;
      if (depth < 0) return false;
    }
    previous = c.next();
  }
  return endAt === 'semicolon' && depth === 0; // EOF ends an alias; an annotation must reach '='
}

const LITERAL_IDENTS = new Set(['true', 'false', 'null', 'undefined']);

function parseLiteral(c: Cursor): boolean {
  if (c.isPunct('-')) {
    c.next();
    if (c.peek()?.kind !== 'number') return false;
    c.next();
    return true;
  }
  const t = c.peek();
  if (!t) return false;
  if (t.kind === 'string' || t.kind === 'number' || (t.kind === 'ident' && LITERAL_IDENTS.has(t.text))) {
    c.next();
    return true;
  }
  if (c.isPunct('[')) {
    c.next();
    while (!c.isPunct(']')) {
      if (!parseLiteral(c)) return false;
      if (c.isPunct(',')) c.next();
      else if (!c.isPunct(']')) return false;
    }
    c.next();
    return true;
  }
  if (c.isPunct('{')) {
    c.next();
    while (!c.isPunct('}')) {
      const key = c.peek();
      if (!key || (key.kind !== 'ident' && key.kind !== 'string' && key.kind !== 'number')) return false;
      c.next();
      if (!c.isPunct(':')) return false;
      c.next();
      if (!parseLiteral(c)) return false;
      if (c.isPunct(',')) c.next();
      else if (!c.isPunct('}')) return false;
    }
    c.next();
    return true;
  }
  return false;
}

function parseConst(c: Cursor): boolean {
  c.next(); // const
  while (true) {
    if (!c.isIdent()) return false; // destructuring, `const enum`, … → unproven
    if (STOP_KEYWORDS.has(c.peek()!.text)) return false;
    c.next();
    if (c.isPunct(':')) {
      c.next();
      if (!skipType(c, 'equals')) return false;
    }
    if (!c.isPunct('=')) return false;
    c.next();
    if (!parseLiteral(c)) return false;
    if (c.isIdent('as') && c.isIdent('const', 1)) {
      c.next();
      c.next();
    }
    if (c.isPunct(',')) {
      c.next();
      continue;
    }
    if (c.isPunct(';')) c.next(); // ASI otherwise: the statement loop re-checks whatever follows
    return true;
  }
}

function parseInterface(c: Cursor): boolean {
  c.next(); // interface
  if (!c.isIdent()) return false;
  c.next();
  // Generics and heritage up to the body: identifiers and . , < > only.
  while (!c.isPunct('{')) {
    const t = c.peek();
    if (!t) return false;
    if (t.kind === 'ident' && !STOP_KEYWORDS.has(t.text)) c.next();
    else if (t.kind === 'punct' && ['.', ',', '<', '>'].includes(t.text)) c.next();
    else return false;
  }
  // The brace-balanced body is type-level: in valid TS it cannot execute,
  // and a file that is not valid TS never evaluates at all.
  let depth = 0;
  while (!c.atEnd()) {
    const t = c.next()!;
    if (t.kind === 'punct' && t.text === '{') depth += 1;
    if (t.kind === 'punct' && t.text === '}') {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

function parseExportList(c: Cursor): boolean {
  c.next(); // '{'
  while (!c.isPunct('}')) {
    if (c.isIdent('type') && c.isIdent(undefined, 1)) c.next();
    if (!c.isIdent()) return false;
    c.next();
    if (c.isIdent('as')) {
      c.next();
      if (!c.isIdent()) return false;
      c.next();
    }
    if (c.isPunct(',')) c.next();
    else if (!c.isPunct('}')) return false;
  }
  c.next();
  if (c.isIdent('from')) return false; // re-export: a dependency, not a leaf
  if (c.isPunct(';')) c.next();
  return true;
}

function parseDeclaration(c: Cursor): boolean {
  if (c.isIdent('const')) return parseConst(c);
  if (c.isIdent('type') && c.isIdent(undefined, 1)) {
    c.next();
    c.next();
    return skipType(c, 'semicolon');
  }
  if (c.isIdent('interface') && c.isIdent(undefined, 1)) return parseInterface(c);
  return false;
}

/** True only when every token of the file is proven inert at module
 * evaluation — the mechanical `pass` needs no judge and is never cached. */
export function provenLeaf(content: string): boolean {
  const tokens = tokenize(content);
  if (tokens === null) return false;
  const c = new Cursor(tokens);
  while (!c.atEnd()) {
    if (c.isPunct(';')) {
      c.next();
      continue;
    }
    if (c.isIdent('export')) {
      c.next();
      if (c.isIdent('default')) {
        c.next();
        if (!parseLiteral(c)) return false;
        if (c.isPunct(';')) c.next();
        continue;
      }
      if (c.isPunct('{')) {
        if (!parseExportList(c)) return false;
        continue;
      }
      if (c.isIdent('type') && c.isPunct('{', 1)) {
        c.next();
        if (!parseExportList(c)) return false;
        continue;
      }
      if (!parseDeclaration(c)) return false;
      continue;
    }
    if (!parseDeclaration(c)) return false;
  }
  return true;
}
