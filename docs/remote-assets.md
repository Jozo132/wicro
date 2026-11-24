# Remote SDK and compiler assets

Wicro can fetch SDK ZIPs and compiler WASM artifacts directly from their existing
hosts. A Node/CLI download succeeding does not establish that a browser can read
that URL. The remote server must grant CORS access to the web application's origin,
including any redirects in the download chain. Wicro's own CORS response headers
cannot grant access to another server. `mode: no-cors` produces an unreadable opaque
response and cannot be used to extract a ZIP or verify its checksum.

## Acquisition behavior

- SDK distributions use `metadata.distribution.url`, `mirrors`, and `sha256` in
  `registry/<package>/package.json`. Compiler distributions use `artifacts` in
  `registry/llvm-wasm/package.json`.
- Public downloads use credential-free CORS GET requests, follow redirects, and
  have a 120-second timeout. Network errors include CORS/CSP diagnostic guidance;
  JavaScript cannot reliably distinguish CORS, DNS, TLS, and other network failures.
- SDK and compiler downloads verify each candidate's checksum before accepting it.
  An HTTP 200 HTML fallback or corrupted download does not prevent trying mirrors.
  SDK manifests must specify a trusted SHA-256 before any download is attempted.
- Shared SDK/compiler managers retry each candidate up to three times. The web
  build worker's SDK acquisition tries each candidate once and reports all failures.
- The production web build includes registry metadata, not compiler WASM or SDK
  archives. The browser resolves the compiler from the canonical registry manifest;
  there is no separate web-only compiler manifest to keep synchronized.
- During Vite development only, the cached local compiler is an explicit first
  source, and `dist/assets/<sdk-name>-<version>.zip` is a final SDK candidate.
  Production SDK acquisition uses only the manifest's URL and mirrors.
- Successfully verified downloads are cached in browser OPFS or the Node filesystem.
  The browser worker verifies its cached SDK archive before extraction; the shared
  SDK manager verifies extracted file hashes. Offline reuse requires a populated
  cache. A cold browser cache still needs an accessible download source.

Use immutable versions/commits and verified SHA-256 identities. Another CDN may
recompress an archive differently; do not assume it has the same hash. Keep all
source and binary redistribution license obligations when arranging mirrors.

## Verification

```sh
# Deterministic real HTTP servers and Chromium worker; no vendor downloads needed.
npm run test:remote-assets

# Live Node and Chromium GET reachability/CORS checks against registry URLs.
npm run check:remote-assets
npm run check:remote-assets -- --package=pico-sdk
```

The deterministic test exercises CORS denial, a permitted cross-origin ZIP,
redirects, missing resources, checksum failures, mirror recovery, real ZIP
extraction, WASM compilation, persistent OPFS reuse after reload, and Node/browser
access differences. Chromium must be installed on the `chrome` channel; missing
browser support fails the test instead of skipping it.

The live probe emits one JSON record per URL and exits nonzero if either host
cannot access a candidate. It uses GET and cancels bodies after reading headers;
**it does not verify the full archive, SHA-256, SDK completeness, or firmware builds**.
It uses a local application origin. Recheck from the deployment origin if a host
uses an origin-specific CORS allowlist or the deployment adds CSP restrictions.

On 2026-11-24, the live probe of all 17 configured URLs found:

| Configured source | Node GET | Chromium GET |
| --- | --- | --- |
| Seven upstream source archives and their GitHub archive mirrors (14 URLs) | HTTP 200 | Blocked; Codeload permits `https://render.githubusercontent.com`, not the probe origin |
| Wicro LLVM WASM release artifacts (2 URLs) | HTTP 200 | Failed; final Node responses had no CORS allow-origin header |
| Wicro ESP32-C3 SDK release ZIP (1 URL) | HTTP 404 | Failed |

These results establish deployment blockers, not successful remote browser builds.
The existing browser IDE build test uses staged development assets and therefore
cannot establish upstream CORS compatibility.

## Avoiding a vendor mirror

For Node and CLI environments, upstream archives can remain direct references.
For a browser deployment, use an existing upstream distribution only after testing
its actual URL, redirects, checksum, archive format, and contents. A usable source
archive must also contain all required SDK submodules and precompiled libraries.

A CDN's GitHub file service is not automatically a service for GitHub-generated
repository ZIPs or release attachments. Per-file CDN loading would require a
separate versioned file inventory and integrity/cache strategy. No replacement CDN
is configured without verifying the actual artifacts.

When the required artifact has no browser-accessible upstream distribution, the
remaining choices are an upstream CORS change, an explicitly configured relay under
your control, local desktop/CLI acquisition, or a license-compliant artifact mirror.
A relay avoids publishing copies as release assets but still transfers vendor
bytes through your infrastructure. Public CORS proxies are not configured.

Wicro's custom LLVM WASM build and curated ESP32-C3 SDK are distinct from generic
upstream compiler/SDK source archives. An unrelated toolchain CDN cannot replace
them without confirming target support, ABI, contents, and build compatibility.
