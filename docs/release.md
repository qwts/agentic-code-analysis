# Release procedure

The repository produces an npm release candidate; publishing remains a
separate maintainer-authorized action. Follow issue #59 and ACA-0059 for the
first release boundary.

## Candidate gate

From a clean checkout on the release commit:

```bash
npm clean-install
npm run typecheck
npm test
npm run test:package
npm audit
gitleaks git --redact=100
```

`test:package` emits JavaScript, checks the complete npm allowlist, scans the
published text for private locators, installs the exact tarball into a clean
temporary consumer, and invokes its linked `aca` executable. Inspect
`npm pack --dry-run --json` before approving the release.

Any change to a judge prompt, embedded standard/rubric, schema, calibration
manifest, or fixture content also requires a live qualification run. Configure
the `ACA_PROVIDER` and `ACA_MODEL` repository variables from the maintained
routing registry, configure the selected provider's Actions secret, and run
the manual `calibrate` workflow. A gate-down exit 78 is not qualification.

## Version and publish handoff

1. Audit the public npm identity before reserving or publishing the name. npm
   permits a pseudonymous account, but publishes the username and email and
   adds publisher information to package metadata. Use the approved `qwts`
   identity with a dedicated public contact address; omit a personal name and
   social links. This package deliberately has no `author`, `contributors`, or
   `AUTHORS` metadata. Verify the profile and `npm owner ls` output contain
   nothing private. See npm's [privacy guidance](https://docs.npmjs.com/policies/privacy/)
   and [account requirements](https://docs.npmjs.com/creating-a-new-npm-user-account/).
2. Confirm the version follows semver and the issue closeout describes the
   solution as built, patterns used, and design deltas.
3. Merge only after CI passes and one human review approves the PR.
4. Tag the reviewed merge commit and create release notes from the issue
   closeout.
5. Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
   for this public repository and a protected release workflow/tag before the
   first publish; do not store a long-lived npm token in the repository.
6. Run the publication from the reviewed tag. Verify the npm provenance and
   install the registry artifact in a fresh directory before promoting it.

An npm version is immutable. A bad release is superseded with a patch and may
be deprecated; do not rely on unpublishing as rollback.
