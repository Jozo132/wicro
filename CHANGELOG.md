# Changelog

## 0.2.0 - 2026-11-26

### Frontend release

- Added the independent `web-v0.2.0` frontend release line.
- Added relative-base GitHub Pages builds that work under `/wicro/` and other static subdirectory hosts.
- Added pinned LLVM WASM and staged SDK assets to production distributions with SHA-256 verification and OPFS reuse.
- Added `npm run build:release:web` and the confirmation-gated, manual-only GitHub Pages Actions deployment workflow.
- Added an explicit no-automated-release policy: builds, archives, tags, GitHub releases and deployments require user consent.
- Preserved the existing LLVM WASM `v1.0.0` toolchain release and release conventions.

### Validation

- Existing web, CLI, VS Code, registry, WASM and browser integration tests remain the release gate.
- GitHub Pages deployment is static-only and does not use server-side compilation.
