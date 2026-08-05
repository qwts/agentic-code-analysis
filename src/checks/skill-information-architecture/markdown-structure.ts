// Fence-aware Markdown structure and disclosure-route extraction. This is a
// mechanical frame, not a style checker: it preserves exact source excerpts
// and classifies only route forms pinned by the check design.
import { posix } from 'node:path';
import type { SkillRoute, SkillSection } from './model.ts';

interface Line {
  text: string;
  start: number;
  end: number;
  fenced: boolean;
}

function linesOf(content: string): Line[] {
  const result: Line[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const text of content.match(/.*(?:\n|$)/gu) ?? []) {
    if (text === '') continue;
    const marker = text.match(/^\s*(```+|~~~+)/u)?.[1];
    const fenced = fence !== undefined;
    result.push({ text, start: offset, end: offset + text.length, fenced });
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    }
    offset += text.length;
  }
  return result;
}

export function sectionsOf(content: string): SkillSection[] {
  const lines = linesOf(content);
  const heads = lines.flatMap((line) => {
    if (line.fenced) return [];
    const match = line.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*(?:\n|$)/u);
    return match === null ? [] : [{ level: match[1]!.length, heading: match[2]!, start: line.start }];
  });
  if (heads.length === 0) return [{ heading: '(body)', level: 0, start: 0, end: content.length, text: content }];
  return heads.map((head, index) => {
    const end = heads[index + 1]?.start ?? content.length;
    return { ...head, end, text: content.slice(head.start, end) };
  });
}

const RESOURCE_PATH = /(?:\$\{[A-Z_][A-Z0-9_]*\}\/)?(?:references|reference|resources|scripts|assets)\/[A-Za-z0-9._~!$&'()+,;=@%/-]+/gu;

function classifyTarget(packageDir: string, sourcePath: string, target: string, rootRelative: boolean, members: ReadonlySet<string>): Pick<SkillRoute, 'status' | 'resolvedPath'> {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('//')) return { status: 'external' };
  if (target.startsWith('#')) return { status: 'fragment' };
  if (/^\$\{[^}]+\}\//u.test(target)) {
    if (!target.startsWith('${CLAUDE_SKILL_DIR}/')) return { status: 'target-unverifiable' };
    target = target.slice('${CLAUDE_SKILL_DIR}/'.length);
    rootRelative = true;
  }
  const withoutFragment = target.split('#', 1)[0]!;
  const base = rootRelative ? packageDir : posix.dirname(sourcePath);
  const resolved = posix.normalize(posix.join(base, withoutFragment));
  if (resolved !== packageDir && !resolved.startsWith(`${packageDir}/`)) return { status: 'escapes-package' };
  return { status: members.has(resolved) ? 'resolved' : 'missing', resolvedPath: resolved };
}

function cueFor(content: string, start: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEnd = content.indexOf('\n', start);
  return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
}

export function routesOf(sourcePath: string, content: string, packageDir: string, members: ReadonlySet<string>): SkillRoute[] {
  const sourceLines = linesOf(content);
  const insideFence = (index: number): boolean => sourceLines.some((line) => line.fenced && index >= line.start && index < line.end);
  const candidates: { excerpt: string; target: string; index: number; rootRelative: boolean }[] = [];
  const occupied: [number, number][] = [];
  const markdown = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
  for (const match of content.matchAll(markdown)) {
    const index = match.index;
    if (insideFence(index)) continue;
    candidates.push({ excerpt: match[0], target: match[1]!, index, rootRelative: false });
    occupied.push([index, index + match[0].length]);
  }
  const definitions = new Map<string, string>();
  for (const match of content.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gmu)) definitions.set(match[1]!.toLowerCase(), match[2]!);
  for (const match of content.matchAll(/\[[^\]]*\]\[([^\]]+)\]/gu)) {
    const index = match.index;
    if (insideFence(index)) continue;
    const target = definitions.get(match[1]!.toLowerCase());
    if (target === undefined) continue;
    candidates.push({ excerpt: match[0], target, index, rootRelative: false });
    occupied.push([index, index + match[0].length]);
  }
  for (const match of content.matchAll(RESOURCE_PATH)) {
    const index = match.index;
    if (insideFence(index)) continue;
    if (occupied.some(([start, end]) => index >= start && index < end)) continue;
    candidates.push({ excerpt: match[0], target: match[0], index, rootRelative: true });
  }
  return candidates
    .sort((a, b) => a.index - b.index || a.target.localeCompare(b.target))
    .map((candidate) => ({
      sourcePath,
      excerpt: candidate.excerpt,
      target: candidate.target,
      ...classifyTarget(packageDir, sourcePath, candidate.target, candidate.rootRelative, members),
      cue: cueFor(content, candidate.index),
    }));
}
