# Third-party libraries and packages

Open **Libraries** in `npm run dev:web`. Search Arduino Library Manager or
PlatformIO Libraries, choose a version, and add it to the project. The package
browser shows descriptions, declared dependencies, exact installed versions, and
read-only package files such as README, license, headers, sources, and examples.
Archive URL imports accept ZIP or TAR.GZ source packages with an exact version and
trusted SHA-256. A library manifest (`library.properties` or `library.json`) is
required. PlatformIO platforms and native toolchains are not interchangeable with
Wicro source libraries.

## Project declarations and locks

```json
{
  "name": "oled-mqtt",
  "board": "esp32-c3-supermini",
  "framework": "arduino",
  "build": { "sources": ["main/main.ino"] },
  "libraries": [
    { "provider": "arduino", "name": "Adafruit SSD1306", "version": "2.5.17" },
    { "provider": "platformio", "owner": "knolleary", "name": "PubSubClient", "version": "2.8" }
  ]
}
```

A build also installs libraries declared directly in `wicro.json`; clicking Add
first is optional. The shared engine resolves transitive dependencies from the
catalog and library manifests and writes `wicro-libraries.lock.json` with the
resolved version graph, artifact URLs, and hashes. Commit that lock alongside the
project to reproduce its dependency versions. Existing locks are reused instead
of upgrading dependencies during a build. To resolve different versions, edit the
root declarations or remove the lock deliberately. Conflicting dependency version
constraints fail rather than selecting a different package silently.

Versions such as PlatformIO's `2.8` are preserved as upstream labels while being
compared as `2.8.0` for compatible SemVer constraints. Ambiguous ownerless
PlatformIO dependencies require an explicit owner/name. Conditional dependencies
and build behaviors outside the supported manifest subset report a compatibility
error instead of being guessed.

Package downloads are checked against catalog SHA-256 identities before
extraction. ZIP and TAR.GZ support validates archive paths and rejects TAR links.
License and other package files are retained. Extracted file hashes are checked
on cache reuse. Browser libraries use OPFS; Node uses the host's persistent library
cache. Offline builds require both the project lock and cached library sources,
compiler, and board SDK. Direct project dependencies remain separate from
transitive and framework dependencies in the UI. Removing a direct dependency
causes the next build to resolve the remaining graph; cached sources remain.

The browser saves the current project's text files, declarations, and lock in a
local browser snapshot so they survive reloads. Storage failures are reported in
Compiler Output. Library sources remain in OPFS, not in the snapshot or application
bundle. The current snapshot is local to that browser origin; it is not a remote
repository or a multi-project workspace.

## Compilation and target support

The same core engine compiles the actual C/C++/assembly library sources with WASM
and includes their objects in firmware linking. It stages library include trees,
supports modern `src`/`include` and legacy Arduino root/`utility` layouts, records
library units in `compile_commands.json`, and includes dependency header contents
in browser object-cache identities. Locked library headers are also available to
browser diagnostics and completion. The supported PlatformIO `build` fields are
`srcDir`, `includeDir`, ordinary compiler `flags`, and `libArchive` (Wicro links
compiled source objects directly). Custom directory-bearing flags, source filters,
required generators, and precompiled target libraries require explicit recipes.

This does not make every registry library compatible with every board. Architecture
and declared framework constraints are checked; actual SDK/header/ABI compatibility
is established by compiling and linking for the selected target.

The ESP32-C3 provider `arduino-esp32-buses` supplies genuine Wire and SPI sources
from Arduino-ESP32 commit `5e19e086c43d0fa5e5a596497ff8f11a0a43f6c2` (2.0.17),
matching the staged SDK. It downloads individual checksum-pinned upstream files
and license metadata only when imported libraries include Wire/SPI headers. It
does not replace missing board-core facilities for other presets.

The `esp32-c3-supermini/oled-mqtt` example uses real SSD1306, GFX, BusIO,
Wire/SPI, and PubSubClient code. Browser compilation/linking has been verified;
OLED display operation, wiring, and MQTT connectivity have not been physically
verified by these tests. The example needs board-specific I2C wiring and a connected
Arduino Client before it can perform useful hardware/network work.

## Browser downloads and production deployment

Arduino's library catalog and library ZIP URLs were directly browser-readable in
the live acceptance test. PlatformIO's API was readable, but its initial archive
redirect returned duplicate CORS allow-origin headers that Chromium rejected.
The destination CDN object was browser-readable.

Vite therefore provides `GET /api/library-download?url=...`, a metadata-only resolver.
It accepts only official `https://dl.registry.platformio.org/download/` URLs, issues
a server-side HEAD request without following the archive response, validates the
returned official `/libraries/` destination, and returns that URL as JSON. The
browser downloads the archive directly from PlatformIO and still verifies its
SHA-256. The resolver does not serve vendor archive bytes or act as a general
proxy. Resolved immutable CDN URLs are recorded in project locks.

A static production build does not include that server endpoint. For new
PlatformIO imports affected by the redirect issue, deploy an equivalent endpoint
using `apps/web/platformio-download.js` and configure
`VITE_WICRO_LIBRARY_METADATA_URL` at build time. An endpoint must implement the
same `?url=` request and `{ "url": "https://..." }` response contract. If hosted
on another origin, it must grant CORS to the app. Alternatively, use an already
resolved direct CDN URL in a checksum-pinned archive declaration or project lock.
Node downloads do not require this browser CORS workaround. SDK/compiler browser
access requirements remain documented separately in `remote-assets.md`.

## PlatformIO Python pre/post scripts

PlatformIO `extra_scripts` run inside Python and SCons construction environments.
They can modify compilers, build graphs, generated files, and upload actions;
running the same file through a standalone Python interpreter does not reproduce
that environment. See the official [Advanced Scripting documentation](https://docs.platformio.org/en/latest/scripting/index.html).

Wicro does not execute these hooks or pretend they ran. Declared project
`extra_scripts` and library `build.extraScript` requirements stop import/build with
an explicit explanation. A Python helper merely included in documentation or used
upstream to generate a checked-in header is not considered a required build hook.

The recommended migration is to inspect each hook's required effects and encode
those effects in reviewed shared Wicro ESM platform recipes or explicit project
configuration: flags and defines in `build.flags`/`build.defines`; source selection
in `build.sources`; generated files, image transformations, and upload operations
in implemented host-neutral recipe steps. Those implementations must be tested in
the intended hosts. No general Python/SCons compatibility runtime is implemented.
Adding Python WASM alone would not supply SCons/PlatformIO APIs or native tool
executables, and running native PlatformIO as a fallback would violate the shared
WASM build contract. Script-dependent packages stay explicitly unsupported until
their required operations have real implementations.

## Verification

```sh
# Local HTTP catalogs/ZIP/TAR.GZ, cache integrity, hooks, and real WASM source linking
node --test packages/registry/test/libraries.test.js tests/library-build.test.js

# Opt-in network acceptance: genuine upstream imports and byte-identical offline rebuild
npm run test:libraries:live
```

The live test drives the real browser UI, imports upstream libraries, browses
package files, builds a validated ESP32-C3 firmware image, reloads the app, and
rebuilds with external network requests blocked. It requires Chrome plus the staged
compiler/ESP32-C3 SDK used by `tests/web-ide.test.js`. Ordinary tests do not replace
vendor libraries with mock versions or silently assert hardware functionality.
