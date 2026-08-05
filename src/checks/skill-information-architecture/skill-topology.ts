// Deterministic whole-package projection over the public instruction-corpus
// facade. It deduplicates hosts, preserves per-profile activation, and joins
// file diagnostics before distinguishing empty from unavailable resources.
import { posix } from 'node:path';
import type { CorpusDiagnostic, InstructionBinding, InstructionCorpus, InstructionFile } from '../../corpora/instructions/index.ts';
import { routesOf, sectionsOf } from './markdown-structure.ts';
import type { SkillLoad, SkillPackage, SkillResource } from './model.ts';
import { isOpaqueResource } from './resource-kind.ts';

const isConvention = (binding: InstructionBinding, suffix: string): boolean => binding.convention.endsWith(`/skill-${suffix}`);

function uniqueLoads(root: InstructionFile): SkillLoad[] {
  const loads = root.bindings.flatMap((binding) => {
    const projection = isConvention(binding, 'metadata') ? 'metadata' : isConvention(binding, 'body') ? 'body' : undefined;
    return projection === undefined
      ? []
      : [{ profile: binding.profile, tool: binding.tool, convention: binding.convention, activation: binding.activation, projection, tokens: binding.charged.tokens.count } satisfies SkillLoad];
  });
  const byKey = new Map(loads.map((load) => [`${load.tool}\0${load.profile}\0${load.convention}\0${load.activation}\0${load.projection}\0${load.tokens}`, load]));
  return [...byKey.values()].sort((a, b) => `${a.profile}/${a.convention}`.localeCompare(`${b.profile}/${b.convention}`));
}

function fileDiagnostics(file: InstructionFile, diagnostics: readonly CorpusDiagnostic[]): CorpusDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.locator === file.locator);
}

function unavailable(diagnostics: readonly CorpusDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'warn' && /unread|oversiz|exceed|missing|not loaded|outside|contain|symlink|read/i.test(diagnostic.message));
}

function hasRouteCycle(skillFile: string, routes: readonly { sourcePath: string; resolvedPath?: string; status: string }[]): boolean {
  const edges = new Map<string, string[]>();
  for (const route of routes) {
    if (route.status !== 'resolved' || route.resolvedPath === undefined) continue;
    const list = edges.get(route.sourcePath) ?? [];
    list.push(route.resolvedPath);
    edges.set(route.sourcePath, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): boolean => {
    if (visiting.has(path)) return true;
    if (visited.has(path)) return false;
    visiting.add(path);
    for (const target of edges.get(path) ?? []) if (visit(target)) return true;
    visiting.delete(path);
    visited.add(path);
    return false;
  };
  return visit(skillFile) || [...edges.keys()].some(visit);
}

function resourceOf(file: InstructionFile, diagnostics: readonly CorpusDiagnostic[]): SkillResource {
  const own = fileDiagnostics(file, diagnostics);
  const available = !unavailable(own);
  const opaque = available && isOpaqueResource(file.path, file.content);
  return {
    path: file.path,
    locator: file.locator,
    content: file.content,
    available,
    opaque,
    ...(!opaque && available ? { potentialTokens: file.fullFile.count } : {}),
    diagnostics: own.map((diagnostic) => diagnostic.message),
  };
}

function bodyBinding(root: InstructionFile): InstructionBinding | undefined {
  return root.bindings.find((binding) => isConvention(binding, 'body'));
}

function metadataBinding(root: InstructionFile): InstructionBinding | undefined {
  return root.bindings.find((binding) => isConvention(binding, 'metadata'));
}

export function buildSkillPackages(corpus: InstructionCorpus): SkillPackage[] {
  const roots = corpus.files.filter(
    (file) => file.origin === 'repo' && posix.basename(file.path) === 'SKILL.md' && file.bindings.some((binding) => isConvention(binding, 'body')),
  );
  return roots.map((root) => {
    const packageDir = posix.dirname(root.path);
    const resourceFiles = corpus.files.filter(
      (file) =>
        file.origin === 'repo' &&
        file.path.startsWith(`${packageDir}/`) &&
        file.path !== root.path &&
        file.bindings.some((binding) => isConvention(binding, 'resource')),
    );
    const resources = resourceFiles.map((file) => resourceOf(file, corpus.diagnostics)).sort((a, b) => a.path.localeCompare(b.path));
    const members = new Set([root.path, ...resources.map((resource) => resource.path)]);
    const body = bodyBinding(root)?.charged.text ?? '';
    const metadata = metadataBinding(root);
    const relevantDiagnostics = corpus.diagnostics.filter(
      (diagnostic) => diagnostic.locator === root.locator || resources.some((resource) => resource.locator === diagnostic.locator),
    );
    const routes = [
      ...routesOf(root.path, body, packageDir, members),
      ...resources.flatMap((resource) => (resource.available && !resource.opaque ? routesOf(resource.path, resource.content, packageDir, members) : [])),
    ];
    const rootVerified = root.bindings.some((binding) => isConvention(binding, 'body') && binding.semantics.status === 'verified');
    const complete =
      rootVerified &&
      relevantDiagnostics.every((diagnostic) => diagnostic.severity !== 'warn') &&
      resources.every((resource) => resource.available) &&
      routes.every((route) => !['missing', 'escapes-package'].includes(route.status)) &&
      !hasRouteCycle(root.path, routes);
    return {
      packageId: `repo:${packageDir}`,
      packageDir,
      skillFile: root.path,
      locator: root.locator,
      body,
      bodyTokens: bodyBinding(root)?.charged.tokens.count ?? 0,
      metadataText: metadata?.charged.text ?? '',
      metadataTokens: metadata?.charged.tokens.count ?? 0,
      sections: sectionsOf(body),
      routes,
      loads: uniqueLoads(root),
      resources,
      diagnostics: relevantDiagnostics,
      complete,
    };
  }).sort((a, b) => a.packageId.localeCompare(b.packageId));
}

export function selectSkillPackages(packages: readonly SkillPackage[], targets: readonly string[], sidecarPath: string): SkillPackage[] {
  if (targets.some((target) => target === sidecarPath || target === '.aca')) return [...packages];
  return packages.filter((pkg) =>
    targets.some((raw) => {
      const target = raw === '.' ? '' : posix.normalize(raw.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, ''));
      if (target === '') return true;
      return target === pkg.skillFile || target === pkg.packageDir || target.startsWith(`${pkg.packageDir}/`) || pkg.packageDir.startsWith(`${target}/`);
    }),
  );
}
