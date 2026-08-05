#!/usr/bin/env node

// Pre-execution command hook for every agent harness in the fleet.
//
// The wrapper (run-guarded.mjs) is the primary control; this hook exists to
// close the ways around it. It covers Claude Code, Cursor AND Codex, because a
// guard only one harness honours does not solve a problem that Codex sessions
// caused half of.
//
// It denies four things:
//   1. Heavy local suites, for agents — the lanes that
//      actually bricked the machine (`npm run ci`, e2e, storybook, perf, cov).
//   2. Direct test-binary invocations that skip the wrapper entirely.
//   3. Tampering with the guard's own controls: the human escape hatch, the
//      assume-human override, and redirecting the state directory (which would
//      hand the session a private lease namespace and undo machine scoping).
//   4. Legacy grant commands, which cannot authenticate a human when the
//      agent shares the same OS user.
//
// Scoping: only commands that execute inside a guarded checkout are policed;
// cross-repo work from the same session is left alone. Blocked text inside
// quotes or heredocs is a mention (a commit message, a grep pattern), not an
// invocation — except nested shell payloads (`bash -c "…"`), which are
// executable and are unwrapped and scanned.
//
// Fail-open by design: a malformed payload allows the command rather than
// bricking every shell call.
//
// Protocols: --protocol=claude | cursor | codex

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { HEAVY_LANES } from './lib/policy.mjs';

const GUARD_GUIDE = 'https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-memory-guard.md';

// Two different blocks need two different next steps, and a refusal whose
// advice does not fit is one an agent argues with instead of following.
const GUIDANCE =
  'Push the branch and let GitHub CI verify — CI is the authoritative lane and is exempt from this guard. ' +
  `See ${GUARD_GUIDE}.`;

// A direct binary is not necessarily a heavy run — in a tooling repo `node
// --test` is the light, normal path. What is wrong with it is that it skips
// the wrapper, so the fix is the repo's own guarded entrypoint, not CI.
const USE_ENTRYPOINT =
  "Use a repository-documented guarded npm test entrypoint instead (normally `npm test`); it must wrap " +
  'tools/agent-guard/run-guarded.mjs, which derives a ceiling from this machine and checks the machine-wide ' +
  `memory budget first. See ${GUARD_GUIDE}.`;

// Markers that identify a checkout governed by this policy. The second is the
// pre-rollout location, so a repo mid-migration is still policed.
const GUARD_MARKERS = ['tools/agent-guard/run-guarded.mjs', 'scripts/run-guarded.mjs'];

const BLOCKED = [
  {
    // Electron-hosted node:test (image-trail's original incident path).
    pattern: /\belectron\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `electron --test` invocation',
  },
  {
    pattern: /\bnode\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `node --test` invocation',
  },
  {
    pattern: /\bnode\b[^\n;&|]*\.test-dist(-dom)?\b/u,
    what: 'direct execution of compiled tests in .test-dist(-dom)',
  },
  {
    pattern: /^(?:\S*\/)?node\s+(?:-\S+\s+)*\S*\/vitest(?:\/vitest)?\.mjs(?:\s|$)/u,
    what: 'direct execution of the Vitest Node entry module',
  },
  {
    pattern: /\bplaywright\s+test\b/u,
    what: 'direct Playwright invocation',
  },
  {
    pattern: /\btest-storybook\b/u,
    what: 'direct Storybook test-runner invocation',
  },
  {
    pattern: /^(?:(?:time|command)\s+|env\s+(?:\w+=\S*\s+)*)*(?:\w+=\S*\s+)*(?:\S*\/)?(?:npx(?:\s+-\S+)*\s+)?(?:\S*\/)?vitest(?:\s|$)/u,
    what: 'direct Vitest invocation',
  },
  {
    pattern: /^(?:(?:time|command)\s+|env\s+(?:\w+=\S*\s+)*)*(?:\w+=\S*\s+)*(?:\S*\/)?(?:npx(?:\s+-\S+)*\s+)?(?:\S*\/)?c8(?:\s|$)/u,
    what: 'direct c8 coverage invocation',
  },
  {
    pattern: /^(?:(?:time|command)\s+|env\s+(?:\w+=\S*\s+)*)*(?:\w+=\S*\s+)*(?:\S*\/)?npm\s+(?:exec|x)\s+(?:-\S+\s+)*(?:\S*\/)?(?:vitest|c8|playwright|test-storybook)(?:\s|$)/u,
    what: 'direct test-binary invocation through npm exec',
  },
  {
    // Headed/interactive runs open GUI windows on the shared desktop.
    pattern: /\bnpm\s+run\s+test:e2e:(ui|headed)(?![\w:-])/u,
    what: 'headed/interactive e2e run',
    reason:
      "Blocked headed/interactive e2e run: GUI windows on the shared desktop steal the owner's focus, " +
      'and each one boots a full Electron app. These scripts are human-only.',
  },
];

// Controls an agent must not touch. Checked before the run-guarded allowlist so
// `AGENT_GUARD_FORCE=1 node tools/agent-guard/run-guarded.mjs …` cannot slip
// through as a sanctioned run.
const TAMPERING = [
  {
    pattern: /(?:^|[\s;&|])(?:CI|GITHUB_ACTIONS|CONTINUOUS_INTEGRATION|BUILDKITE|GITLAB_CI|JENKINS_URL)=/u,
    reason:
      'Blocked a command-local CI marker: hosted CI is exempt from admission because its runner is isolated, but a ' +
      `local command cannot grant itself that exemption. Remove the assignment and use the guarded entrypoint. ${GUIDANCE}`,
  },
  {
    pattern: /\bAGENT_GUARD_FORCE=/u,
    reason:
      'Blocked AGENT_GUARD_FORCE: overriding admission control is a human-only escape hatch. A refused run means the ' +
      `machine does not have the memory right now — report the refusal instead of forcing past it. ${GUIDANCE}`,
  },
  {
    pattern: /\bAGENT_GUARD_ASSUME_HUMAN=/u,
    reason:
      'Blocked AGENT_GUARD_ASSUME_HUMAN: this override exists so a human in an editor terminal is not mistaken for an ' +
      `agent. An agent setting it is claiming to be the owner. ${GUIDANCE}`,
  },
  {
    pattern: /\bAGENT_GUARD_STATE_DIR=/u,
    reason:
      'Blocked AGENT_GUARD_STATE_DIR: redirecting the lease directory gives this session a private budget that no other ' +
      'repo or agent can see — which is exactly the per-worktree bug this guard replaced. It is for tests only.',
  },
  {
    pattern: /\barbiter\.mjs\s+grant\b/u,
    reason:
      'Blocked `arbiter.mjs grant`: same-user local grants cannot authenticate human approval and are disabled. ' +
      'The owner can run the lane directly from their own terminal, or the agent can use GitHub CI.',
  },
  {
    // The wrapper sets this for its own children so nested guarded scripts do
    // not deadlock. Supplied from outside it is a claim to already be inside a
    // guarded run — which would skip the lease, the ceiling and the headroom
    // check entirely. The wrapper independently refuses to honour a value that
    // does not name a live lease; this is the outer half of that pair.
    pattern: /\bAGENT_GUARDED=/u,
    reason:
      'Blocked AGENT_GUARDED: that marker is set by the guard for its own children, and supplying it by hand claims to ' +
      `be inside a guarded run that does not exist — skipping admission entirely. ${GUIDANCE}`,
  },
  {
    pattern:
      /(?:\benv\b[^\n;&|]*(?:\s(?:-i|--ignore-environment)(?=\s|$)|(?:-u|--unset)(?:=|\s+)(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|AI_AGENT|CODEX_\w+|CURSOR_\w+))|\b(?:unset|export\s+-n)\s+(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|AI_AGENT|CODEX_\w+|CURSOR_\w+))[\s\S]*run-guarded\.mjs/u,
    reason:
      'Blocked removal of agent identity before run-guarded.mjs: the wrapper must inherit its harness markers so it ' +
      `cannot misclassify an agent as the human owner. ${GUIDANCE}`,
  },
];

// Shell segments, so a sanctioned command in one segment cannot vouch for a
// blocked one in the next. Quotes are already blanked by stripInertText, so
// these separators are structural rather than incidental text.
export function splitSegments(command) {
  const REDIRECTION_AMPERSAND = '\0';
  const ESCAPED_SEMICOLON = '\u0001';
  const ESCAPED_AMPERSAND = '\u0002';
  const ESCAPED_PIPE = '\u0003';
  return command
    .replace(/\\;/gu, ESCAPED_SEMICOLON)
    .replace(/\\&/gu, ESCAPED_AMPERSAND)
    .replace(/\\\|/gu, ESCAPED_PIPE)
    .replace(/(\d*>)&(?=\d|-)/gu, `$1${REDIRECTION_AMPERSAND}`)
    .replace(/&(?=>>?)/gu, REDIRECTION_AMPERSAND)
    .split(/\|\||&&|[;\n|&]/u)
    .map((segment) => {
      let normalized = segment
        .replaceAll(REDIRECTION_AMPERSAND, '&')
        .replaceAll(ESCAPED_SEMICOLON, '\\;')
        .replaceAll(ESCAPED_AMPERSAND, '\\&')
        .replaceAll(ESCAPED_PIPE, '\\|')
        .trim();
      // Parentheses that wrap a subshell are control operators, not part of
      // its executable or final argument. Remove balanced outer wrappers so
      // `(npm run ci)` classifies exactly like `npm run ci`.
      while (/^[({]\s*/u.test(normalized)) normalized = normalized.replace(/^[({]\s*/u, '');
      normalized = normalized.replace(/[)}]+(?=\s*(?:$|\d*[<>]))/gu, '').trim();
      return normalized;
    })
    .filter(Boolean);
}

// A segment that IS a wrapper invocation: optional env assignments, then node
// (however it is pathed), then run-guarded.mjs as its script argument. Merely
// mentioning the filename elsewhere in the segment does not qualify.
const ANY_WRAPPER_SEGMENT = /^(?:\w+=\S*\s+)*(?:\S*\/)?node\s+(?:-\S+\s+)*\S*run-guarded\.mjs(?:\s|$)/u;
const WRAPPER_SEGMENT = /^(?:\w+=\S*\s+)*(?:\S*\/)?node\s+(?:-\S+\s+)*(?:\.\/)?(?:tools\/agent-guard|scripts)\/run-guarded\.mjs(?:\s|$)/u;

function tryRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function isWithin(child, parent) {
  const c = tryRealpath(child);
  const p = tryRealpath(parent);
  return c === p || c.startsWith(p + sep);
}

function scopeWords(text) {
  return [...text.matchAll(/\$'(?:[^'\\]|\\.)*'|'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s]+)/gu)].map((match) => ({
    index: match.index,
    value: match[1] ?? match[2]?.replace(/\\(["\\$`])/gu, '$1') ?? match[3] ?? decodeAnsiCWord(match[0]),
  }));
}

function prefixReaches(words, index) {
  const marker = '__agent_guard_scope_command__';
  return commandAfterPrefixes([...words.slice(0, index).map((word) => word.value), marker].join(' ')) === marker;
}

function directoryOptionTargets(segment) {
  const words = scopeWords(segment);
  const targets = [];
  for (let index = 0; index < words.length; index += 1) {
    const executable = words[index].value.split('/').at(-1);
    const corepackProxy = index > 0 && words[index - 1].value.split('/').at(-1) === 'corepack' && prefixReaches(words, index - 1);
    if (executable === 'env' && prefixReaches(words, index)) {
      let envTarget;
      for (let optionAt = index + 1; optionAt < words.length; optionAt += 1) {
        const option = words[optionAt].value;
        if (option === '-C' || option === '--chdir') {
          if (words[optionAt + 1]) envTarget = words[++optionAt].value;
        } else if (option.startsWith('--chdir=')) {
          envTarget = option.slice('--chdir='.length);
        } else if (/^-C.+/u.test(option)) {
          envTarget = option.slice(2);
        } else if (/^(?:-u|--unset|-P|--path|-S|--split-string)$/u.test(option)) {
          optionAt += 1;
        } else if (option === '--') {
          break;
        } else if (!option.startsWith('-') && !/^\w+=/u.test(option)) {
          break;
        }
      }
      if (envTarget) targets.push({ index: words[index].index, target: envTarget });
    }
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable) || (!prefixReaches(words, index) && !corepackProxy)) continue;
    const options =
      executable === 'npm'
        ? { equals: ['--prefix='], operands: new Set(['--prefix', '-C']) }
        : executable === 'pnpm'
          ? { equals: ['--dir='], operands: new Set(['--dir', '-C']) }
          : { equals: ['--cwd='], operands: new Set(['--cwd']) };
    let packageTarget;
    for (let optionAt = index + 1; optionAt < words.length; optionAt += 1) {
      const option = words[optionAt].value;
      if (option === '--') break;
      if (options.operands.has(option)) {
        if (words[optionAt + 1]) packageTarget = words[++optionAt].value;
        continue;
      }
      const equals = options.equals.find((prefix) => option.startsWith(prefix));
      if (equals) packageTarget = option.slice(equals.length);
      if ((executable === 'npm' || executable === 'pnpm') && /^-C.+/u.test(option)) {
        packageTarget = option.slice(2);
      }
    }
    if (packageTarget) targets.push({ index: words[index].index, target: packageTarget });
  }
  return targets;
}

// Every directory a command may execute in. Retaining the reported cwd is
// deliberate: a `cd` inside `( ... )` does not change its parent shell, while
// a later top-level transition does. For hook scoping, the safe answer is the
// union of observed scopes rather than guessing one final directory.
export function resolveExecutionDirs(cwd, command) {
  if (typeof cwd !== 'string' || cwd.length === 0) return [];
  if (typeof command !== 'string') return [cwd];
  const directories = [cwd];
  let current = cwd;
  const parentScopes = [];
  const events = [];

  // A subshell inherits its parent's cwd but cannot change it. Record both the
  // child scopes and the restored parent scope so a later relative `cd` is
  // resolved from the directory the shell will actually use.
  const shellSyntax = new Uint8Array(command.length);
  const contexts = [{ mode: 'shell', closesSubshell: false }];
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const context = contexts.at(-1);
    if (context.mode === 'single-quote') {
      if (character === "'") contexts.pop();
      continue;
    }
    if (context.mode === 'double-quote') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') {
        contexts.pop();
        continue;
      }
      if (character === '$' && command[index + 1] === '(') {
        events.push({ index: index + 1, type: 'subshell-open' });
        contexts.push({ mode: 'shell', closesSubshell: true });
        index += 1;
      }
      continue;
    }
    shellSyntax[index] = 1;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      contexts.push({ mode: 'single-quote' });
      continue;
    }
    if (character === '"') {
      contexts.push({ mode: 'double-quote' });
      continue;
    }
    if (character === '(') {
      events.push({ index, type: 'subshell-open' });
      contexts.push({ mode: 'shell', closesSubshell: true });
      continue;
    }
    if (character === ')' && context.closesSubshell) {
      events.push({ index, type: 'subshell-close' });
      contexts.pop();
    }
  }

  const transitions = /(?:^|\|\||&&|[;\n|&(){}])\s*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|(){}]+))/gu;
  for (const match of command.matchAll(transitions)) {
    const index = match.index + match[0].indexOf('cd');
    if (shellSyntax[index]) events.push({ index, target: match[1] ?? match[2] ?? match[3], type: 'cd' });
  }

  // GNU/POSIX-compatible env implementations may change directory for the
  // child command with `-C` or `--chdir`. This scope does not persist in the
  // parent shell, so record it without updating `current`.
  const envCommands = /(?:^|\|\||&&|[;\n|&(){}])\s*(?:\S*\/)?env(?=\s|$)([^;\n|&(){}]*)/gu;
  for (const match of command.matchAll(envCommands)) {
    const envIndex = match.index + match[0].indexOf('env');
    if (!shellSyntax[envIndex]) continue;
    const words = [...match[1].matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map((word) => word[1] ?? word[2] ?? word[3]);
    let chdirTarget;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (word === '-C' || word === '--chdir') {
        chdirTarget = words[index + 1];
        index += 1;
      } else if (word.startsWith('--chdir=')) {
        chdirTarget = word.slice('--chdir='.length);
      } else if (/^-C.+/u.test(word)) {
        chdirTarget = word.slice(2);
      } else if (/^(?:-u|--unset|-P|--path)$/u.test(word)) {
        index += 1;
      } else if (word === '-S' || word === '--split-string') {
        const splitWords = [...(words[index + 1] ?? '').matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map((part) => part[1] ?? part[2] ?? part[3]);
        words.splice(index, 2, ...splitWords);
        index -= 1;
      } else if (/^(?:-S|--split-string)=/u.test(word)) {
        const splitWords = [...word.slice(word.indexOf('=') + 1).matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map((part) => part[1] ?? part[2] ?? part[3]);
        words.splice(index, 1, ...splitWords);
        index -= 1;
      } else if (word === '--') {
        break;
      } else if (!word.startsWith('-') && !/^\w+=/u.test(word)) {
        break;
      }
    }
    if (chdirTarget) events.push({ index: envIndex, target: chdirTarget, type: 'env-chdir' });
  }

  // Normalize supported execution prefixes before looking for directory
  // options, while retaining quoted path operands and their source offsets.
  const segments = /(?:^|[;\n|&(){}])([^;\n|&(){}]+)/gu;
  for (const match of command.matchAll(segments)) {
    const segmentOffset = match.index + match[0].indexOf(match[1]);
    const firstWord = scopeWords(match[1])[0];
    if (!firstWord || !shellSyntax[segmentOffset + firstWord.index]) continue;
    for (const option of directoryOptionTargets(match[1])) {
      events.push({ index: segmentOffset + option.index, target: option.target, type: 'env-chdir' });
    }
  }

  const resolveTarget = (target, base) => {
    if (target.startsWith('~')) {
      const home = process.env.HOME;
      if (!home) return null;
      target = home + target.slice(1);
    }
    return isAbsolute(target) ? target : resolve(base, target);
  };

  const order = { 'subshell-open': 0, cd: 1, 'env-chdir': 1, 'subshell-close': 2 };
  const uniqueEvents = [...new Map(events.map((event) => [`${event.index}:${event.type}:${event.target ?? ''}`, event])).values()];
  uniqueEvents.sort((left, right) => left.index - right.index || order[left.type] - order[right.type]);
  for (const event of uniqueEvents) {
    if (event.type === 'subshell-open') {
      parentScopes.push(current);
      continue;
    }
    if (event.type === 'subshell-close') {
      current = parentScopes.pop() ?? current;
      continue;
    }
    const target = resolveTarget(event.target, current);
    if (!target) continue;
    directories.push(target);
    if (event.type === 'cd') current = target;
  }
  const effective = stripInertText(command);
  const hasShellCommandString = /(?:^|[;\n|&(){}])[^;\n|&(){}]*\b(?:ba|da|z)?sh\b[^;\n|&(){}]*\s-[A-Za-z]*c[A-Za-z]*\s+["']/u.test(command);
  if (hasShellCommandString && effective !== command) {
    for (const nested of resolveExecutionDirs(cwd, effective).slice(1)) {
      if (!directories.includes(nested)) directories.push(nested);
    }
  }
  return directories;
}

export function resolveExecutionDir(cwd, command) {
  return resolveExecutionDirs(cwd, command).at(-1) ?? null;
}

const QUOTED = /\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"/u;

function endsWithShellC(scanned) {
  const rawSegment = scanned.split(/\|\||&&|[;\n|&]/u).at(-1).trim();
  const segment = commandAfterPrefixes(rawSegment);
  const tokens = segment.split(/\s+/u).filter(Boolean);
  let i = 0;
  if (!/(?:^|\/)(?:ba|da|z)?sh$/u.test(tokens[i] ?? '')) return false;
  i += 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(token)) return i === tokens.length - 1;
    if (/^(?:-[A-Za-z]*[oO]|--(?:option|shopt))$/u.test(token)) {
      if (i + 1 >= tokens.length) return false;
      i += 2;
      continue;
    }
    if (!token.startsWith('-')) return false;
    i += 1;
  }
  return false;
}

function shellHeredocBody(command, offset, body) {
  const prefix = command.slice(0, offset);
  const segment = prefix.split(/\|\||&&|[;\n|&]/u).at(-1).trim();
  const tokens = segment.split(/\s+/u).filter(Boolean);
  let i = 0;
  if (tokens[i] === 'env') {
    i += 1;
    while (/^\w+=\S*$/u.test(tokens[i] ?? '')) i += 1;
  }
  return /(?:^|\/)(?:ba|da|z)?sh$/u.test(tokens[i] ?? '') ? `\n${body}\n` : ' ';
}

function commandSubstitutionBodies(text, { processSubstitutions = false } = {}) {
  const bodies = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    const commandSubstitution = text[i] === '$' && text[i + 1] === '(';
    const processSubstitution = processSubstitutions && (text[i] === '<' || text[i] === '>') && text[i + 1] === '(';
    if (commandSubstitution || processSubstitution) {
      let depth = 1;
      let j = i + 2;
      let quote = null;
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === '\\') {
          j += 1;
        } else if (quote !== null) {
          if (text[j] === quote) quote = null;
        } else if (text[j] === "'" || text[j] === '"' || text[j] === '`') {
          quote = text[j];
        } else if (text[j] === '$' && text[j + 1] === '(') {
          depth += 1;
          j += 1;
        } else if (text[j] === '(') {
          depth += 1;
        } else if (text[j] === ')') {
          depth -= 1;
        }
      }
      if (depth === 0) {
        bodies.push(text.slice(i + 2, j - 1));
        i = j - 1;
      }
      continue;
    }
    if (text[i] === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '`') break;
        j += 1;
      }
      if (j < text.length) {
        bodies.push(text.slice(i + 1, j));
        i = j;
      }
    }
  }
  return bodies;
}

function decodeAnsiCWord(quoted) {
  const text = quoted.slice(2, -1);
  let decoded = '';
  const simple = new Map([
    ['a', '\x07'],
    ['b', '\b'],
    ['e', '\x1b'],
    ['E', '\x1b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
    ['\\', '\\'],
    ["'", "'"],
    ['"', '"'],
    ['?', '?'],
  ]);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      decoded += text[i];
      continue;
    }
    const escaped = text[++i];
    if (simple.has(escaped)) {
      decoded += simple.get(escaped);
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/u.test(text[i + 1] ?? '')) digits += text[++i];
      decoded += String.fromCodePoint(Number.parseInt(digits, 8));
      continue;
    }
    const widths = { x: 2, u: 4, U: 8 };
    const width = widths[escaped];
    if (width !== undefined) {
      let digits = '';
      while (digits.length < width && /[0-9A-Fa-f]/u.test(text[i + 1] ?? '')) digits += text[++i];
      const point = Number.parseInt(digits, 16);
      decoded += digits.length > 0 && Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : escaped;
      continue;
    }
    if (escaped === 'c' && i + 1 < text.length) {
      decoded += String.fromCodePoint(text[++i].toUpperCase().codePointAt(0) & 0x1f);
      continue;
    }
    if (escaped !== '\n') decoded += `\\${escaped}`;
  }
  return decoded;
}

function quotedWord(quoted) {
  const inner = quoted.startsWith("$'")
    ? decodeAnsiCWord(quoted)
    : quoted.startsWith("'")
      ? quoted.slice(1, -1)
      : quoted.slice(1, -1).replace(/\\(["\\$`])/gu, '$1');
  return /\s|[;&|]/u.test(inner) ? null : inner;
}

function normalizeUnquotedEscapes(text) {
  const ESCAPED_SPACE = '\u0004';
  let normalized = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      normalized += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === '\n') {
      i += 1;
    } else if (next === ' ' || next === '\t') {
      // An escaped blank stays inside one shell word. A command-string
      // consumer (-c/eval/--call) restores it before scanning the payload.
      normalized += ESCAPED_SPACE;
      i += 1;
    } else if (/[;&|$`]/u.test(next)) {
      // Keep escaped shell structure visibly escaped; splitSegments masks it.
      normalized += `\\${next}`;
      i += 1;
    } else {
      normalized += next;
      i += 1;
    }
  }
  return normalized;
}

function endsWithExecutableString(scanned) {
  if (endsWithShellC(scanned)) return true;
  if (endsWithWatchCommandString(scanned)) return true;
  const segment = scanned.split(/\|\||&&|[;\n|&]/u).at(-1).trim();
  const rawTokens = segment.split(/\s+/u).filter(Boolean);
  const envAt = rawTokens.findLastIndex((token) => token.split('/').at(-1) === 'env');
  if (envAt >= 0 && /^(?:-S|--split-string)=?$/u.test(rawTokens.at(-1) ?? '')) return true;
  const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
  if (tokens[0]?.split('/').at(-1) === 'eval' && tokens.length === 1) return true;
  const npmAt = tokens.findIndex((token) => token.split('/').at(-1) === 'npm');
  if (npmAt < 0) return false;
  const execAt = tokens.findIndex((token, index) => index > npmAt && (token === 'exec' || token === 'x'));
  return execAt >= 0 && /^(?:-c|--call)=?$/u.test(tokens.at(-1) ?? '');
}

function endsWithWatchCommandString(scanned) {
  const segment = scanned.split(/\|\||&&|[;\n|&]/u).at(-1).trim();
  const tokens = segment.split(/\s+/u).filter(Boolean);
  return tokens.some((token) => token.split('/').at(-1) === 'watch') && commandAfterPrefixes(segment).length === 0;
}

function commandStringPayloads(command) {
  const ESCAPED_SPACE = '\u0004';
  const restore = (value) => value?.replaceAll(ESCAPED_SPACE, ' ');
  const payloads = [];
  for (const segment of splitSegments(command)) {
    const executable = commandAfterPrefixes(segment);
    const tokens = executable.split(/\s+/u).filter(Boolean);
    const rawTokens = segment.split(/\s+/u).filter(Boolean);
    const commandName = tokens[0]?.split('/').at(-1);
    if (commandName === 'eval' && tokens.length > 1) payloads.push(restore(tokens.slice(1).join(' ')));
    if (/(?:^|\/)(?:ba|da|z)?sh$/u.test(tokens[0] ?? '')) {
      for (let i = 1; i < tokens.length - 1; i += 1) {
        if (tokens[i] === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/u.test(tokens[i])) {
          payloads.push(restore(tokens[i + 1]));
          break;
        }
        if (/^(?:-[A-Za-z]*[oO]|--(?:option|shopt))$/u.test(tokens[i])) i += 1;
      }
    }
    const npmAt = tokens.findIndex((token) => token.split('/').at(-1) === 'npm');
    const execAt = tokens.findIndex((token, index) => index > npmAt && (token === 'exec' || token === 'x'));
    if (npmAt >= 0 && execAt >= 0) {
      for (let i = execAt + 1; i < tokens.length; i += 1) {
        if (tokens[i] === '-c' || tokens[i] === '--call') {
          if (tokens[i + 1] !== undefined) payloads.push(restore(tokens[i + 1]));
          break;
        }
        if (/^(?:-c|--call)=/u.test(tokens[i])) {
          payloads.push(restore(tokens[i].slice(tokens[i].indexOf('=') + 1)));
          break;
        }
      }
    }
    const envAt = rawTokens.findIndex((token) => token.split('/').at(-1) === 'env');
    if (envAt >= 0) {
      for (let i = envAt + 1; i < rawTokens.length; i += 1) {
        if (rawTokens[i] === '-S' || rawTokens[i] === '--split-string') {
          if (rawTokens[i + 1] !== undefined) payloads.push(restore(rawTokens[i + 1]));
          break;
        }
        if (/^(?:-S|--split-string)=/u.test(rawTokens[i])) {
          payloads.push(restore(rawTokens[i].slice(rawTokens[i].indexOf('=') + 1)));
          break;
        }
      }
    }
    if (tokens[0]?.split('/').at(-1) === 'yarn') {
      const command = otherPackageCommandStart('yarn', tokens.slice(1));
      if (command.foreach && command.index < tokens.length - 1) payloads.push(tokens.slice(command.index + 1).join(' '));
    }
  }
  return payloads.filter(Boolean);
}

function isWordCharacter(character) {
  return character !== undefined && !/[\s;&|]/u.test(character);
}

function followsEnvCommand(scanned) {
  const tokens = scanned
    .split(/\|\||&&|[;\n|&]/u)
    .at(-1)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const envAt = tokens.findLastIndex((token) => /(?:^|\/)env$/u.test(token));
  if (envAt < 0) return false;
  return tokens.slice(envAt + 1).every((token) => token.startsWith('-') || /^\w+=\S*$/u.test(token));
}

// Quoting an argv word does not make it inert: `npm run "ci"` and
// `npx "vitest"` execute exactly the same programs as their unquoted forms.
// Preserve only words occupying a command or script slot; quoted prose passed
// to `git commit -m` or `gh pr create --body` remains blanked below.
function isExecutableQuotedWord(scanned, word) {
  if (word === null) return false;
  const segment = scanned.split(/\|\||&&|[;\n|&]/u).at(-1).trim();
  const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    if (/^\w+=\S*$/u.test(word) && followsEnvCommand(scanned)) return true;
    const executable = word.split('/').at(-1);
    return /^(?:ba|da|z)?sh$|^(?:npm|npx|node|electron|vitest|playwright|test-storybook|pnpm|yarn|bun|bunx|corepack|watch|xargs|env|command|time|nice|nohup|timeout|setsid|stdbuf|exec)$/u.test(executable);
  }
  if (tokens[0]?.split('/').at(-1) === 'corepack' && /^(?:pnpm|yarn)(?:@.+)?$/u.test(word)) return true;

  let npmAt = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (/(?:^|\/)npm$/u.test(tokens[i])) {
      npmAt = i;
      break;
    }
  }
  if (npmAt >= 0) {
    const rest = tokens.slice(npmAt + 1);
    const aliasAt = rest.findIndex((token) => NPM_RUN_ALIASES.has(token));
    const candidates = aliasAt >= 0 ? rest.slice(aliasAt + 1) : rest;
    if (firstNpmScriptToken(candidates) === undefined) return true;
  }

  const manager = tokens[0]?.split('/').at(-1);
  if (OTHER_PACKAGE_MANAGERS.has(manager)) {
    const rest = tokens.slice(1);
    const command = otherPackageCommandStart(manager, rest);
    if (command.foreach) return isExecutableQuotedWord(rest.slice(command.index).join(' '), word);
    if (otherPackageScriptToken(manager, rest) === undefined) return true;
  }

  const last = tokens.at(-1);
  if (/^\w+=\S*$/u.test(word) && followsEnvCommand(scanned)) return true;
  if (last === 'npx' && /^(vitest|playwright|test-storybook)$/u.test(word)) return true;
  if (last === '--run' && tokens.some((token) => /(?:^|\/)node$/u.test(token))) return true;
  if (tokens.some((token) => /(?:^|\/)node$/u.test(token)) && /(?:^|\/)vitest(?:\/vitest)?\.mjs$/u.test(word)) return true;
  return /(?:^|\/)(?:node|electron)$/u.test(last ?? '') && word === '--test';
}

// Quotes are processed left to right: shell-wrapper payloads are unwrapped so
// the patterns can see them, executable argv words are preserved, and ordinary
// quoted text is blanked. Order matters — a commit message that merely mentions
// `bash -c "npm run test:e2e"` is blanked before its inner text is inspected.
export function stripInertText(command) {
  let scanned = '';
  let rest = command.replace(
    /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)(?:\n\2(?=\n|$)|$)/gu,
    (match, quote, delimiter, body, offset) => shellHeredocBody(command, offset, body),
  );
  for (;;) {
    const match = QUOTED.exec(rest);
    if (!match) break;
    const quoted = match[0];
    scanned += rest.slice(0, match.index);
    rest = rest.slice(match.index + quoted.length);
    if (endsWithExecutableString(scanned)) {
      const inner = quoted.startsWith("$'")
        ? decodeAnsiCWord(quoted)
        : quoted.startsWith("'")
          ? quoted.slice(1, -1)
          : quoted.slice(1, -1).replace(/\\(["\\$`])/gu, '$1');
      rest = `${inner}${rest}`;
      scanned += '\n';
    } else {
      const substitutions = quoted.startsWith('"') ? commandSubstitutionBodies(quoted.slice(1, -1)) : [];
      if (substitutions.length > 0) {
        rest = `${substitutions.join('\n')}${rest}`;
        scanned += '""\n';
      } else if (isWordCharacter(scanned.at(-1)) || isWordCharacter(rest[0])) {
        // Shell quote removal concatenates adjacent fragments into one argv
        // word: c""i and "c"i both become ci. Preserve such fragments rather
        // than leaving quote bytes that hide executable or script names.
        const word = quotedWord(quoted);
        scanned += word ?? (quoted.startsWith("'") ? "''" : '""');
      } else if (isExecutableQuotedWord(scanned, quotedWord(quoted))) {
        scanned += quotedWord(quoted);
      } else {
        scanned += quoted.startsWith("'") ? "''" : '""';
      }
    }
  }
  const effective = normalizeUnquotedEscapes(scanned + rest);
  const substitutions = commandSubstitutionBodies(effective, { processSubstitutions: true });
  const payloads = commandStringPayloads(effective);
  const promoted = [...substitutions, ...payloads];
  return promoted.length > 0 ? `${effective}\n${promoted.join('\n')}` : effective;
}

// Codex's shell tool submits argv arrays; the patterns match command text.
export function normalizeCommand(command) {
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    return command
      .map((part) => (/^[A-Za-z0-9_./:=+-]+$/u.test(part) ? part : `"${part.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/[$`]/gu, '\\$&')}"`))
      .join(' ');
  }
  return command;
}

// npm's documented spellings for running a script. `npm run-script test:e2e`
// is the same run as `npm run test:e2e`, and a matcher that only knows `run`
// blocks one and waves the other through.
const NPM_RUN_ALIASES = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_OPTIONS_WITH_OPERANDS = new Set(['-w', '--workspace', '-C', '--prefix', '--userconfig', '--cache', '--registry', '--scope', '--tag', '--otp']);
const NPM_IMPLICIT_SCRIPTS = new Set(['test', 'start', 'stop', 'restart']);

function firstNpmScriptToken(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') continue;
    if (NPM_OPTIONS_WITH_OPERANDS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

/**
 * The script names an npm invocation would run, per shell segment.
 *
 * Tokenized rather than pattern-matched because npm accepts its own options
 * before and after the alias (`npm --silent run test:e2e`,
 * `npm --workspace foo run test:e2e`), and a regex that grabs the token
 * immediately after `npm` reads an option or the alias itself as the script.
 * The alias, when present, is the reliable anchor: the script is the first
 * non-option token after it. Without one, the first non-option token is the
 * script (`npm test`, `npm ci`).
 */
export function npmScriptNames(command) {
  const names = [];
  for (const segment of splitSegments(command)) {
    const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
    if (!/(?:^|\/)npm$/u.test(tokens[0] ?? '')) continue;
    const rest = tokens.slice(1);
    const aliasAt = rest.findIndex((token) => NPM_RUN_ALIASES.has(token));
    const candidates = aliasAt >= 0 ? rest.slice(aliasAt + 1) : rest;
    const script = firstNpmScriptToken(candidates);
    if (aliasAt < 0 && !NPM_IMPLICIT_SCRIPTS.has(script)) continue;
    if (script !== undefined) names.push(script);
  }
  return names;
}

const OTHER_PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'bun']);
const OTHER_PACKAGE_OPTIONS_WITH_OPERANDS = new Set([
  '-C',
  '-F',
  '--cwd',
  '--dir',
  '--filter',
  '--workspace',
  '-w',
]);

function firstOtherPackageScriptToken(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') continue;
    if (OTHER_PACKAGE_OPTIONS_WITH_OPERANDS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

function otherPackageCommandStart(manager, tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (OTHER_PACKAGE_OPTIONS_WITH_OPERANDS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  if (manager === 'yarn' && tokens[index] === 'workspace') {
    index += 2; // selector plus workspace name
    while (tokens[index]?.startsWith('-')) index += 1;
  }
  if (manager === 'yarn' && tokens[index] === 'workspaces' && tokens[index + 1] === 'foreach') {
    index += 2;
    const optionsWithOperands = new Set(['--from', '--include', '--exclude', '--jobs', '-j']);
    while (tokens[index]?.startsWith('-')) {
      const option = tokens[index++];
      if (optionsWithOperands.has(option) && index < tokens.length) index += 1;
    }
    return { foreach: true, index };
  }
  return { foreach: false, index };
}

function otherPackageScriptToken(manager, tokens) {
  let { index } = otherPackageCommandStart(manager, tokens);
  if (tokens[index] === 'run' || tokens[index] === 'run-script') index += 1;
  return firstOtherPackageScriptToken(tokens.slice(index));
}

// pnpm, Yarn and Bun all expose package scripts as `run <script>` and also
// accept a direct script spelling. They share the same heavy-lane policy as
// npm; otherwise changing package manager would silently remove admission.
export function otherPackageScriptNames(command) {
  const names = [];
  for (const segment of splitSegments(command)) {
    const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
    const manager = tokens[0]?.split('/').at(-1);
    if (!OTHER_PACKAGE_MANAGERS.has(manager)) continue;
    const rest = tokens.slice(1);
    const script = otherPackageScriptToken(manager, rest);
    if (script !== undefined) names.push(script);
  }
  return names;
}

const TEST_BINARIES = new Set(['vitest', 'c8', 'playwright', 'test-storybook']);
const EXEC_OPTIONS_WITH_OPERANDS = new Set([...NPM_OPTIONS_WITH_OPERANDS, ...OTHER_PACKAGE_OPTIONS_WITH_OPERANDS, '--package', '-p']);

function skipCliOptions(tokens, start, optionsWithOperands) {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return index + 1;
    if (optionsWithOperands.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function directTestBinaryThroughExec(segment) {
  const tokens = segment.split(/\s+/u).filter(Boolean);
  const command = tokens[0]?.split('/').at(-1);
  if (command === 'npx' || command === 'bunx') {
    const binaryAt = skipCliOptions(tokens, 1, EXEC_OPTIONS_WITH_OPERANDS);
    return TEST_BINARIES.has(tokens[binaryAt]?.split('/').at(-1));
  }
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(command)) return false;
  const options = EXEC_OPTIONS_WITH_OPERANDS;
  const verbAt = skipCliOptions(tokens, 1, options);
  if (!['exec', 'x', 'dlx'].includes(tokens[verbAt])) return false;
  const binaryAt = skipCliOptions(tokens, verbAt + 1, options);
  return TEST_BINARIES.has(tokens[binaryAt]?.split('/').at(-1));
}

function packageScriptNames(command) {
  return [...npmScriptNames(command), ...nodeRunScriptNames(command), ...otherPackageScriptNames(command)];
}

// Node >=22 exposes package.json scripts through `node --run <script>` and
// `node --run=<script>`. Those spellings have the same admission policy as npm.
export function nodeRunScriptNames(command) {
  const names = [];
  for (const segment of splitSegments(command)) {
    const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
    if (!/(?:^|\/)node$/u.test(tokens[0] ?? '')) continue;
    const rest = tokens.slice(1);
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token.startsWith('--run=')) {
        const script = token.slice('--run='.length);
        if (script) names.push(script);
        break;
      }
      if (token === '--run' && rest[i + 1] !== undefined) {
        names.push(rest[i + 1]);
        break;
      }
    }
  }
  return names;
}

function isUnguardedInnerScript(command) {
  return packageScriptNames(command).some((script) => /:(?:run|inner)$/u.test(script));
}

/**
 * Heavy-lane detection for a raw command line.
 *
 * Narrower than lib/policy.mjs's label matching on purpose: a hook sees every
 * shell command an agent runs, so matching the bare word "perf" anywhere would
 * deny `grep perf src/`. Only npm script invocations and the test binaries
 * themselves count here.
 */
export function heavyLaneFor(command) {
  for (const script of packageScriptNames(command)) {
    const lane = HEAVY_LANES.find((entry) => entry.pattern.test(script));
    if (lane) return lane;
  }
  for (const segment of splitSegments(command)) {
    const tokens = commandAfterPrefixes(segment).split(/\s+/u).filter(Boolean);
    const executable = tokens[0]?.split('/').at(-1);
    if (executable === 'playwright' && tokens[1] === 'test') return HEAVY_LANES.find((entry) => entry.id === 'e2e');
    if (executable === 'test-storybook') return HEAVY_LANES.find((entry) => entry.id === 'stories');
    if (executable === 'npx' || executable === 'bunx') {
      const binaryAt = skipCliOptions(tokens, 1, EXEC_OPTIONS_WITH_OPERANDS);
      const binary = tokens[binaryAt]?.split('/').at(-1);
      if (binary === 'playwright' && tokens[binaryAt + 1] === 'test') return HEAVY_LANES.find((entry) => entry.id === 'e2e');
      if (binary === 'test-storybook') return HEAVY_LANES.find((entry) => entry.id === 'stories');
    }
  }
  return null;
}

function commandAfterPrefixes(segment) {
  const tokens = segment.split(/\s+/u).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    while (/^\w+=\S*$/u.test(tokens[index] ?? '')) index += 1;
    const command = tokens[index]?.split('/').at(-1);
    if (command === 'command') {
      if (tokens.slice(index + 1).some((token) => token === '-v' || token === '-V')) break;
      index += 1;
      while (tokens[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (command === 'time' || command === 'nohup') {
      index += 1;
      while (tokens[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (command === 'corepack') {
      const proxy = /^(?:pnpm|yarn)(?:@.+)?$/u.exec(tokens[index + 1]?.split('/').at(-1) ?? '')?.[0];
      if (!proxy) break;
      tokens[index + 1] = proxy.split('@')[0];
      index += 1;
      continue;
    }
    if (command === 'nice') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if ((option === '-n' || option === '--adjustment') && index < tokens.length) index += 1;
      }
      continue;
    }
    if (command === 'timeout') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (/^(?:-k|--kill-after|-s|--signal)$/u.test(option) && index < tokens.length) index += 1;
      }
      if (index < tokens.length) index += 1; // duration
      continue;
    }
    if (command === 'watch') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (/^(?:-n|--interval|--equexit)$/u.test(option) && index < tokens.length) index += 1;
      }
      continue;
    }
    if (command === 'xargs') {
      index += 1;
      const optionsWithOperands = new Set([
        '-a',
        '--arg-file',
        '-d',
        '--delimiter',
        '-E',
        '--eof',
        '-I',
        '--replace',
        '-J',
        '-L',
        '--max-lines',
        '-n',
        '--max-args',
        '-P',
        '--max-procs',
        '--process-slot-var',
        '-R',
        '-S',
        '-s',
        '--max-chars',
      ]);
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (option === '--') break;
        if (optionsWithOperands.has(option) && index < tokens.length) index += 1;
      }
      continue;
    }
    if (command === 'setsid') {
      index += 1;
      while (tokens[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (command === 'stdbuf') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (/^-[ioe]$/u.test(option) && index < tokens.length) index += 1;
      }
      continue;
    }
    if (command === 'exec') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (option === '-a' && index < tokens.length) index += 1;
      }
      continue;
    }
    if (command === 'env') {
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index];
        if (/^\w+=\S*$/u.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          index += 1;
          if (/^(?:-u|--unset|--chdir|-C|-S|--split-string)$/u.test(token) && index < tokens.length) index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index).join(' ');
}

export function evaluateCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return { allow: true };
  const effective = stripInertText(command);

  for (const { pattern, reason } of TAMPERING) {
    if (pattern.test(effective)) return { allow: false, reason };
  }

  const lane = heavyLaneFor(effective);
  if (lane) {
    return {
      allow: false,
      reason:
        `Blocked the "${lane.id}" lane: ${lane.why}, and on a small machine several of these in parallel across repos and ` +
        `agents is what exhausts memory. Agents do not run it locally by default. ${GUIDANCE} ` +
        'If a local run is genuinely required, the owner can run it directly from their own terminal; agent sessions cannot receive forgeable local grants.',
    };
  }

  // A wrapper invocation is the sanctioned path even when the command it wraps
  // matches a blocked pattern — but only for ITS OWN segment. Vouching for the
  // whole line let `echo run-guarded.mjs; node --test …` through, and equally
  // `node run-guarded.mjs -- npm run lint && node --test …`: the sanctioned
  // call is real, and the blocked binary rides along beside it.
  for (const segment of splitSegments(effective)) {
    const executableSegment = commandAfterPrefixes(segment);
    if (ANY_WRAPPER_SEGMENT.test(executableSegment) && !WRAPPER_SEGMENT.test(executableSegment)) {
      return {
        allow: false,
        reason: `Blocked a non-canonical run-guarded.mjs path: only the repository guard may claim the wrapper exemption. ${USE_ENTRYPOINT}`,
      };
    }
    if (WRAPPER_SEGMENT.test(executableSegment)) continue;
    if (directTestBinaryThroughExec(executableSegment)) {
      return {
        allow: false,
        reason: `Blocked direct test-binary invocation through a package-manager exec shim: it bypasses the machine-scoped memory guard. ${USE_ENTRYPOINT}`,
      };
    }
    if (isUnguardedInnerScript(segment)) {
      return {
        allow: false,
        reason: `Blocked unguarded inner package script: it bypasses the machine-scoped memory guard. ${USE_ENTRYPOINT}`,
      };
    }
    for (const { pattern, what, reason } of BLOCKED) {
      if (pattern.test(executableSegment)) {
        return {
          allow: false,
          reason: reason ?? `Blocked ${what}: it bypasses the machine-scoped memory guard. ${USE_ENTRYPOINT}`,
        };
      }
    }
  }
  return { allow: true };
}

// A directory is inside a guarded checkout when a marker exists there or in any
// ancestor — commands routinely run from subdirectories.
function inGuardedCheckout(dir) {
  let current = tryRealpath(dir);
  for (;;) {
    if (GUARD_MARKERS.some((marker) => existsSync(resolve(current, marker)))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function evaluateHookInput({ command, cwd }, projectDir, options = {}) {
  const executionDirs = resolveExecutionDirs(cwd, command);
  if (executionDirs.length > 0 && projectDir) {
    const inScope = executionDirs.some((executionDir) => isWithin(executionDir, projectDir) || inGuardedCheckout(executionDir));
    if (!inScope) return { allow: true };
  }
  return evaluateCommand(command, options);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(protocol, verdict) {
  if (protocol === 'cursor') {
    const body = verdict.allow
      ? { permission: 'allow' }
      : {
          permission: 'deny',
          agentMessage: verdict.reason,
          userMessage: 'Blocked by the machine memory guard (see docs/reference/agent-memory-guard.md).',
        };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  if (!verdict.allow) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      })}\n`,
    );
  }
}

async function main() {
  const protocol = process.argv.includes('--protocol=cursor') ? 'cursor' : process.argv.includes('--protocol=codex') ? 'codex' : 'claude';
  // This script lives in the checkout it protects, so its own location is the
  // authoritative project dir (CLAUDE_PROJECT_DIR matches for Claude Code;
  // Cursor and Codex set no equivalent).
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  let verdict = { allow: true };
  try {
    const input = JSON.parse(await readStdin());
    const command = protocol === 'cursor' ? input.command : normalizeCommand(input.tool_input?.command);
    verdict = evaluateHookInput({ command, cwd: input.cwd }, projectDir);
  } catch {
    // Fail open (see header).
  }
  respond(protocol, verdict);
}

const invokedDirectly = process.argv[1] && tryRealpath(resolve(process.argv[1])) === tryRealpath(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
