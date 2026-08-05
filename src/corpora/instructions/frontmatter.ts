// The single YAML frontmatter parse/projection seam. Adapters interpret
// only the fields their convention documents; anything else is surfaced as
// data for diagnostics, never guessed at. YAML goes through the pinned
// `yaml` package — documented frontmatter is never regex-parsed.

import { parse } from 'yaml';

export type Frontmatter =
  | { readonly present: false; readonly body: string }
  | {
      readonly present: true;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly body: string;
      /** Raw frontmatter block including the `---` fences. */
      readonly raw: string;
    }
  | { readonly present: true; readonly error: string; readonly body: string; readonly raw: string };

const OPEN = /^---\r?\n/;

export function parseFrontmatter(content: string): Frontmatter {
  if (!OPEN.test(content)) return { present: false, body: content };
  const close = content.indexOf("\n---", 3);
  if (close === -1) {
    return { present: true, error: 'unterminated frontmatter block', body: content, raw: '' };
  }
  const fenceEnd = content.indexOf("\n", close + 1);
  const raw = content.slice(0, fenceEnd === -1 ? content.length : fenceEnd + 1);
  const body = fenceEnd === -1 ? '' : content.slice(fenceEnd + 1);
  const yamlText = content.slice(content.indexOf("\n") + 1, close);
  try {
    const value: unknown = parse(yamlText);
    if (value === null || value === undefined) return { present: true, fields: {}, body, raw };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { present: true, error: 'frontmatter is not a YAML mapping', body, raw };
    }
    return { present: true, fields: value as Record<string, unknown>, body, raw };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { present: true, error: `invalid YAML: ${message}`, body, raw };
  }
}

export function stringField(
  frontmatter: Frontmatter,
  name: string,
): string | undefined {
  if (!frontmatter.present || 'error' in frontmatter) return undefined;
  const value = frontmatter.fields[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(frontmatter: Frontmatter, name: string): boolean | undefined {
  if (!frontmatter.present || 'error' in frontmatter) return undefined;
  const value = frontmatter.fields[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** A string or string-list field normalized to a list. */
export function stringListField(
  frontmatter: Frontmatter,
  name: string,
): readonly string[] | undefined {
  if (!frontmatter.present || 'error' in frontmatter) return undefined;
  const value = frontmatter.fields[name];
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  return undefined;
}
