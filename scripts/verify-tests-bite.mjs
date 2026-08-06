// Fail-first harness: break one guard at a time and confirm the suite notices.
//
// Guards against the ways this check can lie to you:
//  - the pattern must actually exist (otherwise "sabotage" is a no-op),
//  - the file hash must CHANGE after writing and return to the original after
//    restoring,
//  - the test TOTAL must equal the baseline (a shrunken denominator means a
//    file failed to import, so the run proved nothing).
//
// Patterns match source text literally, so refactoring — or merely the
// formatter re-wrapping a line — can stale one out. That is reported as
// PATTERN-NOT-FOUND and exits non-zero rather than passing silently; re-anchor
// the pattern against the current source when it happens. Run this after
// `pnpm lint:fix`, not before.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (p) => resolve(ROOT, 'packages/server/src', p);
const C = (p) => resolve(ROOT, 'packages/cli/src', p);

const SABOTAGES = [
  {
    label: 'manifest: drop expo-sfv-version response header',
    file: S('routes/manifest.ts'),
    find: ".header('expo-sfv-version', '0')\n",
    replace: '',
  },
  {
    label: 'manifest: answer 200 instead of 204 for "no update"',
    file: S('routes/manifest.ts'),
    find: 'return reply.code(204).send();',
    replace: 'return reply.code(200).send();',
  },
  {
    label: 'manifest: never return 406 for an unacceptable accept header',
    file: S('routes/manifest.ts'),
    find: "    return 'json';\n  return undefined;\n}",
    replace: "    return 'json';\n  return 'multipart';\n}",
  },
  {
    label: 'resolver: ignore the platform filter',
    file: S('services/updateResolver.ts'),
    find: '        eq(updates.platform, request.platform),\n',
    replace: '',
  },
  {
    label: 'resolver: ignore the channel filter',
    file: S('services/updateResolver.ts'),
    find: '        eq(updates.channelId, channel.id),\n',
    replace: '',
  },
  {
    label: 'resolver: ignore the runtime-version filter',
    file: S('services/updateResolver.ts'),
    find: '        eq(updates.runtimeVersion, request.runtimeVersion),\n',
    replace: '',
  },
  {
    label: 'resolver: re-serve an update the client already runs',
    file: S('services/updateResolver.ts'),
    find: "  const kind = request.currentUpdateId === update.id ? 'upToDate' : 'manifest';",
    replace: "  const kind = 'manifest' as const;",
  },
  {
    label: 'resolver: serve updates regardless of status',
    file: S('services/updateResolver.ts'),
    find: "        eq(updates.status, 'active'),\n",
    replace: '',
  },
  {
    label: 'resolver: repeat the launch asset inside the assets array',
    file: S('services/updateResolver.ts'),
    find: '.filter((asset) => asset.id !== launchAsset.id);',
    replace: ';',
  },
  {
    label: 'manifestBuilder: emit hex instead of base64url asset hashes',
    file: S('services/manifestBuilder.ts'),
    find: 'hash: asset.sha256Base64Url,',
    replace: 'hash: asset.sha256Hex,',
  },
  {
    label: 'manifestBuilder: emit relative asset URLs',
    file: S('services/manifestBuilder.ts'),
    // Re-anchored in M4: the base became configurable and the path is now
    // derived from the storage key.
    find: 'url: `${base}/${assetStorageKey(asset.sha256Hex)}`,',
    replace: 'url: `/${assetStorageKey(asset.sha256Hex)}`,',
  },
  {
    label: 'metrics: serve the scrape without a token',
    file: S('routes/metrics.ts'),
    find: "  app.addHook('onRequest', requireBearerToken(config.PUBLISH_TOKEN));",
    replace: '',
  },
  {
    label: 'metrics: label requests with the raw URL instead of the route pattern',
    file: S('routes/metrics.ts'),
    // An attacker-controlled label is unbounded series, i.e. remote memory
    // exhaustion — not a monitoring-hygiene issue.
    find: "    const route = request.routeOptions.url ?? 'unmatched';",
    replace: '    const route = request.url;',
  },
  {
    label: 'metrics: label manifests with the raw platform header',
    file: S('metrics.ts'),
    // Anchored on the mapper, not on a call site. The call after header
    // validation is provably a no-op there (the value is already narrowed to
    // a Platform), so sabotaging it changes nothing; the load-bearing use is
    // the client-error path, where the raw header arrives unvalidated.
    find: "  return platform === 'ios' || platform === 'android' ? platform : 'unknown';",
    replace: "  return (platform ?? 'unknown') as Platform | 'unknown';",
  },
  {
    label: 'readiness: report ready while storage is failing',
    file: S('services/readiness.ts'),
    find: '      ready: database && storage,',
    replace: '      ready: true,',
  },
  {
    label: 'readiness: probe dependencies on every request',
    file: S('services/readiness.ts'),
    // Without the cache, an unauthenticated endpoint turns one free HTTP
    // request into one paid object-store request at any rate a caller likes.
    find: '    if (cached && now - cached.at < PROBE_TTL_MS) return cached.report;',
    replace: '    if (false) return cached.report;',
  },
  {
    label: 'readiness: leak dependency error detail to unauthenticated callers',
    file: S('routes/health.ts'),
    find: '          checks: report.checks,',
    replace: '          checks: report.checks,\n          detail: JSON.stringify(report),',
  },
  {
    label: 'healthz: make liveness depend on the object store',
    file: S('routes/health.ts'),
    // A liveness probe that fails when S3 is down causes restarts that cannot
    // possibly help.
    find: "  app.get('/healthz', async () => ({ status: 'ok' }));",
    replace:
      "  app.get('/healthz', async (_r, reply) => {\n    const report = await readiness();\n    return reply.code(report.ready ? 200 : 503).send({ status: 'ok' });\n  });",
  },
  {
    label: 'rate limit: authenticate before limiting, leaving the token unprotected',
    file: S('routes/admin.ts'),
    // The ordering bug this milestone actually hit: hooks run in registration
    // order, so reversing these lets an unauthenticated flood collect 401s
    // without ever reaching the limiter.
    find: "  app.addHook('onRequest', rateLimitHook(app, config));\n  app.addHook('onRequest', requireBearerToken(config.PUBLISH_TOKEN));",
    replace:
      "  app.addHook('onRequest', requireBearerToken(config.PUBLISH_TOKEN));\n  app.addHook('onRequest', rateLimitHook(app, config));",
  },
  {
    label: 'rate limit: throttle the device paths too',
    file: S('app.ts'),
    find: '  await app.register(assetRoutes, { db, storage: instrumented, metrics });',
    replace:
      "  await app.register(assetRoutes, { db, storage: instrumented, metrics });\n  app.addHook('onRequest', rateLimitHook(app, config));",
  },
  {
    label: 'admin errors: flatten a rate-limit 429 into a 500',
    file: S('routes/admin.ts'),
    find: "    if (typeof status === 'number' && status >= 400 && status < 500) {",
    replace: '    if (false) {',
  },
  {
    label: 'upload: accept any string as a media type',
    file: S('services/publishService.ts'),
    // In direct mode a CDN echoes this value, so an unvalidated one is header
    // injection into a response we do not control. Re-anchored: the check
    // moved into the shared isValidMediaType predicate.
    find: "  return MEDIA_TYPE.test(type?.trim() ?? '');",
    replace: '  return true;',
  },
  {
    label: 'publish: accept any string as an asset content type',
    file: S('routes/admin.ts'),
    // The publish payload's contentType is echoed as a response header too.
    find: "    .refine(isValidMediaType, 'contentType must be a valid media type'),",
    replace: "    .refine(() => true, 'contentType must be a valid media type'),",
  },
  {
    label: 'assets: serve without the nosniff/attachment guards',
    file: S('routes/assets.ts'),
    // These are what stop a text/html asset rendering on our origin.
    find: "  'x-content-type-options': 'nosniff',",
    replace: '',
  },
  {
    label: 'signer: sign every request instead of caching',
    file: S('services/signatureCache.ts'),
    // Output is byte-identical cached or not; the memoizer test is the only
    // thing that can catch this unauthenticated-CPU-amplification fix.
    find: '    if (cached !== undefined) return cached;',
    replace: '    if (false) return cached;',
  },
  {
    label: 'admin errors: report a malformed body as a 500',
    file: S('routes/admin.ts'),
    find: '    if (error instanceof ZodError) {',
    replace: '    if (false && error instanceof ZodError) {',
  },
  {
    label: 'delivery: ignore ASSETS_BASE_URL and keep addressing ourselves',
    file: S('services/manifestBuilder.ts'),
    find: '  const base = assetsBaseUrl ?? publicUrl;',
    replace: '  const base = publicUrl;',
  },
  {
    label: 'delivery: address assets at a path that is not the storage key',
    file: S('services/manifestBuilder.ts'),
    // The invariant direct delivery rests on: the URL path and the object key
    // must be the same string, or a CDN resolves nothing.
    find: 'url: `${base}/${assetStorageKey(asset.sha256Hex)}`,',
    replace: 'url: `${base}/${asset.sha256Hex}`,',
  },
  {
    label: 'assets: drop the SHA-256 hash guard',
    file: S('routes/assets.ts'),
    find: "      if (!isSha256Hex(hash)) {\n        return reply.code(400).send({ error: 'invalid asset hash' });\n      }\n",
    replace: '',
  },
  {
    label: 'assets: drop the immutable cache-control header',
    file: S('routes/assets.ts'),
    find: ".header('cache-control', 'public, max-age=31536000, immutable')",
    replace: '',
  },
  {
    label: 'auth: accept any bearer token',
    file: S('plugins/auth.ts'),
    find: 'if (!timingSafeEqual(provided, expected)) {',
    replace: 'if (provided.length < 0) {',
  },
  {
    label: 'auth: accept a request with no Authorization header',
    file: S('plugins/auth.ts'),
    find: "if (!header?.startsWith('Bearer ')) {",
    replace: 'if (header === undefined && false) {',
  },
  {
    label: 'publish: skip verifying uploaded bytes against the claimed hash',
    file: S('services/publishService.ts'),
    find: '  if (actual !== claimedHash) {',
    replace: '  if (actual !== claimedHash && false) {',
  },
  {
    label: 'publish: allow an update to reference an un-uploaded asset',
    file: S('services/publishService.ts'),
    // Re-anchored in M4: the presence check moved from has() to stat(), so it
    // could also record the stored size.
    find: '    if (!stored) {',
    replace: '    if (!stored && false) {',
  },
  {
    label: 'publish: record a fabricated asset size instead of the stored one',
    file: S('services/publishService.ts'),
    find: '    sizes.set(asset.sha256Hex, stored.size);',
    replace: '    sizes.set(asset.sha256Hex, 999);',
  },
  {
    label: 's3: report any failure as a missing object',
    file: S('storage/s3.ts'),
    // The invariant the whole driver exists for: a credentials or bucket
    // failure must never read as "this key is absent".
    find: "  return name === 'NoSuchKey' || name === 'NotFound';",
    replace: '  return true;',
  },
  {
    label: 's3: address buckets by virtual host against a path-style endpoint',
    file: S('storage/createStorage.ts'),
    find: '      forcePathStyle: config.S3_FORCE_PATH_STYLE ?? Boolean(config.S3_ENDPOINT),',
    replace: '      forcePathStyle: false,',
  },
  {
    label: 's3: store every object as octet-stream',
    file: S('storage/s3.ts'),
    find: "        ContentType: options?.contentType ?? 'application/octet-stream',",
    replace: "        ContentType: 'application/octet-stream',",
  },
  {
    label: 'config: accept STORAGE_DRIVER=s3 with no bucket',
    file: S('config.ts'),
    find: "    .refine((config) => config.STORAGE_DRIVER !== 's3' || Boolean(config.S3_BUCKET), {",
    replace: '    .refine(() => true, {',
  },
  {
    label: 'config: accept half an S3 credential pair',
    file: S('config.ts'),
    find: '.refine((config) => Boolean(config.S3_ACCESS_KEY_ID) === Boolean(config.S3_SECRET_ACCESS_KEY), {',
    replace: '.refine(() => true, {',
  },
  {
    label: 'assets: download the whole blob to answer HEAD',
    file: S('routes/assets.ts'),
    find: "      if (request.method === 'HEAD') {",
    replace: '      if (false) {',
  },
  {
    label: 'localFs: drop the storage-root containment check',
    file: S('storage/localFs.ts'),
    find: 'if (path !== this.root && !path.startsWith(this.root + sep)) {',
    replace: 'if (path.length < 0) {',
  },

  // --- M2: code signing ---
  {
    label: 'signing: serve unsigned when the client demanded a signature',
    file: S('routes/manifest.ts'),
    find: '        sign = (bytes) => signer.sign(bytes);',
    replace: '        sign = undefined;',
  },
  {
    label: 'signing: sign a re-serialization instead of the bytes actually sent',
    file: S('routes/manifest.ts'),
    find: '  const signature = sign?.(body);',
    replace: '  const signature = sign?.(`${body} `);',
  },
  {
    label: 'signing: allow an unsigned 200 when no key is configured',
    file: S('routes/manifest.ts'),
    find: '        if (!signer) {',
    replace: '        if (signer === undefined && false) {',
  },
  {
    label: 'signing: sign with any keyid the client names',
    file: S('routes/manifest.ts'),
    find: '        if (expected.keyid !== signer.keyId) {',
    replace: '        if (expected.keyid !== signer.keyId && false) {',
  },
  {
    label: 'signing: put the signature on the response instead of the part',
    file: S('routes/manifest.ts'),
    find: "      ...(signature ? { headers: { 'expo-signature': signature } } : {}),",
    replace: '',
  },
  {
    label: 'signer: accept a configured key that cannot be parsed',
    file: S('services/signer.ts'),
    find: '    throw new SigningConfigError(\n      `code signing key is not a readable private key PEM: ${(error as Error).message}`,\n    );',
    replace: '    return undefined;',
  },

  // --- M2: directives and lifecycle ---
  {
    label: 'protocol: answer a bare 204 instead of a v1 noUpdateAvailable directive',
    file: S('routes/manifest.ts'),
    find: "        supportsDirectives\n          ? sendSignedPart(reply, 'directive', noUpdateAvailableDirective(), format, sign)\n          : reply.code(204).send();",
    replace: '        reply.code(204).send();',
  },
  {
    label: 'protocol: send directives to protocol-0 clients that cannot parse them',
    file: S('routes/manifest.ts'),
    find: "        protocolVersion === 1 && negotiateFormat(headers.accept) === 'multipart';",
    replace: "        negotiateFormat(headers.accept) === 'multipart';",
  },
  {
    label: 'rollback: tell a client already on embedded to roll back anyway',
    file: S('services/updateResolver.ts'),
    find: "    return onEmbedded ? { kind: 'noUpdate' } : { kind: 'rollback', commitTime: update.createdAt };",
    replace: "    return { kind: 'rollback', commitTime: update.createdAt };",
  },
  {
    label: 'lifecycle: rollback ignores the requested platform filter',
    file: S('services/updateLifecycle.ts'),
    find: 'const platforms = input.platforms?.length ? input.platforms : [...PLATFORMS];',
    replace: 'const platforms = [...PLATFORMS];',
  },
  {
    label: 'lifecycle: republish resurrects rollback markers as updates',
    file: S('services/updateLifecycle.ts'),
    find: "    .where(and(eq(updates.groupId, groupId), eq(updates.type, 'normal')))",
    replace: '    .where(eq(updates.groupId, groupId))',
  },
  {
    label: 'lifecycle: disable only affects one row of the group',
    file: S('services/updateLifecycle.ts'),
    find: "  db.update(updates).set({ status: 'disabled' }).where(eq(updates.groupId, groupId)).run();",
    replace:
      "  db.update(updates).set({ status: 'disabled' }).where(eq(updates.id, rows[0].id)).run();",
  },

  // --- M2: key generation ---
  {
    label: 'keys: overwrite an existing private key instead of refusing',
    file: C('commands/keys.ts'),
    find: '    if (existsSync(path)) {',
    replace: '    if (existsSync(path) && false) {',
  },
  {
    label: 'keys: write the private key world-readable',
    file: C('commands/keys.ts'),
    find: 'writeFileSync(privateKeyPath, privateKeyPEM, { mode: 0o600 });',
    replace: 'writeFileSync(privateKeyPath, privateKeyPEM, { mode: 0o644 });',
  },

  // --- M3: publishing pipeline ---
  {
    label: 'export: key assets by filename instead of content MD5',
    file: C('exportDir.ts'),
    find: "    key: createHash('md5').update(bytes).digest('hex'),",
    replace: '    key: relativePath,',
  },
  {
    label: 'export: derive every content type from the extension, bundle included',
    file: C('exportDir.ts'),
    find: "      launchAsset: readExportedFile(dir, files.bundle, 'application/javascript', '.bundle'),",
    replace:
      "      launchAsset: readExportedFile(dir, files.bundle, mime.getType(files.bundle) ?? 'application/octet-stream', '.bundle'),",
  },
  {
    label: 'export: accept metadata that names an unreadable file',
    file: C('exportDir.ts'),
    find: '    throw new ExportDirError(\n      `metadata.json references ${relativePath} but it is unreadable: ${(error as Error).message}`,\n    );',
    replace: '    bytes = Buffer.alloc(0);',
  },
  {
    label: 'export: silently ignore a platform that is not in the export',
    file: C('exportDir.ts'),
    find: '    if (!files) {',
    replace: '    if (files === undefined && false) {',
  },
  {
    label: 'publish: upload every blob, ignoring what the server already has',
    file: C('commands/publish.ts'),
    find: '  return { files, toUpload: [...files.keys()].filter((hash) => missing.has(hash)) };',
    replace: '  return { files, toUpload: [...files.keys()] };',
  },
  {
    label: 'publish: send the file path as the asset key',
    file: C('commands/publish.ts'),
    find: '    key: file.key,',
    replace: '    key: file.path,',
  },
  {
    label: 'api: fall back to a token baked into the client',
    file: C('api.ts'),
    find: '    if (!token) {',
    replace: '    if (token === undefined && false) {',
  },
  {
    label: 'api: treat a non-2xx response as success',
    file: C('api.ts'),
    find: '    if (!response.ok) {',
    replace: '    if (!response.ok && false) {',
  },
  {
    label: 'admin list: ignore the channel filter',
    file: S('routes/admin.ts'),
    find: '        filters.push(eq(updates.channelId, channelRow.id));',
    replace: '',
  },
  {
    label: 'admin list: return oldest updates first',
    file: S('routes/admin.ts'),
    find: '        .orderBy(desc(updates.seq))',
    replace: '        .orderBy(updates.seq)',
  },
];

const hashFile = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function clearCaches() {
  // Vite caches transforms; a stale entry would run the PREVIOUS cycle's code.
  for (const dir of [
    'node_modules/.vite',
    'packages/server/node_modules/.vite',
    'packages/core/node_modules/.vite',
  ]) {
    rmSync(resolve(ROOT, dir), { recursive: true, force: true });
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC
const ANSI = /\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (text) => text.replace(ANSI, '');

function runTests() {
  // Both streams, always. Vitest puts its summary on stdout locally and on
  // stderr under CI; reading only one made the harness report "baseline is not
  // green" for a suite that had in fact passed. `pnpm exec` rather than `npx`
  // so resolution is the workspace's, not whatever npx decides to fetch.
  // The reporter is pinned and colour disabled so the summary line has one
  // shape everywhere; ANSI is then stripped anyway, because a parser that
  // depends on the terminal's mood is not a parser.
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=default'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  const output = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const exitCode = result.status ?? 1;

  const line = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
    output,
  );
  if (!line) {
    // Unparseable output is a harness failure, not a silent pass — show it.
    return { exitCode, failed: null, passed: null, total: null, raw: output.slice(-1500) };
  }
  return {
    exitCode,
    failed: Number(line[1] ?? 0),
    passed: Number(line[2]),
    total: Number(line[4]),
  };
}

// @ota/core resolves through its package exports (dist), so it must exist
// before any suite runs. The root `test` script does this, but this harness
// calls vitest directly to avoid rebuilding core 40+ times — no sabotage
// touches core, so building it once here is both correct and fast.
console.log('=== building @ota/core ===');
execFileSync('pnpm', ['--filter', '@ota/core', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true' },
});

console.log('=== baseline ===');
clearCaches();
const baseline = runTests();
console.log(
  `exit=${baseline.exitCode} passed=${baseline.passed} failed=${baseline.failed} total=${baseline.total}`,
);
if (baseline.exitCode !== 0 || baseline.failed !== 0) {
  console.error('baseline is not green; aborting');
  // Without this, an unparseable run is indistinguishable from a failing one.
  if (baseline.raw) console.error(`--- test output ---\n${baseline.raw}`);
  process.exit(1);
}

const results = [];
for (const sabotage of SABOTAGES) {
  const original = readFileSync(sabotage.file, 'utf8');
  const originalHash = hashFile(sabotage.file);

  if (!original.includes(sabotage.find)) {
    results.push({ ...sabotage, verdict: 'PATTERN-NOT-FOUND' });
    console.log(`\n[SKIP] ${sabotage.label}\n  pattern absent — sabotage would have been a no-op`);
    continue;
  }

  const occurrences = original.split(sabotage.find).length - 1;
  writeFileSync(sabotage.file, original.split(sabotage.find).join(sabotage.replace));

  const brokenHash = hashFile(sabotage.file);
  if (brokenHash === originalHash) {
    writeFileSync(sabotage.file, original);
    results.push({ ...sabotage, verdict: 'FILE-UNCHANGED' });
    console.log(`\n[SKIP] ${sabotage.label}\n  file hash did not change`);
    continue;
  }

  clearCaches();
  const run = runTests();

  writeFileSync(sabotage.file, original);
  const restoredHash = hashFile(sabotage.file);
  if (restoredHash !== originalHash) {
    console.error(`RESTORE FAILED for ${sabotage.file}`);
    process.exit(1);
  }

  let verdict;
  if (run.total === null) verdict = 'UNPARSEABLE';
  else if (run.total !== baseline.total)
    verdict = `DENOMINATOR-CHANGED (${run.total} vs ${baseline.total})`;
  else if (run.failed > 0) verdict = 'CAUGHT';
  else verdict = 'NOT-CAUGHT';

  results.push({ ...sabotage, verdict, failed: run.failed, total: run.total, occurrences });
  console.log(
    `\n[${verdict}] ${sabotage.label}\n  replacements=${occurrences} failed=${run.failed} total=${run.total}`,
  );
}

clearCaches();
const final = runTests();
console.log('\n=== after restore ===');
console.log(
  `exit=${final.exitCode} passed=${final.passed} failed=${final.failed} total=${final.total}`,
);

console.log('\n=== summary ===');
for (const result of results) console.log(`${result.verdict.padEnd(28)} ${result.label}`);

const bad = results.filter((r) => r.verdict !== 'CAUGHT');
console.log(`\n${results.length - bad.length}/${results.length} sabotages caught`);
if (final.failed !== 0 || final.total !== baseline.total) {
  console.error('SUITE NOT RESTORED TO BASELINE');
  process.exit(1);
}
process.exit(bad.length === 0 ? 0 : 2);
