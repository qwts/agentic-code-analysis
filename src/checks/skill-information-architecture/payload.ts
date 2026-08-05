// Canonical bounded judge payload. Whole resources are admitted in stable
// order; omitted content is named and never silently truncated.
import type { PackagePayload, SkillPackage, TaskEvidence } from './model.ts';

export const INPUT_CHAR_LIMIT = 120_000;
export const PAYLOAD_VERSION = 'skill-ia-payload-v1';

function frame(pkg: SkillPackage, evidence: TaskEvidence, resources: readonly { path: string; content: string }[], omissions: PackagePayload['omissions']): string {
  return JSON.stringify({
    packageId: pkg.packageId,
    packageDir: pkg.packageDir,
    skillFile: pkg.skillFile,
    basis: evidence.basis,
    metadata: { text: pkg.metadataText, estimatedTokens: pkg.metadataTokens },
    loads: pkg.loads,
    sections: pkg.sections.map(({ heading, level, start, end }) => ({ heading, level, start, end })),
    routes: pkg.routes,
    scenarios: evidence.scenarios,
    diagnostics: pkg.diagnostics,
    files: [{ path: pkg.skillFile, stage: 'activated-body', content: pkg.body }, ...resources.map((resource) => ({ ...resource, stage: 'on-demand-resource' }))],
    omissions,
  });
}

export function buildPayload(pkg: SkillPackage, evidence: TaskEvidence, limit = INPUT_CHAR_LIMIT): PackagePayload {
  const omissions: PackagePayload['omissions'][number][] = [];
  for (const resource of pkg.resources) {
    if (!resource.available) omissions.push({ path: resource.path, reason: 'unavailable', chars: resource.content.length });
    else if (resource.opaque) omissions.push({ path: resource.path, reason: 'opaque', chars: resource.content.length });
  }
  const available = pkg.resources.filter((resource) => resource.available && !resource.opaque);
  const included: { path: string; content: string }[] = [];
  let text = frame(pkg, evidence, included, omissions);
  if (text.length > limit) return { text, omissions, complete: false };
  for (const resource of available) {
    const candidate = [...included, { path: resource.path, content: resource.content }];
    const candidateText = frame(pkg, evidence, candidate, omissions);
    if (candidateText.length <= limit) {
      included.push({ path: resource.path, content: resource.content });
      text = candidateText;
    } else {
      omissions.push({ path: resource.path, reason: 'input-bound', chars: resource.content.length });
      text = frame(pkg, evidence, included, omissions);
    }
  }
  return { text, omissions, complete: omissions.length === 0 && pkg.complete };
}
