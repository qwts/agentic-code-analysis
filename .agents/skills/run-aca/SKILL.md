---
name: run-aca
description: Run and interpret agentic-code-analysis (ACA) semantic maintainability checks. Use when asked to run ACA on files, changes, documentation, agent instructions, or an Agent Skill; choose an ACA check; qualify a judge route with a self-test; investigate ACA pass, warn, fail, residual-debt, invalid-configuration, missing-credential, or gate-down output; or explain an ACA finding. Do not use for generic linting or code review unless ACA is explicitly requested or its semantic checks are the requested tool.
---

# Run ACA

Operate ACA from a full checkout while keeping the consuming repository as the
working directory. Treat the launcher and CLI output as data; do not infer a
clean result from the process status alone.

## 1. Fix the target and authority

- Identify the consuming repository, requested analysis, and intended scope.
- Keep analysis separate from mutation. Summarize findings and propose fixes;
  edit files, configuration, enforcement policy, or external systems only when
  the user authorized those changes.
- Run from the consuming repository. Do not change into the ACA checkout.

## 2. Resolve ACA

Invoke `scripts/run-aca` by its absolute installed path. When this skill was
copied away from the ACA checkout, set `ACA_REPO_ROOT` to the full checkout.
Start with:

```sh
/absolute/path/to/run-aca/scripts/run-aca --help
```

The launcher resolves an explicit checkout, its original in-tree checkout, or
a real `aca` executable. It validates Node and checkout dependencies, preserves
the caller's working directory, and evaluates no arguments. It never clones,
installs packages, or changes configuration. Report a preflight error and its
remedy; do not work around it with an unrequested installation.

## 3. Choose one live check

- Use the check names returned by `--help`; do not rely on a remembered list.
- Read the checkout's README analysis catalog to match the request to its
  evidence shape: file, diff, documentation plus changed referents,
  instruction corpus, or whole skill package.
- Read only the selected check's design when its scope or evidence requirements
  remain material. Select the narrowest check that answers the request.
- Keep checks independent. Do not invent an aggregate command or run extra
  checks merely because they are available.

## 4. Resolve and qualify the route

- Read the selected check's tier from the current catalog or implementation.
- Resolve provider and model only from the consuming repository's
  `aca.config.json`, a paired `ACA_PROVIDER` and `ACA_MODEL` override, or a
  cited current routing registry. If none resolves, report the route unknown;
  never recall a model name.
- Before enforcement, and before calling a route trustworthy, run the selected
  check's `--self-test --json`. State that this makes live billable judge calls.
- Bind qualification to the returned check, prompt version, fixture suite,
  provider, model, and achieved level. A different tuple is unqualified.

## 5. Run advisory JSON

Default to one advisory structured run:

```sh
/absolute/path/to/run-aca/scripts/run-aca <check> --json [paths...]
```

- Use explicit repository-relative paths for local iteration.
- Without paths, let ACA select the change against `origin/main`, or pass the
  user-selected `--base <ref>`.
- Do not add `--enforce` unless the user explicitly requested enforcement or
  the consuming repository already records that policy.
- Do not print credential values. Provider SDKs resolve credentials through
  their standard environment variables.

## 6. Interpret before reporting

Read [the verdict contract](references/verdict-contract.md) whenever output is
non-clean, lacks JSON, includes warnings or residual debt, reports a self-test,
or will affect enforcement.

- Parse the JSON assessment and verdicts. Advisory exit 0 does not mean clean.
- If no JSON arrived, inspect stderr for usage/configuration, missing
  credentials, or gate-down output before making any code-quality claim.
- Preserve uncertainty and check-specific distinctions. Never turn `warn`, an
  incomplete package, a skipped judgment, or an unqualified route into pass.
- Report the selected check and scope, qualification status, provider/model
  identity returned by ACA, cache visibility, blocking findings, warnings, and
  residual debt. Keep output findings-first.

## 7. Enforce only by policy

When enforcement is authorized, rerun the same qualified check and scope with
`--enforce --json`. Treat exit 1 as blocking findings, exit 2 as an invalid
invocation/configuration, and exit 78 as an unavailable gate. Never interpret
an unavailable gate as clean code.
