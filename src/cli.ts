#!/usr/bin/env node
// Dispatcher: argument parsing, check routing, output rendering, and the
// exit-code contract (ACA-0003 D3) — 0 advisory/pass, 1 enforce-fail, 2 usage,
// 78 enforce-without-credentials. Output is findings only (ACA-0003 D4).
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checks, type CheckLoader, type FileVerdict, type Violation } from './checks/registry.ts';
import { changedFiles, filterScope, repoRoot } from './core/change-scope.ts';
import { ConfigError, loadConfig, resolveTier } from './core/config.ts';
import { createJudgeClient, MissingCredentialsError, type JudgeClient } from './core/judge-client.ts';
import { VerdictCache } from './core/verdict-cache.ts';

export const EXIT = { ok: 0, fail: 1, usage: 2, noCredentials: 78 } as const;

export interface RunDeps {
  registry: ReadonlyMap<string, CheckLoader>;
  clientFactory: typeof createJudgeClient;
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const usage = (registry: ReadonlyMap<string, CheckLoader>): string =>
  `usage: aca <check> [paths...] [--enforce] [--json] [--base <ref>] [--self-test]
checks: ${[...registry.keys()].join(', ') || '(none registered yet)'}
  --enforce    exit 1 on any fail verdict (default: advisory, always exit 0)
  --json       machine-readable output
  --base       diff base ref (default: origin/main)
  --self-test  run the check's calibration fixtures (exit 1 on miss, 78 without credentials; honors --json)`;

export async function run(argv: string[], deps?: Partial<RunDeps>): Promise<number> {
  const d: RunDeps = {
    registry: checks,
    clientFactory: createJudgeClient,
    cwd: process.cwd(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    ...deps,
  };
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        enforce: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        base: { type: 'string', default: 'origin/main' },
        'self-test': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    d.stderr((err as Error).message);
    return EXIT.usage;
  }
  if (args.values.help) {
    d.stdout(usage(d.registry));
    return EXIT.ok;
  }
  const [checkName, ...paths] = args.positionals;
  if (!checkName) {
    d.stderr(usage(d.registry));
    return EXIT.usage;
  }
  const loader = d.registry.get(checkName);
  if (!loader) {
    d.stderr(`unknown check: ${checkName}`);
    return EXIT.usage;
  }

  const enforce = args.values.enforce;
  const selfTest = args.values['self-test'];
  try {
    const check = await loader();
    const root = repoRoot(d.cwd);
    const config = loadConfig(root);
    let client: JudgeClient;
    try {
      client = await d.clientFactory(resolveTier(config, check.tier));
    } catch (err) {
      if (err instanceof MissingCredentialsError) {
        d.stderr(`${check.name}: skipped — ${err.message}`);
        // A self-test without credentials cannot assert anything; exiting 0
        // would report a calibration that never ran.
        return enforce || selfTest ? EXIT.noCredentials : EXIT.ok;
      }
      throw err;
    }
    if (selfTest) {
      if (!check.selfTest) {
        d.stderr(`${check.name}: no self-test`);
        return EXIT.usage;
      }
      const result = await check.selfTest(client);
      if (args.values.json) {
        // Generic rendering of the check-local structural `report` (ACA-0012):
        // one object, no fixture contents, no prompts. Checks without a
        // report fall back to the shared contract's fields.
        const report = (result as { report?: unknown }).report;
        const body = typeof report === 'object' && report !== null ? report : { passed: result.passed, lines: result.lines };
        d.stdout(JSON.stringify({ check: check.name, provider: client.provider, model: client.model, ...body }));
      } else {
        for (const line of result.lines) d.stdout(line);
      }
      return result.passed ? EXIT.ok : EXIT.fail;
    }
    const files = paths.length > 0 ? paths : filterScope(changedFiles(args.values.base, root), config);
    const verdicts = await check.run({
      repoRoot: root,
      baseRef: args.values.base,
      files,
      client,
      cache: new VerdictCache(join(root, '.cache', 'aca'), check.name),
    });
    render(verdicts, { check: check.name, provider: client.provider, model: client.model, json: args.values.json }, d);
    return enforce && verdicts.some((v) => v.verdict === 'fail') ? EXIT.fail : EXIT.ok;
  } catch (err) {
    if (err instanceof ConfigError) {
      d.stderr(err.message);
      return EXIT.usage;
    }
    throw err;
  }
}

/** Render-local view of the optional nonblocking-debt field a check's
 * verdict subtype may carry (ACA-0013); the shared contract stays narrow. */
interface RenderedVerdict extends FileVerdict {
  residualViolations?: Violation[];
}

function render(
  verdicts: FileVerdict[],
  meta: { check: string; provider: string; model: string; json: boolean },
  d: RunDeps,
): void {
  if (meta.json) {
    d.stdout(JSON.stringify({ ...meta, json: undefined, verdicts }));
    return;
  }
  let residualFiles = 0;
  for (const v of verdicts as RenderedVerdict[]) {
    // The field is duck-typed, not part of the shared contract — a check
    // returning a malformed value must degrade to "no residuals", not crash.
    const residuals = Array.isArray(v.residualViolations) ? v.residualViolations : [];
    if (residuals.length > 0) residualFiles += 1;
    // A residual pass is a finding; only clean passes stay silent.
    if (v.verdict === 'pass' && residuals.length === 0) continue;
    const note = v.note ? ` (${v.note})` : '';
    d.stdout(`${v.file}: ${v.verdict}${note}`);
    for (const violation of v.violations) {
      d.stdout(`  ${violation.criterion}: ${violation.evidence} -> ${violation.suggestion}`);
    }
    for (const violation of residuals) {
      d.stdout(`  residual ${violation.criterion}: ${violation.evidence} -> ${violation.suggestion}`);
    }
  }
  const fails = verdicts.filter((v) => v.verdict === 'fail').length;
  const warns = verdicts.filter((v) => v.verdict === 'warn').length;
  const residual = residualFiles > 0 ? `, ${residualFiles} residual` : '';
  d.stdout(`${meta.check}: ${verdicts.length} file(s), ${fails} fail, ${warns} warn${residual}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await run(process.argv.slice(2)));
}
