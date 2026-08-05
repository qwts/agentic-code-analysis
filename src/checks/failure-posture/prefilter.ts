// Mechanical applicability prefilter (check design): a pure, deterministic
// classifier that decides only whether a snapshot MAY touch an external
// dependency — network, storage, queue, or subprocess. It never produces a
// semantic verdict; its output is typed routing hints the judge receives
// explicitly labeled as hints, not proof. Bias is toward false positives: an
// extra T1 call is cheaper than suppressing an incident-grade finding, so
// only confidently irrelevant evidence skips.
import { CODE_EXT } from './import-graph.ts';

export type DependencyKind = 'network' | 'storage' | 'queue' | 'subprocess';
export type HintSource = 'import' | 'call' | 'injected-boundary';

export interface PrefilterHint {
  kind: DependencyKind;
  source: HintSource;
  token: string;
}

export interface SideSignals {
  candidate: boolean;
  reason: string;
  hints: PrefilterHint[];
}

// Mechanically out of scope, by design-doc class — never judged:
// IaC belongs to the backlog's config-blast-radius; non-executable formats
// cannot carry a failure posture.
const IAC_EXT = /\.(?:tf|tfvars|hcl)$/i;
const INERT_EXT =
  /\.(?:md|markdown|rst|txt|json|jsonc|ya?ml|toml|ini|cfg|env|lock|csv|tsv|xml|html|css|scss|less|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf)$/i;

/** Effectful module specifiers → dependency kind. Matched against the bare
 * specifier and its first path segment (`pg/lib/x` still signals `pg`). */
const IMPORT_KINDS: readonly (readonly [RegExp, DependencyKind])[] = [
  [/^(?:node:)?(?:https?|http2|net|tls|dns|dgram)$/, 'network'],
  [/^(?:undici|axios|got|ky|node-fetch|cross-fetch|ws|socket\.io(?:-client)?|@grpc\/grpc-js|graphql-request)$/, 'network'],
  [/^(?:node:)?fs(?:\/promises)?$/, 'storage'],
  [/^(?:pg|mysql2?|sqlite3|better-sqlite3|mongodb|mongoose|redis|ioredis|levelup?|knex|typeorm|sequelize|@prisma\/client)$/, 'storage'],
  [/^@aws-sdk\/client-(?:s3|dynamodb)$/, 'storage'],
  [/^(?:amqplib|kafkajs|bullmq|bull|nats|mqtt)$/, 'queue'],
  [/^@aws-sdk\/client-sqs$/, 'queue'],
  [/^(?:node:)?child_process$/, 'subprocess'],
  [/^execa$/, 'subprocess'],
];

/** Direct global/ambient APIs, detected on comment- and string-stripped text. */
const CALL_TOKENS: readonly (readonly [RegExp, DependencyKind, string])[] = [
  [/\bfetch\s*\(/, 'network', 'fetch'],
  [/\bnew\s+XMLHttpRequest\b/, 'network', 'XMLHttpRequest'],
  [/\bnew\s+WebSocket\b/, 'network', 'WebSocket'],
  [/\bnew\s+EventSource\b/, 'network', 'EventSource'],
  [/\bnavigator\.sendBeacon\b/, 'network', 'navigator.sendBeacon'],
  [/\bindexedDB\b/, 'storage', 'indexedDB'],
  [/\b(?:localStorage|sessionStorage)\b/, 'storage', 'web storage'],
];

// An awaited method call on a symbol whose name reads as an effect boundary
// (injected client, repository, queue, …). The name is the evidence — the
// prefilter cannot see the implementation behind the injection.
const AWAITED_CALL = /\bawait\s+(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;
const BOUNDARY_CTOR = /\bnew\s+([A-Za-z_$][\w$]*(?:Client|Gateway|Transport|Producer|Consumer|Broker|Queue|Repository|Store|Connection))\s*\(/g;
const QUEUE_NAME = /(?:queue|producer|consumer|broker|bus)$/i;
const STORAGE_NAME = /(?:repo|repository|store|storage|db|database|cache|s3|bucket)$/i;
const BOUNDARY_NAME = /(?:client|gateway|transport|socket|conn|connection|api|service|session)$/i;

function boundaryKind(name: string): DependencyKind | undefined {
  if (QUEUE_NAME.test(name)) return 'queue';
  if (STORAGE_NAME.test(name)) return 'storage';
  if (BOUNDARY_NAME.test(name)) return 'network';
  return undefined;
}

/** Runtime import/require specifiers; `import type` never signals. */
const IMPORT_STATEMENT =
  /(?:^|\n)\s*(?:import|export)\s+(type\s)?[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function runtimeSpecifiers(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(IMPORT_STATEMENT)) {
    if (match[1]) continue;
    const spec = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (spec) found.push(spec);
  }
  return found;
}

/** Comment- and string-only mentions must not signal (design: "where
 * practical") — a best-effort strip, not a parser. */
export function stripInert(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""');
}

function scanCode(content: string): PrefilterHint[] {
  const hints = new Map<string, PrefilterHint>();
  const add = (hint: PrefilterHint): void => {
    hints.set(`${hint.kind}\0${hint.source}\0${hint.token}`, hint);
  };
  for (const spec of runtimeSpecifiers(content)) {
    for (const [pattern, kind] of IMPORT_KINDS) {
      if (pattern.test(spec)) add({ kind, source: 'import', token: spec });
    }
  }
  const stripped = stripInert(content);
  for (const [pattern, kind, token] of CALL_TOKENS) {
    if (pattern.test(stripped)) add({ kind, source: 'call', token });
  }
  for (const match of stripped.matchAll(AWAITED_CALL)) {
    const kind = boundaryKind(match[1]!);
    if (kind) add({ kind, source: 'injected-boundary', token: match[1]! });
  }
  for (const match of stripped.matchAll(BOUNDARY_CTOR)) {
    const kind = boundaryKind(match[1]!);
    if (kind) add({ kind, source: 'injected-boundary', token: `new ${match[1]!}` });
  }
  return [...hints.values()];
}

export function classifyFile(path: string, content: string): SideSignals {
  if (IAC_EXT.test(path)) return { candidate: false, reason: 'IaC format, mechanically out of scope', hints: [] };
  if (INERT_EXT.test(path)) return { candidate: false, reason: 'non-executable format', hints: [] };
  if (!CODE_EXT.test(path)) {
    // Unknown source languages are candidates, never silently skipped.
    return { candidate: true, reason: 'unsupported syntax — judged without mechanical signals', hints: [] };
  }
  const hints = scanCode(content);
  return hints.length > 0
    ? { candidate: true, reason: 'external-dependency signals', hints }
    : { candidate: false, reason: 'no external-dependency signals', hints: [] };
}
