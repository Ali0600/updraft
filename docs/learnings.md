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

## Content addressing turns "upload the build" into "upload what changed"

Publishing asks the server which blob hashes it lacks, then uploads only those.
A repeat publish of an unchanged export transfers zero bytes, and iOS and
Android share every common asset rather than uploading it twice — 3.1 MB became
0 MB on the second publish of a real export.

**Why it came up:** mobile bundles are megabytes and most publishes change only
the JS, so re-uploading unchanged assets every time is nearly all of the cost.

**Takeaway:** when content is immutable and addressed by its hash, a
"what do you already have?" round trip before uploading is a few lines of code
and removes most of the transfer. The same shape works for Docker layers, CI
caches, and asset pipelines generally.

## Two hashes over the same bytes can mean two different things

Each asset carries a SHA-256 (base64url) *and* an MD5. They are not redundant:
SHA-256 addresses and verifies the bytes, while MD5 is Metro's logical asset
identity — an exported asset is literally named after its MD5, which is how a
client recognises an asset already embedded in its binary and skips the
download.

**Why it came up:** it looked like duplication until the reason for each was
clear; collapsing them would have broken the client's embedded-asset matching.

**Takeaway:** before deduplicating two hashes of the same data, ask what
question each one answers. "Are these bytes intact?" and "is this the same
logical thing?" are different questions, and an ecosystem convention often
answers the second.

## Secrets belong in `env:`, not in action inputs

GitHub Action inputs are echoed into workflow logs, so a token passed as an
input is a token printed in CI output. The publish token is therefore read from
the environment in both the CLI and the Action, and never accepted as a flag or
an input.

**Why it came up:** an input is the natural place to put it, and the leak is
invisible until someone reads a log.

**Takeaway:** for any credential, the interface should make the safe path the
only path — no flag, no input, environment only. Assert it: a test greps the
action definition for a token input and fails if one appears.

## Leftover build output makes a broken build look fine

`packages/cli/dist/index.js` imports `@ota/core/dist` at runtime, and nothing
built core before building the CLI. Locally `core/dist` always existed from
some earlier build, so it worked every single time. The first CI run — the
first clean checkout in the project's life — failed three jobs on it.

**Why it came up:** a developer machine accumulates artifacts. The dependency
was satisfied by history rather than by the build.

**Takeaway:** `rm -rf` every build output and run the whole thing before
trusting a build graph. In a monorepo, build a package's dependencies
explicitly (`pnpm --filter 'pkg...' build`) rather than relying on them
happening to be there.

## An `engines` field is a claim, and claims need testing

`package.json` said `node >= 20` and the README repeated it. pnpm 11 imports
`node:sqlite` and requires >= 22.13, so `pnpm install` could not run on Node 20
at all. The floor had never been true; it had also never been tested, because
the CI matrix that would have caught it had never run.

**Why it came up:** the number was written once, plausibly, and then believed.

**Takeaway:** a supported-version claim is only as good as the CI job that
exercises it. Test the floor you advertise, and when the toolchain moves the
floor, move the claim — don't work around it to preserve a number nobody
verified.

## A parser that depends on terminal formatting is not a parser

The mutation harness matched vitest's `Tests 158 passed (158)` summary. In CI
that line arrives wrapped in ANSI colour codes, so the regex found nothing, and
the harness reported "baseline is not green" for a suite that had just passed
158/158. It also read only stdout on success while reading both streams on
failure — an asymmetry that hid where the output had gone.

**Why it came up:** the output looked identical to a human in both places.

**Takeaway:** when parsing another tool's output, strip ANSI, pin the reporter,
disable colour, and read both streams — the shape should not depend on the
environment. And always print the raw output when parsing fails: an
unparseable run and a failing run are otherwise indistinguishable, which turns
one diagnosis into several round trips.

## Bind-mounted secrets collide with container users, and only on Linux

`keys generate` writes the signing key mode 0600 owned by whoever ran it. The
container runs as uid 1000. Docker Desktop on macOS maps ownership so the
mount just works; on Linux the container gets EACCES and the server refuses to
start. Every local run passed; CI failed immediately.

**Why it came up:** the file permission is correct, the container user is
correct, and the combination is still broken on the platform you deploy to.

**Takeaway:** a bind-mounted secret must be readable by the container's uid,
and macOS will not tell you when it isn't. Prefer passing secrets through the
environment where ownership is awkward, keep the restrictive mode, and document
the uid requirement for the mount path.

## "Not found" from a remote store may not mean what you assume

The S3 driver's whole job is translating errors into the interface's
`undefined` for "absent". The obvious predicate — HTTP 404 — is wrong, and only
a real server showed why. Measured against MinIO:

| call | missing key | missing bucket |
| --- | --- | --- |
| `GetObject` | `NoSuchKey` (404) | `NoSuchBucket` (404) |
| `HeadObject` | `NotFound` (404) | `NotFound` (404) |

A status check would have reported a **typo'd bucket name as an empty store**:
every asset 404s, publishing appears to work, and the server looks healthy.
Matching by error *name* fixes `GetObject`. `HeadObject` cannot be fixed at all
— it answers with an empty body, so the two cases are byte-identical. That is a
protocol limit, now pinned by a test and routed around (readiness reads rather
than stats).

**Why it came up:** the contract suite ran against real MinIO rather than a
mock. A mock would have required *inventing* these error shapes — that is,
encoding the assumption being tested.

**Takeaway:** when a dependency reports failures as errors, enumerate the real
error shapes against a real instance before writing the predicate that
classifies them. Ask specifically which *distinct* failures collapse into the
same response, because those are the ones your code cannot distinguish no
matter how carefully it is written.

## A client integration is only proven by the client

The server was verified against the specification, Expo's reference server, two
independent crypto libraries, and real Metro output — and still, running it
against the actual `expo-updates` client was the only thing that could answer
whether a `noUpdateAvailable` directive is accepted where the reference server
sends one only in a narrower case. It was, but nothing short of the device
could have established that.

The device run also surfaced three request headers absent from the spec
(`expo-updates-environment`, `expo-api-version`, `expo-json-error`) — harmless,
but unknowable from documentation.

**Why it came up:** every earlier layer of testing validated the server against
a *description* of the client rather than the client.

**Takeaway:** when implementing a protocol against a specific consumer, budget
for one real integration run. Capture the actual traffic (a logging proxy in
front of the server costs fifteen lines) — what the client sends is ground
truth, and the gap between it and the spec is where the bugs live.

## Prove a security check rejects, not just that it accepts

Code signing worked on the device: the client demanded a signature, the server
provided one, the update applied. That proves signatures are *produced*. It
does not prove they are *checked* — an app that ignored signatures entirely
would look identical. Pointing the server at a different key pair with the same
`keyid` and confirming the device refused the update is what closed the gap.

**Why it came up:** the happy path passing is the exact condition under which
nobody looks closer.

**Takeaway:** for any verification step — signatures, checksums, auth,
certificate pinning — the passing case and the absent case are
indistinguishable. Always run the negative: serve something that *should* be
rejected and confirm it is.

## Where a spec is silent, the reference implementation is the real standard

The Expo Updates spec defines `rollBackToEmbedded` but never says what to send
when there is simply nothing to apply, nor what exact bytes a signature covers.
Both answers came from reading Expo's own reference server: sign
`JSON.stringify(body)` with no canonicalization, and answer protocol 1 with a
`noUpdateAvailable` directive rather than a bare `204`.

**Why it came up:** implementing code signing surfaced that a `204` has no body
and therefore cannot be signed — a gap the prose never addresses.

**Takeaway:** when implementing a published protocol, treat the spec as
necessary but not sufficient. The widely-deployed implementation defines what
clients actually accept; read it for everything the spec leaves open, and write
down which behaviours came from where.

## Sign the bytes you send, not a value you re-serialize

The signature covers the exact string placed in the response body. Serializing
once for signing and again for sending is a latent mismatch: nothing guarantees
two `JSON.stringify` calls produce identical bytes across versions or key
ordering, and the client verifies what it received.

**Why it came up:** the natural shape — `sign(payload)` then `send(payload)` —
invites serializing twice. A mutation that signs `body + " "` instead of `body`
confirmed the tests catch it.

**Takeaway:** for anything signed, hashed, or checksummed, produce the bytes
once and use that same value for both the cryptography and the transmission.
Any transform between the two silently breaks verification.

## A mutation test's patterns rot when you refactor the code they target

Two sabotage patterns written in M1 stopped matching after M2 rewrote those
files. Without a guard they would have been silent no-ops reported as passing
guards — the harness would have claimed 100% coverage while testing nothing.

**Why it came up:** the harness asserts the search text exists before editing,
and flags `PATTERN-NOT-FOUND` as a failure. That check caught both.

**Takeaway:** a mutation/sabotage harness needs to fail loudly when its target
text is missing, not skip quietly. Any test fixture that references code by
literal text — sabotage patterns, snapshot keys, doc examples — needs a
liveness check, or refactoring silently disarms it.

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
