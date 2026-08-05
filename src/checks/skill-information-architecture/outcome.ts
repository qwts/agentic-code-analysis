// Host verification and measurement derivation for judge replies. Every path,
// span, action, scenario, edit, and number is proven locally before a finding
// can fail the check or enter the verdict cache.
import { posix } from 'node:path';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { TokenEstimator } from '../../corpora/instructions/index.ts';
import type { Violation } from '../registry.ts';
import { sectionsOf } from './markdown-structure.ts';
import { routesOf } from './markdown-structure.ts';
import type { Action, Criterion, MeasurementSeed, PackagePayload, ProposedEdit, SkillPackage, TaskEvidence, TopologyDelta, VerifiedFinding } from './model.ts';
import { ACTIONS, ASSESSMENTS, CRITERIA, type JudgeFinding, type JudgeReply, type SkillInformationArchitectureVerdict } from './judge-io.ts';

function isReply(value: unknown): value is JudgeReply {
  const reply = value as JudgeReply;
  return typeof reply === 'object' && reply !== null && (ASSESSMENTS as readonly string[]).includes(reply.assessment) &&
    typeof reply.reasoning_summary === 'string' && Array.isArray(reply.findings) && reply.findings.every((finding) =>
      typeof finding === 'object' && finding !== null && (CRITERIA as readonly string[]).includes(finding.criterion) &&
      typeof finding.source_path === 'string' && typeof finding.heading === 'string' && typeof finding.excerpt === 'string' &&
      Array.isArray(finding.scenario_ids) && finding.scenario_ids.every((id) => typeof id === 'string') &&
      (ACTIONS as readonly string[]).includes(finding.action) && typeof finding.destination_path === 'string' &&
      typeof finding.destination_section === 'string' && typeof finding.proposal_text === 'string' &&
      Array.isArray(finding.preserve) && finding.preserve.every((span) => typeof span === 'string') && typeof finding.rationale === 'string');
}

function uniqueOffset(content: string, excerpt: string): number | undefined {
  if (excerpt === '') return undefined;
  const first = content.indexOf(excerpt);
  if (first === -1 || content.indexOf(excerpt, first + 1) !== -1) return undefined;
  return first;
}

function sourceContent(pkg: SkillPackage, path: string): string | undefined {
  if (path === pkg.skillFile) return pkg.body;
  return pkg.resources.find((resource) => resource.path === path && resource.available && !resource.opaque)?.content;
}

function compatible(criterion: Criterion, action: Action): boolean {
  if (criterion === 'buried-core-guidance') return action === 'move-earlier';
  if (criterion === 'fragmented-core-workflow') return action === 'co-locate' || action === 'inline-core';
  if (criterion === 'eager-specialist-detail') return action === 'extract-resource';
  return action === 'add-route';
}

function destination(pkg: SkillPackage, raw: string): string | undefined {
  if (raw.trim() === '' || raw.startsWith('/') || raw.includes('\\') || raw.endsWith('/')) return undefined;
  const normalized = posix.normalize(raw.startsWith(pkg.packageDir) ? raw : posix.join(pkg.packageDir, raw));
  return normalized.startsWith(`${pkg.packageDir}/`) ? normalized : undefined;
}

function placementGrounded(finding: JudgeFinding, evidence: TaskEvidence): boolean {
  if (finding.criterion !== 'buried-core-guidance' && finding.criterion !== 'eager-specialist-detail') return true;
  if (finding.scenario_ids.length === 0) return false;
  return finding.scenario_ids.every((id) => {
    const scenario = evidence.scenarios.find((candidate) => candidate.id === id);
    return scenario !== undefined && (scenario.frequency !== undefined || scenario.value !== undefined || scenario.critical);
  });
}

function proposedRouteResolves(finding: JudgeFinding, pkg: SkillPackage, dest: string): boolean {
  if (finding.action !== 'add-route' && finding.action !== 'extract-resource') return true;
  const members = new Set([pkg.skillFile, dest, ...pkg.resources.map((resource) => resource.path)]);
  return routesOf(pkg.skillFile, finding.proposal_text, pkg.packageDir, members).some(
    (route) => route.status === 'resolved' && (finding.action !== 'extract-resource' || route.resolvedPath === dest),
  );
}

function conditionalTokens(pkg: SkillPackage, evidence: TaskEvidence): number {
  const read = new Set(evidence.scenarios.flatMap((scenario) => [...scenario.expectedResources, ...scenario.observedReads]));
  return pkg.resources.filter((resource) => read.has(resource.path)).reduce((sum, resource) => sum + (resource.potentialTokens ?? 0), 0);
}

function affectedScenarios(finding: JudgeFinding, evidence: TaskEvidence) {
  return finding.scenario_ids.map((id) => evidence.scenarios.find((scenario) => scenario.id === id)).filter((scenario) => scenario !== undefined);
}

function severityOf(finding: JudgeFinding, evidence: TaskEvidence): VerifiedFinding['severity'] {
  const scenarios = affectedScenarios(finding, evidence);
  if (scenarios.some((scenario) => scenario.critical || (scenario.value ?? 0) >= 8 || (scenario.frequency ?? 0) >= 0.5)) return 'high';
  if (scenarios.length > 0 || finding.criterion === 'weak-disclosure-route' || finding.criterion === 'fragmented-core-workflow') return 'medium';
  return 'low';
}

function affectedPercent(finding: JudgeFinding, evidence: TaskEvidence): number | undefined {
  const weighted = evidence.scenarios.filter((scenario) => scenario.frequency !== undefined);
  const total = weighted.reduce((sum, scenario) => sum + scenario.frequency!, 0);
  if (total <= 0 || finding.scenario_ids.length === 0) return undefined;
  const affected = weighted.filter((scenario) => finding.scenario_ids.includes(scenario.id)).reduce((sum, scenario) => sum + scenario.frequency!, 0);
  return Math.round((affected / total) * 10_000) / 100;
}

function derive(finding: JudgeFinding, pkg: SkillPackage, evidence: TaskEvidence, estimator: TokenEstimator, dest: string): { finding: VerifiedFinding; offset: number } {
  const before = pkg.bodyTokens;
  const conditionalBefore = conditionalTokens(pkg, evidence);
  const excerptTokens = estimator.estimate(finding.excerpt);
  const proposalTokens = estimator.estimate(finding.proposal_text);
  let after = before;
  let conditionalAfter = conditionalBefore;
  let opens = 0;
  const edits: ProposedEdit[] = [];
  if (finding.action === 'extract-resource') {
    after = Math.max(0, before - excerptTokens + proposalTokens);
    conditionalAfter += excerptTokens;
    opens = Math.max(1, finding.scenario_ids.length);
    edits.push({ operation: 'replace', path: finding.source_path, excerpt: finding.excerpt, replacement: finding.proposal_text });
    edits.push({ operation: 'add', path: dest, excerpt: '', replacement: finding.excerpt });
  } else if (finding.action === 'co-locate' || finding.action === 'inline-core') {
    if (finding.source_path !== pkg.skillFile) {
      after += proposalTokens;
      conditionalAfter = Math.max(0, conditionalBefore - excerptTokens);
      opens = -Math.max(1, finding.scenario_ids.length);
      edits.push({ operation: 'delete', path: finding.source_path, excerpt: finding.excerpt, replacement: '' });
      edits.push({ operation: 'add', path: pkg.skillFile, excerpt: '', replacement: finding.proposal_text });
    } else {
      edits.push({ operation: 'replace', path: pkg.skillFile, excerpt: finding.excerpt, replacement: finding.proposal_text });
      after = Math.max(0, before - excerptTokens + proposalTokens);
    }
  } else if (finding.action === 'add-route') {
    after += proposalTokens;
    edits.push({ operation: 'add', path: pkg.skillFile, excerpt: '', replacement: finding.proposal_text });
  } else {
    edits.push({ operation: 'delete', path: pkg.skillFile, excerpt: finding.excerpt, replacement: '' });
    edits.push({ operation: 'add', path: pkg.skillFile, excerpt: '', replacement: finding.proposal_text });
    after = Math.max(0, before - excerptTokens + proposalTokens);
  }
  const delta: TopologyDelta = {
    activatedBodyTokensBefore: before,
    activatedBodyTokensAfter: after,
    conditionalTokensBefore: conditionalBefore,
    conditionalTokensAfter: conditionalAfter,
    resourceOpensDelta: opens,
  };
  return {
    offset: uniqueOffset(sourceContent(pkg, finding.source_path)!, finding.excerpt)!,
    finding: {
      criterion: finding.criterion,
      severity: severityOf(finding, evidence),
      sourcePath: finding.source_path,
      heading: finding.heading,
      excerpt: finding.excerpt,
      scenarioIds: [...new Set(finding.scenario_ids)],
      action: finding.action,
      destinationPath: dest,
      destinationSection: finding.destination_section,
      proposalText: finding.proposal_text,
      preserve: finding.preserve,
      rationale: finding.rationale,
      ...(affectedPercent(finding, evidence) !== undefined ? { affectedScenarioPercent: affectedPercent(finding, evidence) } : {}),
      delta,
      edits,
    },
  };
}

function seeds(evidence: TaskEvidence): MeasurementSeed[] {
  return evidence.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    cohort: scenario.critical ? 'critical' : scenario.frequency !== undefined && scenario.frequency >= 0.5 ? 'common' : scenario.frequency !== undefined ? 'specialist' : 'unspecified',
    expectedResources: scenario.expectedResources,
    metrics: ['task-success', 'activated-body-tokens', 'total-loaded-tokens', 'resource-opens', 'required-read-recall', 'unnecessary-read-rate', 'success-per-1k-loaded-tokens'],
  }));
}

function impact(finding: VerifiedFinding, evidence: TaskEvidence): number {
  const scenarios = finding.scenarioIds.map((id) => evidence.scenarios.find((scenario) => scenario.id === id)).filter((scenario) => scenario !== undefined);
  return Math.max(0, ...scenarios.map((scenario) => (scenario.critical ? 10_000 : 0) + (scenario.frequency ?? 0) * 100 + (scenario.value ?? 0)));
}

export function judgeOutcome(
  pkg: SkillPackage,
  evidence: TaskEvidence,
  payload: PackagePayload,
  result: JudgeResult,
  estimator: TokenEstimator,
): { verdict: SkillInformationArchitectureVerdict; cacheable: boolean } {
  const base = {
    file: pkg.skillFile,
    cached: false,
    basis: evidence.basis,
    packageId: pkg.packageId,
    packageDir: pkg.packageDir,
    currentTopology: topology(pkg),
    omissions: payload.omissions,
    composition: compositionNote(),
  } as const;
  const degraded = (note: string) => ({ verdict: { ...base, verdict: 'warn' as const, violations: [], note }, cacheable: false });
  if (!result.ok) return degraded(result.note);
  if (!isReply(result.verdict)) return degraded('judge output failed schema parse');
  const reply = result.verdict;
  if (!payload.complete) return degraded('incomplete package evidence cannot support a semantic assessment');
  if (reply.assessment === 'well-structured' && reply.findings.length > 0) return degraded('judge passed while naming findings');
  if (reply.assessment === 'uncertain' && reply.findings.length > 0) return degraded('judge returned uncertain with findings');
  if (reply.assessment === 'needs-restructure' && reply.findings.length === 0) return degraded('judge failed without a patchable finding');
  if (reply.findings.some((finding) => !placementGrounded(finding, evidence))) {
    return degraded('frequency-dependent placement claim has no workload evidence');
  }
  if (reply.assessment === 'uncertain') {
    return { verdict: { ...base, verdict: 'warn', violations: [], assessment: 'uncertain', measurementSeed: seeds(evidence), note: reply.reasoning_summary }, cacheable: true };
  }
  if (reply.assessment === 'well-structured') {
    return { verdict: { ...base, verdict: 'pass', violations: [], assessment: 'well-structured', proposedTopology: topology(pkg), findings: [], edits: [], measurementSeed: seeds(evidence) }, cacheable: true };
  }

  const scenarioIds = new Set(evidence.scenarios.map((scenario) => scenario.id));
  const verified: { finding: VerifiedFinding; offset: number }[] = [];
  const ranges = new Map<string, [number, number][]>();
  for (const finding of reply.findings) {
    const content = sourceContent(pkg, finding.source_path);
    if (content === undefined) return degraded(`finding source is unavailable or outside package: ${finding.source_path}`);
    const offset = uniqueOffset(content, finding.excerpt);
    if (offset === undefined) return degraded(`finding excerpt is not verbatim-and-unambiguous in ${finding.source_path}`);
    const containing = sectionsOf(content).find((section) => offset >= section.start && offset < section.end);
    if (containing === undefined || containing.heading !== finding.heading) return degraded(`finding heading does not contain its excerpt in ${finding.source_path}`);
    if (!compatible(finding.criterion, finding.action)) return degraded(`action ${finding.action} is incompatible with ${finding.criterion}`);
    if (finding.scenario_ids.some((id) => !scenarioIds.has(id))) return degraded('finding names an unknown scenario id');
    if (finding.proposal_text.trim() === '' || finding.rationale.trim() === '') return degraded('finding is not patchable');
    const dest = destination(pkg, finding.destination_path);
    if (dest === undefined) return degraded(`finding destination escapes or omits package: ${finding.destination_path}`);
    if ((finding.action === 'co-locate' || finding.action === 'inline-core' || finding.action === 'move-earlier' || finding.action === 'add-route') && dest !== pkg.skillFile) return degraded(`${finding.action} must target ${pkg.skillFile}`);
    if (finding.action === 'extract-resource' && dest === pkg.skillFile) return degraded('extract-resource must target an on-demand resource');
    if (!proposedRouteResolves(finding, pkg, dest)) return degraded(`${finding.action} proposal does not contain a resolvable disclosure route`);
    for (const span of finding.preserve) {
      if (span.trim() === '' || uniqueOffset(content, span) === undefined) return degraded('preservation span is not unique in the finding source');
      const spanOffset = uniqueOffset(content, span)!;
      const insideReplacedExcerpt = spanOffset >= offset && spanOffset + span.length <= offset + finding.excerpt.length;
      if (insideReplacedExcerpt && finding.action !== 'extract-resource' && !finding.proposal_text.includes(span)) return degraded('proposal drops a required preservation span');
    }
    const end = offset + finding.excerpt.length;
    const prior = ranges.get(finding.source_path) ?? [];
    if (prior.some(([start, stop]) => offset < stop && end > start)) return degraded('findings propose overlapping source edits');
    prior.push([offset, end]);
    ranges.set(finding.source_path, prior);
    verified.push(derive(finding, pkg, evidence, estimator, dest));
  }
  verified.sort((a, b) => impact(b.finding, evidence) - impact(a.finding, evidence) || a.finding.sourcePath.localeCompare(b.finding.sourcePath) || a.offset - b.offset);
  const findings = verified.map((entry) => entry.finding);
  const violations: Violation[] = findings.map((finding) => ({
    criterion: `${finding.criterion} [${finding.severity}]`,
    evidence: `${finding.sourcePath}#${finding.heading}: ${finding.excerpt.length > 90 ? `${finding.excerpt.slice(0, 90)}…` : finding.excerpt}; affects ${finding.scenarioIds.join(', ') || 'cohesion only'}; ${finding.rationale}`,
    suggestion: `${finding.action} → ${finding.destinationPath}#${finding.destinationSection}: ${finding.proposalText.length > 90 ? `${finding.proposalText.slice(0, 90)}…` : finding.proposalText} (body ~${finding.delta.activatedBodyTokensBefore}→~${finding.delta.activatedBodyTokensAfter}, conditional ~${finding.delta.conditionalTokensBefore}→~${finding.delta.conditionalTokensAfter}, opens ${finding.delta.resourceOpensDelta >= 0 ? '+' : ''}${finding.delta.resourceOpensDelta})`,
  }));
  const edits = findings.flatMap((finding) => finding.edits);
  return {
    cacheable: true,
    verdict: {
      ...base,
      verdict: 'fail',
      violations,
      assessment: 'needs-restructure',
      proposedTopology: { edits, deltas: findings.map((finding) => finding.delta) },
      findings,
      edits,
      measurementSeed: seeds(evidence),
      note: reply.reasoning_summary,
    },
  };
}

function topology(pkg: SkillPackage): unknown {
  return {
    skillFile: pkg.skillFile,
    metadataTokens: pkg.metadataTokens,
    activatedBodyTokens: pkg.bodyTokens,
    sections: pkg.sections.map(({ heading, level }) => ({ heading, level })),
    loads: pkg.loads,
    resources: pkg.resources.map(({ path, available, opaque, potentialTokens }) => ({ path, available, opaque, potentialTokens })),
    routes: pkg.routes,
    complete: pkg.complete,
  };
}

function compositionNote(): string {
  return 'Apply verified placement edits first; then rerun skill-information-architecture and agent-context-cost before any density rewrite.';
}
