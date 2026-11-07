# Contributing and development

English | [简体中文](CONTRIBUTING.md)

User installation and usage belong in [README.en.md](README.en.md). This guide is for source contributors. Release changes and verification results belong in [CHANGELOG.en.md](CHANGELOG.en.md); security boundaries are in [SECURITY.en.md](SECURITY.en.md).

## Local build

Requires Node.js 22 or later. Clone [QueCue/dev-notify](https://github.com/QueCue/dev-notify), then run from the repository directory:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --version
npm test
npm pack --dry-run
```

`node-src/` contains TypeScript, `dist/` compiled output, and `test-js/` regression tests. Use `node dist/cli.js` instead of README's `dev-notify` to run from source without global installation. Interactive setup changes local state, and actual sending publishes content externally. Use separate test configurations and bots rather than accidentally using personal credentials.

Communication uses the standard npm dependency [QueCue/notify-core](https://github.com/QueCue/notify-core); no sibling checkout is required. The lockfile pins source and integrity for exact `npm ci` restoration. Do not replace standard dependencies with copied build output or bundled library copies.

## Testing

- Default regressions use temporary directories, fake credentials, and mocked network/system backends, without injecting into real Claude sessions.
- The Windows native credential round-trip requires explicit `DEV_NOTIFY_NATIVE_TEST=1`; use and clean only random fake entries created for that run, not existing credentials.
- Compiling native input helpers and checking layouts does not establish real input acceptance. Mock API, terminal, and permission failures cannot establish compatibility on every platform.
- Cover success, explicit failure, unknown outcomes, and secret protection. Do not blindly replay input or messages with unknown outcomes.
- Maintain user-interface error codes centrally in `node-src/error-codes.ts`, rendered through `i18n.ts`. Keep each code's meaning and language-independent identity stable. Add codes only for new confirmed categories; never encode tokens, paths, user identity, or inferred root causes. Unclassified CLI validation/credential failures use `DN-CONFIG`/`DN-CREDENTIAL`; unknown system exceptions use `DN-UNKNOWN` without the underlying exception. Preserve structured hook control JSON and exit-code semantics.
- Record release verification in CHANGELOG, distinguishing automation, real-machine confirmation, and unverified cases. Do not add those records to the user README.

## Documentation responsibilities

- README: user installation, configuration, operations, limitations, and necessary troubleshooting, not development history or release-iteration notes.
- CHANGELOG: versioned changes, upgrade impact, and verification results.
- SECURITY: credential, authorization, network, state, and platform boundaries.
- CONTRIBUTING: build, testing, and contribution guidance.
- Keep Chinese and English in sync; link other repositories using their public GitHub addresses.

## Commits and releases

Accumulate ordinary fixes under Unreleased instead of publishing every change as a stable release. Use prerelease versions and non-`latest` tags for testing; maintainers explicitly decide stable releases.

Synchronize `package.json`, `package-lock.json`, the version in `node-src/cli.ts`, and both changelogs. After building, use `scripts/verify-package.mjs` to check the npm pack whitelist, dependency declarations, and SHA512. Tests, real configuration, state, logs, and dependency tarballs must not enter the package.

The npm package includes only whitelisted runtime files and user/security/release documentation; contributor guides remain in the source repository. Maintainer instructions are in the [npm publishing guide](.github/NPM_PUBLISH.en.md). Never overwrite published versions or publish on ordinary branch pushes.
