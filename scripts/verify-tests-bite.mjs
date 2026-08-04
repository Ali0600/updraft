// Fail-first harness: break one guard at a time and confirm the suite notices.
//
// Guards against the ways this check can lie to you:
//  - the pattern must actually exist (otherwise "sabotage" is a no-op),
//  - the file hash must CHANGE after writing and return to the original after
//    restoring,
//  - the test TOTAL must equal the baseline (a shrunken denominator means a
//    file failed to import, so the run proved nothing).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (p) => resolve(ROOT, 'packages/server/src', p);

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
    find: '  return undefined;\n}\n\nfunction sendManifest',
    replace: "  return 'multipart';\n}\n\nfunction sendManifest",
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
    find: "  if (request.currentUpdateId === update.id) return { kind: 'noUpdate' };\n",
    replace: '',
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
    find: 'url: `${publicUrl}/assets/${asset.sha256Hex}`,',
    replace: 'url: `/assets/${asset.sha256Hex}`,',
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
    find: '    if (!(await storage.has(assetStorageKey(asset.sha256Hex)))) {',
    replace: '    if (!(await storage.has(assetStorageKey(asset.sha256Hex))) && false) {',
  },
  {
    label: 'localFs: drop the storage-root containment check',
    file: S('storage/localFs.ts'),
    find: 'if (path !== this.root && !path.startsWith(this.root + sep)) {',
    replace: 'if (path.length < 0) {',
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

function runTests() {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('npx', ['vitest', 'run'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
    });
  } catch (error) {
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    exitCode = error.status ?? 1;
  }

  const line = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
    stdout,
  );
  if (!line) {
    return { exitCode, failed: null, passed: null, total: null, raw: stdout.slice(-800) };
  }
  return {
    exitCode,
    failed: Number(line[1] ?? 0),
    passed: Number(line[2]),
    total: Number(line[4]),
  };
}

console.log('=== baseline ===');
clearCaches();
const baseline = runTests();
console.log(
  `exit=${baseline.exitCode} passed=${baseline.passed} failed=${baseline.failed} total=${baseline.total}`,
);
if (baseline.exitCode !== 0 || baseline.failed !== 0) {
  console.error('baseline is not green; aborting');
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
