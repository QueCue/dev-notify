# Automated npm publishing

English | [简体中文](NPM_PUBLISH.md)

Workflow: `.github/workflows/publish-npm.yml`, displayed as **Publish npm** on the GitHub Actions page.

Uses npm Trusted Publishing (OIDC), with no `NPM_TOKEN`, `NODE_AUTH_TOKEN`, password, or OTP secret configured. The workflow runs on GitHub-hosted runners with fixed Node.js 24 and npm 11.21.0; only the publish job has `id-token: write`, while the test job does not.

## One-time npm setup

A package maintainer logs in to npm, opens the package settings for `@quecue/dev-notify`, selects **GitHub Actions** under **Trusted Publisher**, and fills in:

| Field | Value |
| --- | --- |
| GitHub user/organization | `QueCue` |
| Repository | `dev-notify` |
| Workflow filename | `publish-npm.yml` |
| GitHub environment | Leave empty; the current workflow does not configure an environment |

Fields are case-sensitive; the workflow field takes only the filename, not the `.github/workflows/` path.

Allow this trusted publisher to execute `npm publish` directly, and enable **Allow npm dist-tag**. Direct publish permission is not tag management permission; without the latter, the version may be published but tag updates such as `latest` fail. Saving the configuration does not necessarily validate the fields; under current npm rules, a new trusted publishing configuration must complete its first successful publish within two days of creation, otherwise it must be recreated.

If npm requires browser-based Windows Hello, passkey, or other account second-factor authentication, the maintainer completes it on the web page. Do not put authentication material into the repository or chat.

## First publish of the existing alpha.3 tag

`v0.1.0-alpha.3` has already been pushed; the new workflow will not retroactively trigger for old tags, and old tags should not be deleted or re-tagged.

1. Commit the workflow to the GitHub default branch.
2. Open the repository's **Actions → Publish npm → Run workflow**.
3. Select the `main` branch containing this workflow and enter `v0.1.0-alpha.3` for `tag`.
4. This run has confirmed updating both `alpha` and `latest`, so check **update_latest**.
5. Run the job. The job reports publish complete only if regression tests, the pack whitelist, remote tarball integrity, and target tags all verify successfully.

A manual run builds the workflow run's commit rather than secretly checking out another commit; this makes the automated provenance correspond to the actual build commit. You can add or modify `.github/` configuration and `test-js/` tests that do not enter the npm package; all other release source must be identical to the existing version tag, and the workflow enforces a diff gate. Tests must still all pass; they are not skipped because test fixes are allowed. If `main` already contains other source or documentation changes, the job will refuse to publish with the old version tag, and a new version and tag must be prepared first.

## Subsequent releases

After completing the version update and regression, commit `package.json`, `package-lock.json`, and the release notes, then create and push a `v*` tag that exactly matches the version:

- `v0.1.0-alpha.4` → npm `alpha`.
- `v0.1.0-beta.1` → npm `beta`.
- `v0.1.0-rc.1` → npm `rc`.
- `v0.1.0` → npm `latest`.

Only official versions or `alpha.N`, `beta.N`, and `rc.N` are supported here. Pushing a normal branch does not publish automatically. A prerelease does not overwrite `latest` by default; only a maintainer manually running the workflow and explicitly checking `update_latest` updates it additionally. This operation changes the default version for tagless installs and should be used with caution.

## Failures and reruns

- Version tag mismatch, source mismatch with the tag, build/test failure, or an abnormal package whitelist: fail before publishing and do not upload to npm.
- OIDC/permission configuration errors: check the npm repository case, workflow filename, direct publish permission, and tag management permission; do not add a token workaround.
- npm query network error: do not treat it as the version not existing, and do not publish blindly.
- Publish process failure or unknown result: do not automatically resend; rerun the workflow after verifying the status.
- After npm returns acceptance, not all registry read nodes are immediately visible; version integrity switches to direct registry version endpoint queries with a cache-buster, waiting up to about 10 minutes, and tag visibility waits up to about 1 minute. Timeouts clearly distinguish "publish accepted" from "not yet verified/tag updated", without claiming the version was not published or automatically resending.
- Version already exists: skip the duplicate publish only if the remote SHA-512 exactly matches this verified package, and continue verifying/completing the target tags; different content must use a new version number and cannot overwrite a version.
- Linux CI is not real-machine acceptance on Windows/macOS; platform-specific tests may be skipped. Previous Windows two-sided question-answering acceptance records are in CHANGELOG.en.md.

Actual publish records are authoritative via Actions logs, step summaries, and the npm registry. Configuration files passing local checks does not mean GitHub OIDC publishing has been accepted.

## Official documentation

- https://docs.npmjs.com/trusted-publishers
- https://docs.npmjs.com/generating-provenance-statements
