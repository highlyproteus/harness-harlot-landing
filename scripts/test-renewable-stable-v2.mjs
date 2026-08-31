import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CANONICAL_REFRESH_FILES,
  STABLE_V2_BASE_URL,
  assertRefreshMonotonic,
  buildRefreshedAssetMetadata,
  installerSupportsStableV2Base,
  validateCanonicalReleaseAsset,
  validateRefreshDescriptor,
  validateRefreshEntries,
} from "./renewable-stable-v2.mjs";
import { validateManifest, verifyManifestSignature } from "./release-policy.mjs";

const run = {
  id: 987654321,
  run_attempt: 2,
  head_sha: "1".repeat(40),
  head_branch: "main",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/refresh-stable-v2.yml",
};
const release = { id: 123456, tagName: "v0.1.16" };
const descriptor = {
  schema: "hh-stable-v2-refresh-v1",
  repository: "highlyproteus/harness-harlot",
  workflow: ".github/workflows/refresh-stable-v2.yml",
  source_ref: "refs/heads/main",
  run_id: run.id,
  run_attempt: run.run_attempt,
  head_sha: run.head_sha,
  release_id: release.id,
  release_tag: release.tagName,
  generated_at: "2026-08-28T23:00:00Z",
};
assert.doesNotThrow(() => validateRefreshDescriptor(descriptor, { run, release }));
for (const [label, mutate, expected] of [
  ["wrong run", (value) => { value.run_id += 1; }, /run id/],
  ["wrong head", (value) => { value.head_sha = "2".repeat(40); }, /head SHA/],
  ["wrong tag", (value) => { value.release_tag = "v0.1.15"; }, /release tag/],
  ["wrong release", (value) => { value.release_id += 1; }, /release id/],
  ["wrong workflow", (value) => { value.workflow = ".github/workflows/release.yml"; }, /workflow/],
  ["extra descriptor field", (value) => { value.extra = true; }, /fields/],
]) {
  const changed = structuredClone(descriptor);
  mutate(changed);
  assert.throws(() => validateRefreshDescriptor(changed, { run, release }), expected, label);
}
for (const changedRun of [
  { ...run, conclusion: "failure" },
  { ...run, status: "in_progress" },
  { ...run, head_branch: "feature" },
  { ...run, path: ".github/workflows/release.yml" },
  { ...run, event: "pull_request" },
]) {
  assert.throws(() => validateRefreshDescriptor(descriptor, { run: changedRun, release }));
}

const entries = CANONICAL_REFRESH_FILES.map((name) => ({ name, kind: "file", size: 100 }));
assert.doesNotThrow(() => validateRefreshEntries(entries));
for (const [label, changed] of [
  ["missing", entries.slice(1)],
  ["extra", [...entries, { name: "unexpected", kind: "file", size: 1 }]],
  ["duplicate", [...entries, entries[0]]],
  ["link", entries.map((entry, index) => index ? entry : { ...entry, kind: "symlink" })],
  ["directory", entries.map((entry, index) => index ? entry : { ...entry, kind: "directory" })],
  ["nested", entries.map((entry, index) => index ? entry : { ...entry, name: `nested/${entry.name}` })],
  ["oversized", entries.map((entry, index) => index ? entry : { ...entry, size: 2 * 1024 * 1024 })],
]) {
  assert.throws(() => validateRefreshEntries(changed), undefined, label);
}

const fixtureManifestBytes = await readFile(new URL("./fixtures/stable-v2/manifest-linux-arm64-v2.update.json", import.meta.url));
const fixtureSignature = await readFile(new URL("./fixtures/stable-v2/manifest-linux-arm64-v2.update.json.sig", import.meta.url), "utf8");
const fixtureManifest = JSON.parse(fixtureManifestBytes);
assert.equal(createHash("sha256").update(fixtureManifestBytes).digest("hex"), "e007d2bb3522e53a1d6aa17ae54e17f7a3b4e2fc956b201505940d4e94164261");
assert.equal(createHash("sha256").update(fixtureSignature).digest("hex"), "6f668920bb5adefab5f49fde69a532a3a8dcae5b3a6d028a6af3ab448df9b821");
assert.equal(fixtureManifest.key_id, "hh-stable-2026-v2");
assert.doesNotThrow(() => verifyManifestSignature(fixtureManifestBytes, fixtureSignature, fixtureManifest.key_id));
const fixtureArtifact = fixtureManifest.artifacts[0];
assert.deepEqual(
  validateManifest(fixtureManifest, {
    platform: "linux",
    architecture: "arm64",
    artifact: { url: fixtureArtifact.url, sha256: fixtureArtifact.sha256, size: fixtureArtifact.size },
    tag: "v0.1.16",
    now: new Date("2026-08-29T00:00:00Z"),
  }),
  { version: "0.1.16", build: 135, publishedAt: "2026-08-28T22:44:56Z", validUntil: "2026-09-04T22:44:56Z" },
);
assert.throws(
  () => verifyManifestSignature(Buffer.concat([fixtureManifestBytes, Buffer.from(" ")]), fixtureSignature, fixtureManifest.key_id),
  /not trusted/,
);
assert.throws(
  () => validateManifest(fixtureManifest, {
    platform: "linux",
    architecture: "arm64",
    artifact: { url: fixtureArtifact.url, sha256: fixtureArtifact.sha256, size: fixtureArtifact.size },
    tag: "v0.1.16",
    now: new Date("2026-09-05T00:00:00Z"),
  }),
  /expired/,
);

const local = buildRefreshedAssetMetadata("manifest-linux-arm64-v2.update.json", fixtureManifestBytes);
assert.equal(local.url, `${STABLE_V2_BASE_URL}/manifest-linux-arm64-v2.update.json`);
assert.equal(local.size, fixtureManifestBytes.length);
assert.match(local.sha256, /^[a-f0-9]{64}$/);
assert.equal(installerSupportsStableV2Base(`#!/bin/sh\nSTABLE_V2_BASE_URL='${STABLE_V2_BASE_URL}'\n`), true);
assert.equal(installerSupportsStableV2Base("#!/bin/sh\n# old GitHub-only installer\n"), false);
const releaseAsset = {
  name: "Harness-Harlot-0.1.16-b135-linux-arm64.tar.gz",
  url: "https://github.com/highlyproteus/harness-harlot/releases/download/v0.1.16/Harness-Harlot-0.1.16-b135-linux-arm64.tar.gz",
  digest: `sha256:${"a".repeat(64)}`,
  size: 123,
};
assert.deepEqual(validateCanonicalReleaseAsset(releaseAsset, "v0.1.16"), {
  url: releaseAsset.url,
  sha256: "a".repeat(64),
  size: 123,
});
assert.throws(() => validateCanonicalReleaseAsset({ ...releaseAsset, url: "https://example.com/file" }, "v0.1.16"), /URL/);
assert.throws(() => validateCanonicalReleaseAsset({ ...releaseAsset, digest: undefined }, "v0.1.16"), /digest/);
assert.throws(() => validateCanonicalReleaseAsset({ ...releaseAsset, size: 0 }, "v0.1.16"), /size/);

const current = { publishedAt: "2026-08-28T22:44:56Z", validUntil: "2026-09-04T22:44:56Z" };
assert.doesNotThrow(() => assertRefreshMonotonic(current, current));
assert.doesNotThrow(() => assertRefreshMonotonic(current, { publishedAt: "2026-08-29T22:44:56Z", validUntil: "2026-09-05T22:44:56Z" }));
assert.throws(() => assertRefreshMonotonic(current, { publishedAt: "2026-08-27T22:44:56Z", validUntil: "2026-09-05T22:44:56Z" }), /publication rollback/);
assert.throws(() => assertRefreshMonotonic(current, { publishedAt: "2026-08-29T22:44:56Z", validUntil: "2026-09-03T22:44:56Z" }), /expiration rollback/);

console.log("renewable stable-v2 policy accepts the production-key fixture and rejects malformed refreshes");
