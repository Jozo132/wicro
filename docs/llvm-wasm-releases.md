# LLVM WASM Release Lifecycle

LLVM WASM releases are distributed as pinned GitHub Release assets. The repository must never depend on guessing a version from the npm package version, a build date, or an upstream LLVM tag.

## Version types

- **Wicro LLVM WASM distribution version:** Independent SemVer in `llvm-wasm-vMAJOR.MINOR.PATCH`. This is the published toolchain distribution version.
- **Upstream LLVM version:** The LLVM source line in `revisions.llvm-project`, retained in the manifest. It can stay unchanged across several Wicro distributions.
- **Espressif LLVM source revision:** `revisions.esp-wasm` and `revisions.llvm-project-commit` pin the source recipe and exact LLVM commit.
- **Wicro npm package version:** The version of the npm distribution package. It is unrelated to the toolchain distribution version.
- **Platform SDK version:** Arduino, ESP-IDF, Pico, STM32, and other SDK versions are independent. Changing SDK releases must not rewrite LLVM WASM release versions.

## Authentication

Install and authenticate GitHub CLI:

```bash
gh auth login
gh auth status
```

In CI, provide an existing `GITHUB_TOKEN` or `GH_TOKEN` with release and contents permissions. Never put credentials in repository files or logs.

## Commands

```bash
npm run release:llvm:status
npm run release:llvm:prepare
npm run release:llvm:dry-run
npm run release:llvm:publish
npm run release:llvm:verify
```

The available options are:

```text
--json
--verbose
--version=X.Y.Z
--bump=patch|minor|major
--tag=llvm-wasm-vX.Y.Z
--repo=owner/repo
--compression=none|br|gzip
```

`status` is read-only. `prepare` and `dry-run` do not upload or publish anything. `publish` is the only remote mutation command and additionally requires an explicit authorization phrase.

## First release

Confirm local artifacts and remote state:

```bash
npm run release:llvm:status -- --json
npm run release:llvm:prepare -- --bump=patch
npm run release:llvm:dry-run -- --json
```

With no matching published release, the proposed version is `1.0.0` and the tag is `llvm-wasm-v1.0.0`. Prepare writes a local plan under `toolchain/llvm-wasm/.release/`:

- `plan.json`
- `RELEASE_NOTES.md`
- `SHA256SUMS`

The plan is staging state and is not a published artifact.

## Patch, minor, and major releases

```bash
npm run release:llvm:prepare -- --bump=patch
npm run release:llvm:prepare -- --bump=minor
npm run release:llvm:prepare -- --bump=major
npm run release:llvm:prepare -- --version=2.4.1
```

The default is patch. The remote state is checked again immediately before preparation and publication. A published release, draft, prerelease, or tag-only collision for the proposed tag fails safely.

## Publication

Publication is never automatic:

```bash
npm run release:llvm:publish -- --publish-authorization=I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE
```

The workflow creates a draft, uploads `llvm.wasm`, `ld.wasm` when available, `manifest.json`, `SHA256SUMS`, and release notes, verifies names/sizes/hashes, publishes the draft, verifies the public assets, and then synchronizes repository manifests.

Do not rerun `publish` merely to retry a collision. If a draft remains, inspect it with:

```bash
gh release view llvm-wasm-v1.0.0 --repo Jozo132/wicro
```

Resume only after deciding whether the draft is complete and safe. The publication tooling does not overwrite published assets or move tags.

## Verification

After a public release:

```bash
npm run release:llvm:verify -- --json
```

Verification downloads published assets and independently compares GitHub asset sizes and SHA-256 hashes with the staged manifest.

## Cache behavior

Compiled binaries live under `toolchain/llvm-wasm/cache/` and are intentionally ignored by Git. `llvm.wasm` is the combined compiler artifact. `ld.wasm` is optional and is only published when independently present and valid. Existing consumers still receive the standalone linker only when the manifest declares it.

The release CLI rejects missing, truncated, malformed, or header-corrupt WASM binaries. Existing SHA-256 declarations are checked for changes and must pass the build/test workflow before publication.

## Compression

The default distribution is uncompressed WASM:

```bash
npm run release:llvm:prepare -- --compression=none
```

Brotli or gzip may be selected explicitly:

```bash
npm run release:llvm:prepare -- --compression=br
npm run release:llvm:prepare -- --compression=gzip
```

The manifest records both the distribution hash/size and the uncompressed hash/size. Raw `.br` and `.gz` assets are not assumed to be transparently decoded by an HTTP server. Browser consumers should configure the server's `Content-Encoding` or keep using uncompressed GitHub assets.

## Mirrors and browser distribution

GitHub Releases are canonical. `artifacts.<name>.url` is pinned to the immutable release tag, and `mirrors` can describe same-origin or CORS-enabled locations. Mirrors must contain byte-identical assets and preserve the same uncompressed SHA-256 identity. Browser and Node consumers validate downloaded bytes before caching or execution.

## Rollback and interrupted uploads

Never delete a published asset or rewrite a tag. If publication fails:

1. Read `toolchain/llvm-wasm/.release/draft.json` and the exact recovery instruction.
2. Inspect the draft with `gh release view <tag> --repo <repo>`.
3. Resume after checking uploaded names, sizes, and hashes.
4. If the draft is incomplete and no public assets exist, manually delete that draft and retry preparation.
5. If the public release is published, fix metadata only in a new distribution version.

## CI integration

A CI workflow should run only read-only/status and dry-run steps by default:

```yaml
- run: npm ci
- run: npm run release:llvm:status -- --json
- run: npm run release:llvm:dry-run -- --json
```

Real publication belongs in an explicitly triggered workflow with protected GitHub credentials and the exact authorization phrase. CI must recheck remote state and must not use `schedule` or pull-request events to publish automatically.

## Tests

Run unit and cross-platform release tests with:

```bash
npm run test:llvm-release
npm run test:llvm-build
npm run check:types
```

Real GitHub release integration is intentionally disabled. It is enabled only by setting `WICRO_LLVM_RELEASE_INTEGRATION=I-AUTHORIZE-Wicro-LLVM-WASM-RELEASE` in an explicitly authorized integration environment. That environment must target a throwaway repository or release tag and must still require maintainer confirmation.
