# Rubric: testable seams

A **seam** is a place where a test can substitute a dependency's behavior
without editing the file, patching a global or module internals, or
intercepting module loading. An explicit parameter, a constructor
dependency, a port (an interface the code accepts), and a caller-supplied
factory are seams. Direct use of an ambient capability is not.

## The practical test

To write a focused test of this file's core logic, what would the test have
to patch? If the honest answer names a global (`Date`, `Math.random`,
`fetch`, `process.env`, timers, DOM), another module's internals, the module
loader, or standing up the real external system, the file is missing a seam
at that dependency.

## What counts as a missing seam

Only a dependency at a **natural variability boundary** — external I/O or
external service, clock, randomness, environment, or mutable ambient state —
that core logic reaches without a seam. Criteria:

- **hardwired-dependency** — core logic chooses or constructs a concrete
  collaborator (`new` inside the logic, reaching through an imported
  singleton) instead of accepting a replaceable one.
- **ambient-state** — core logic directly reads clock, randomness,
  environment, or mutable process/global state.
- **ambient-io** — core logic directly performs network, filesystem,
  storage, subprocess, DOM, or similar external operations.
- **import-time-side-effect** — module evaluation itself performs external
  work or captures/mutates ambient state, so a test pays the cost (or needs
  loader interception) merely by importing the file. For the same access
  this criterion takes precedence, so one dependency is reported once.

## What is NOT a missing seam

- **Dependencies behind seams.** A file whose collaborators arrive as
  parameters, constructor arguments, ports, or factories passes, however
  many dependencies it has. Dependencies are never failures by themselves.
- **Deterministic local/value construction.** `new Map()`, data/value
  objects, pure local helpers — nothing a test would ever need to replace.
- **An intentional composition root.** A file whose purpose is to construct
  concrete collaborators and wire them together (a `main`, a CLI entry, a
  factory module) binds dependencies by design; judge whether the *policy*
  it wires stays elsewhere, not the wiring itself.
- **A thin boundary adapter.** A file may bind an ambient capability when it
  exposes that capability behind a port and contains no domain policy — an
  adapter that wraps `fetch` behind an `HttpPort` is where the seam is
  implemented, not a violation.

Over-seaming and seam *placement* are out of scope: never penalize a file
for having seams, only for lacking them at natural joints.
