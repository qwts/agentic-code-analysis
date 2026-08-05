// Bounded front-matter parser: the scalar and flat-list forms the convention
// matrix actually needs (`key: value`, `key: [a, b]`, dash lists) and
// nothing more. Anything else — nesting, anchors, multi-line scalars —
// returns an error so the caller degrades to a diagnostic and `unknown`
// activation instead of guessing (design doc: no YAML dependency, no
// guessed semantics).

export interface Frontmatter {
  fields: Map<string, string | string[]>;
  /** Text after the closing delimiter. */
  body: string;
  /** Set when no front matter is present or it is malformed. */
  error?: string;
}

const KEY = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;

export function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { fields: new Map(), body: content, error: 'no front matter' };
  }
  const lines = content.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fields: new Map(), body: content, error: 'unterminated front matter' };
  const body = lines.slice(end + 1).join('\n');
  const fields = new Map<string, string | string[]>();
  let listKey: string | undefined;
  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const dash = /^\s+-\s+(.*)$/.exec(line);
    if (dash && listKey) {
      (fields.get(listKey) as string[]).push(unquote(dash[1]!));
      continue;
    }
    const match = KEY.exec(line);
    if (!match) return { fields: new Map(), body, error: `unsupported front matter line: ${line.trim()}` };
    const key = match[1]!;
    const value = match[2]!.trim();
    if (value === '') {
      fields.set(key, []);
      listKey = key;
      continue;
    }
    listKey = undefined;
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      fields.set(key, inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim())));
      continue;
    }
    fields.set(key, unquote(value));
  }
  return { fields, body };
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
  return quoted ? value.slice(1, -1) : value;
}

/** Field as a glob list however the author wrote it (inline list, dash list,
 * or a comma-separated scalar). */
export function globList(fields: Map<string, string | string[]>, key: string): string[] | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}
