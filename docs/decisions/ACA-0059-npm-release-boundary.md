# ACA-0059: npm release boundary — emitted JavaScript, explicit publication surface, pseudonymous fixture licensing

**Status:** Proposed
**Date:** 2026-08-05
**Issue:** #59
**Supersedes:** [ACA-0003](ACA-0003-suite-contracts.md)'s no-build packaging
constraint for published artifacts only; development continues to execute
authored TypeScript directly.
**Extends:** [ACA-0012](ACA-0012-graded-calibration.md)'s fixture provenance
and permission policy.

## Context

The suite was deliberately authored as erasable TypeScript executed directly
by Node. Node refuses to strip types from files beneath `node_modules`, so the
source layout cannot become an installed npm CLI without a separate runtime
artifact. The default npm file selection also includes tests, repository
governance, internal plans, and provenance details that consumers do not need.

One required field fixture comes from a proprietary project owned by the
maintainer. Its exact contents are necessary calibration evidence, but a public
package does not need the natural-person identity or private source locator to
verify the checksummed fixture. The copyright holder can license that excerpt
separately while the originating project remains proprietary.

## Decision

**Publication is an explicit boundary.** TypeScript remains the only authored
source and continues to run directly in development and tests. `prepack` emits
ESM JavaScript into an ignored `dist/` tree, rewriting relative TypeScript
extensions, and copies only non-code assets that runtime checks or calibration
self-tests read relative to their modules. Generated JavaScript is never
committed.

**The npm surface is allowlisted.** The package contains `dist/`, the runtime
standards, package metadata, README, and license. Tests, source TypeScript,
repository-agent instructions, CI configuration, local configuration, and
design/plan documents do not ship. A hermetic tarball test checks the complete
file list, installs the archive into a clean consumer, and invokes the linked
`aca` executable.

**Provider adapters install with the CLI.** SDKs used by built-in adapters are
runtime dependencies, not optional peers. Selecting a built-in provider must
not turn a normal global or `npx` installation into a module-resolution error.
Consumers still choose the provider and model through configuration; no model
name is encoded in the package.

**Fixture licensing is narrow and pseudonymous.** The field excerpt is
licensed under Apache-2.0 for redistribution as this calibration fixture only.
The originating project remains proprietary. Public metadata identifies the
maintainer as `@qwts` and states the grant by the copyright holder; the legal
name and private provenance locator remain outside the distributed package.
Checksums and expected judgments remain unchanged. Because the packaged
standard text changes, the context-footprint prompt version advances and the
exam must be requalified.

## Why

An emitted runtime is the smallest reliable npm contract and follows Node's
explicit guidance not to publish executable TypeScript beneath `node_modules`.
An allowlist makes accidental publication fail closed. Narrow relicensing lets
the public package carry the immutable field evidence without relicensing or
identifying the originating proprietary project.

## Consequences

Packaging gains a build step, asset-staging logic, and a second class of CI
failures. The emitted tree can drift from source if the package test is skipped,
so release CI must build from a clean checkout and install the exact tarball.
Including both provider SDKs increases installation size, accepted in exchange
for every documented built-in adapter working after a normal install.

Changing the standard invalidates cached context-footprint verdicts and prior
qualification evidence through prompt version and fixture-suite identity. A
live calibration run is therefore required before release. Actual npm
publication, registry-name reservation, trusted-publisher account setup, and
Git-history rewriting remain separate authorized operations.
