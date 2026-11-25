# Web IDE dependency downloads

Compiler, SDK and library archive downloads use a single transfer panel with
received/total bytes, estimated speed and remaining time. Unknown totals use an
indeterminate bar and no invented ETA. Network progress is throttled to five
updates per second and is not appended to compiler output for every chunk.
Compilation messages and errors remain in compiler output.

Pause aborts the active network request and retains received chunks in the current
worker session. Resume requests the remaining bytes only when the server provides
a strong ETag and range support; a matching HTTP 206/Content-Range/ETag is required
before concatenating data. If byte resume is unavailable, the panel states that
resuming will restart the current file. A server that ignores Range restarts the
file rather than combining different responses. A malformed range response fails.

Cancel aborts the request and exits the operation without trying another mirror.
Completed verified cache entries are retained; partial bytes are not installed as
valid compiler/SDK/library packages. Paused partial transfers are currently held
in memory, so closing/reloading the IDE loses them. SHA-256 verification remains
required before cache installation or use. Download inactivity times out after
two minutes without data, rather than imposing a two-minute total download limit;
paused time does not count toward the inactivity timeout.

The controls apply while transfer bytes are being acquired. WASM compilation,
archive extraction and hashing are separate stages. ETA describes the current
file, not the remaining build. A reload can reuse completed persistent cache
entries; it cannot resume an incomplete file from a previous worker session.

Tests cover real HTTP range resume/restart/cancellation and real Chromium worker
controls during a throttled transfer of the actual LLVM compiler, including the
absence of per-chunk log spam. No server-side scheduler or native downloader is
required.
