# Learnings

Transferable concepts that came up while building this project.

## Apple's interpreted-code rule is what makes OTA legal

Section 3.3.2 of the Apple Developer Program agreement permits downloading and
executing code only when it is *interpreted* — JavaScript running in an engine
the app already ships. Compiled native code can never be delivered this way.

**Why it came up:** it decides what "OTA updates for iOS" can even mean. Every
OTA system in this space (CodePush, EAS Update, this one) is a JS-bundle
delivery mechanism for exactly this reason, and none of them can update a
native module.

**Takeaway:** before designing around a platform capability, find the policy
that bounds it — the rule shapes the architecture more than the technology does.

## Content-addressed storage makes deduplication and cache-immutability free

Assets are stored under the SHA-256 of their own bytes. Two updates sharing an
unchanged image reference the same blob, so a publish only uploads what
actually changed. Because the address *is* the content, the URL can be served
with `cache-control: immutable` and a year-long max-age — the bytes at a given
URL can never change.

**Why it came up:** the Expo protocol requires immutable asset URLs and hashes
every asset anyway, so content-addressing was the natural fit.

**Takeaway:** when content is immutable, address it by its hash — dedupe,
cache-safety, and integrity verification all fall out of the same decision.

## Deriving a filesystem path from validated input beats sanitising it

The asset route matches `^[a-f0-9]{64}$` against the requested hash *before*
touching storage, then builds the storage key server-side from that validated
value. Client input never reaches a path join.

**Why it came up:** the asset endpoint takes an identifier straight from an
untrusted client, which is the classic path-traversal shape.

**Takeaway:** don't sanitise untrusted input into a path — validate it against
a strict format, then construct the path yourself. Rejecting uppercase hex
matters too: two spellings of one address means two cache entries for one blob.

## A healthcheck that has never failed is not a check

The container's healthcheck was verified in both directions: it exits 0 against
the live port and exits 1 against a dead one. Only the second run proves the
probe is wired to anything.

**Why it came up:** the probe is a plain `fetch(...).then(r => r.ok ? 0 : 1)`,
easy to get subtly wrong in a way that always reports healthy.

**Takeaway:** any gate — healthcheck, lint rule, CI check, test — must be shown
to fail on known-bad input before a pass from it means anything.

## A pipe erases the exit code of the command you were checking

`pnpm build | tail -12; echo $?` reported `0` for a build that had failed: `$?`
is `tail`'s status, not the build's. It briefly read as a passing build.

**Why it came up:** truncating noisy build output is a habit, and it silently
destroys the signal being checked.

**Takeaway:** when a command's exit code is the thing you care about, redirect
its output to a file and check the status unpiped — or use `PIPESTATUS`.
Formatting output and gating on it are two separate operations.

## `exactOptionalPropertyTypes` makes `{ x: undefined }` different from `{}`

Passing `transport: undefined` to Fastify's logger options is a type error
under this flag, and it also broke overload resolution so badly that Fastify
inferred an HTTP/2 server. Conditionally spreading (`...(cond ? { transport } : {})`)
fixed both.

**Why it came up:** the strict tsconfig turned a common "pass undefined to mean
absent" idiom into a compile error.

**Takeaway:** under `exactOptionalPropertyTypes`, build optional properties by
spreading them in, never by assigning `undefined`. A confusing overload error
on a call with an optional property is often this flag.

## A native prebuild pins a *runtime* glibc version your build never checks

The container built cleanly on `node:22-bookworm-slim` and then died on its
first `require()`: better-sqlite3's `linux-arm64.node` needs glibc 2.38 and
Bookworm ships 2.36. The build had even compiled the module from source — but
the loader prefers `prebuilds/` over `build/Release/`, so the working binary
was ignored in favour of the incompatible one.

**Why it came up:** every in-process test passed, the image built, and the
failure appeared only when the container was actually run.

**Takeaway:** a native module's prebuilt binary carries its own libc floor,
independent of your base image's Node version. "It built" says nothing about
whether it loads. Run the container as part of verifying it.

## `binding.gyp` alone makes package managers compile things nobody uses

better-sqlite3 declares no install script, yet pnpm ran `node-gyp rebuild` on
it — package managers auto-run a gyp build for any package carrying a
`binding.gyp`. That forced a C++ toolchain into the Docker image to produce a
binary the loader then ignored. Disabling the build (`allowBuilds: false`) cut
the toolchain, sped up installs, and changed nothing at runtime.

**Why it came up:** the pointless compile was the only reason the image needed
`python3`, `make`, and `g++` at all.

**Takeaway:** when a dependency triggers a native build, check whether it ships
prebuilds for your targets first. An unnecessary source build costs image size,
build time, and a much larger attack surface.

## A premise you never tested will quietly shape the architecture

"better-sqlite3 publishes glibc prebuilds only" was written into a design
decision, and it chose the base image, the toolchain, and the image size. The
package actually ships eight prebuilds including two musl ones. Testing the
claim took two minutes and made the image 28% smaller.

**Why it came up:** the assumption was plausible, load-bearing, and never
stated as something to verify.

**Takeaway:** when a decision record says "X is impossible because Y", Y is a
claim with an expiry date. Test the ones that are cheap to test, especially the
ones doing the most architectural work.

## A package that only typechecks via its test files' imports is under-declared

`packages/core` used `node:crypto` and `Buffer` without depending on
`@types/node`. It typechecked anyway, because its tsconfig also included test
and config files whose imports pulled the types in transitively. A build config
scoped to `src/` alone exposed it immediately.

**Why it came up:** adding a declaration-only build step narrowed the file set
and surfaced seven errors in code that had been "passing" all along.

**Takeaway:** typecheck the shipped surface in isolation, not just the whole
repo. A dependency reached through a test file is not a declared dependency.
