# Wicro Web Release Lifecycle

> **Release safety:** Do not run a web build, archive, tag, GitHub release, or Pages deployment arbitrarily. No bot, agent, scheduled workflow, Dependabot update, or automation may publish or deploy without the user's explicit confirmation. Building `apps/web/dist` for local validation is allowed only when intentionally requested; creating a release artifact or publishing it is a separate consent-requiring operation.

Wicro frontend releases are independent from LLVM WASM builds and use `web-vX.Y.Z` tags.
The LLVM WASM lifecycle remains `llvm-wasm-vX.Y.Z`.

## Frontend build

```sh
npm run build:web
npm run build:release:web
```

`build:web` remains the normal development and validation build. `build:release:web`
uses only the pinned prebuilt LLVM WASM artifacts from `toolchain/llvm-wasm/manifest.json`;
it never runs native LLVM compilation or publishes LLVM releases.

The release build:

1. Verifies or downloads the pinned `llvm.wasm` and `ld.wasm` release assets.
2. Stages compiler WASM files under `apps/web/dist/toolchain/`.
3. Stages available checksum-pinned SDK archives under `apps/web/dist/assets/`.
4. Generates canonical registry and example manifests through Vite.
5. Builds the frontend with a relative Vite base for subdirectory hosting.
6. Creates `artifacts/wicro-web-vX.Y.Z.zip` unless `--skip-archive` is supplied.

## GitHub Pages

`.github/workflows/pages.yml` has no push or tag triggers. It runs only through
`workflow_dispatch`, and the job is gated by an explicitly confirmed `confirm_release`
boolean input. The workflow uses `npm ci`, the production web build and the official
`actions/upload-pages-artifact` and `actions/deploy-pages` actions.

GitHub repository settings and the `github-pages` environment should also require
human approval if environment protection is available. Never run or approve this
workflow through an unattended automation loop.

Pages must use **GitHub Actions** as the deployment source.

## Asset caching

Pinned compiler and SDK bytes are verified before use and cached in browser OPFS.
Frontend updates preserve existing compiler and SDK cache keys for unchanged manifests.
The production frontend has no Node.js backend and performs compilation and linking in
its Web Worker.
