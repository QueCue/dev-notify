# Automated npm publishing

English | [简体中文](NPM_PUBLISH.md)

Maintainer instructions for [QueCue/dev-notify](https://github.com/QueCue/dev-notify), workflow `.github/workflows/publish-npm.yml`, displayed as **Publish npm**. npm users do not need publishing permissions.

`@quecue/dev-notify` already has multiple releases. See the [CHANGELOG](../CHANGELOG.en.md) for version changes; branch changes and version headings alone do not establish publication. Never overwrite an existing npm version with different content. Query actual state with:

```sh
npm view @quecue/dev-notify dist-tags versions --json --registry=https://registry.npmjs.org/
```

## Trusted Publisher configuration

Do not delete/recreate a working publisher merely because this document changed. When configuring or repairing it, select GitHub Actions in npm package settings:

| Field | Value |
| --- | --- |
| GitHub user/organization | `QueCue` |
| Repository | `dev-notify` |
| Workflow filename | `publish-npm.yml`, without directories |
| GitHub environment | Empty; no environment is specified by the workflow |

The workflow uses GitHub-hosted runners and OIDC, not repository-stored npm tokens, passwords, OTPs or long-lived authentication secrets. Only the publish job has `id-token: write`. Node.js 24 and npm 11.21.0 are pinned workflow choices, not minimum versions for all package users.

Publishing and **Allow npm dist-tag** are separate permissions; this workflow needs tag management for verification/correction. npm currently requires newly created publisher configurations to complete a successful first publish within two days to bind repository identity; this does not mean an already-bound publisher expires after two days. Account verification, available controls and current rules are governed by [npm's documentation](https://docs.npmjs.com/trusted-publishers). Complete browser second-factor checks personally; do not store authentication material in the repository.

Supported OIDC publishing of a public package from a public GitHub repository can generate provenance. It is not a security audit, and local YAML checks do not verify that account-side publishing identity is configured correctly.

## Normal new releases

1. Run `npm ci --ignore-scripts` and `npm test` in this repository. Review release notes and both language versions.
2. Select an unpublished version and update package.json, package-lock, `VERSION` in `node-src/cli.ts`, and CHANGELOG together. The communication extraction is being prepared as `0.2.2`; never overwrite the existing `0.2.1` or another historical version.
3. Include source, exact runtime dependency declarations, the registry lockfile and build/release scripts in the versioned commit. Library source: [QueCue/notify-core](https://github.com/QueCue/notify-core). First confirm `@quecue/notify-core@0.1.0` is available on npm, then generate and verify the lockfile. CI installs through npm without reading a sibling checkout or vendor tarball.
4. Generate and verify the candidate locally:

   ```sh
   node -e "require('node:fs').mkdirSync('build/release-check', {recursive: true})"
   npm pack --ignore-scripts --json --pack-destination build/release-check > build/release-check/pack.json
   node scripts/verify-package.mjs build/release-check/pack.json build/release-check
   ```

   `--ignore-scripts` is appropriate here because `npm test` already built the source. It does not refresh stale dist on its own.
5. After explicit confirmation, commit the version and create/push the exact matching `v<version>` tag. Ordinary branch pushes do not publish.

Tag mappings: stable `vX.Y.Z` → `latest`, `vX.Y.Z-alpha.N` → `alpha`, `beta.N` → `beta`, `rc.N` → `rc`. These are placeholders, not literal tag names.

Prereleases do not update `latest` by default. Manually enabling `update_latest` points default tagless installs at the selected version, possibly an older one. Use it only intentionally after checking the effect, not automatically for a first-time configuration.

## Manual runs and verification reruns

Select a branch containing the workflow in Actions → Publish npm → Run workflow, and enter an **existing tag matching that run's source and package.json**. No old alpha tag is selected by default.

A manual run builds its actual workflow commit; it does not silently check out the entered tag. Only non-package changes under `.github/` and `test-js/` may differ from that tag. Other source, scripts, dependency declarations, lockfiles and documents must match. A branch with other changes must prepare a new version; never delete or retag a historical release.

The workflow checks version identity, restores dependencies, tests, verifies compiled file inventory/SHA512, then transfers the same verified tarball to the publishing job. `scripts/verify-package.mjs` is shared by local verification and CI and checks the CLI file inventory and the exact communication runtime dependency in the archive metadata. Do not permit arbitrary dist files to bypass this check.

## Failures and reruns

- Tag/source mismatch, failed tests, unexpected package files or integrity mismatch stop before publishing.
- For OIDC/permission problems, check repository case, workflow name, direct publish and tag permissions instead of adding a long-lived token workaround.
- A query failure does not mean the version is absent. An unknown publish result must not trigger a blind resend.
- Registry reads may lag after npm acceptance. The workflow performs up to about 10 minutes of read-only version-integrity checks and about 1 minute of tag checks. A timeout can mean publication succeeded but verification did not finish.
- Existing versions are reused only if their remote SHA512 equals this tarball, after which tags are verified. Different content requires a new version, never an overwrite.
- Linux CI is not Windows/macOS real-machine acceptance; platform-specific tests may be skipped. See CHANGELOG and SECURITY for scope.

Actions summaries and the registry's target version, integrity and dist-tags are authoritative. This document and local tests do not push tags or publish on the maintainer's behalf.

## Official references

- [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [Provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish)
