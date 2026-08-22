import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { assertNoRollback, validateManifest, verifyManifestSignature } from "./release-policy.mjs";

const now = new Date("2026-08-22T00:00:00Z");
const dmg = {
  url: "https://github.com/highlyproteus/harness-harlot/releases/download/v0.1.10/Harness-Harlot-0.1.10-b82-macos-arm64-community.dmg",
  sha256: "a".repeat(64),
  size: 123456,
};
const manifest = {
  schema: "hh-update-manifest-v2",
  product: "Harness Harlot",
  channel: "stable",
  key_id: "hh-stable-2026",
  version: "0.1.10",
  build: 82,
  published_at: "2026-08-21T23:00:00Z",
  valid_until: "2026-08-29T23:00:00Z",
  platform: "macos",
  minimum_macos: "13.0",
  session_service: { protocol_version: 27, requires_quiescent_service: true },
  artifacts: [{
    platform: "macos",
    architecture: "arm64",
    format: "dmg",
    file_name: "Harness-Harlot-0.1.10-b82-macos-arm64-community.dmg",
    ...dmg,
  }],
};

const { publicKey: fixturePublicKey, privateKey: fixturePrivateKey } = generateKeyPairSync("ed25519");
const fixturePublicKeyDer = fixturePublicKey.export({ format: "der", type: "spki" });
const fixtureKeys = new Map([["fixture", fixturePublicKeyDer.subarray(-32).toString("base64")]]);
const fixtureManifestBytes = Buffer.from(JSON.stringify(manifest));
const fixtureSignature = sign(null, fixtureManifestBytes, fixturePrivateKey).toString("base64");
assert.doesNotThrow(() => verifyManifestSignature(fixtureManifestBytes, fixtureSignature, "fixture", fixtureKeys));
assert.throws(
  () => verifyManifestSignature(Buffer.from(`${fixtureManifestBytes} `), fixtureSignature, "fixture", fixtureKeys),
  /not trusted/,
);
assert.throws(
  () => verifyManifestSignature(fixtureManifestBytes, fixtureSignature, "unknown", fixtureKeys),
  /unknown update signing key/,
);

assert.deepEqual(validateManifest(manifest, { platform: "macos", architecture: "arm64", artifact: dmg, tag: "v0.1.10", now }), {
  version: "0.1.10",
  build: 82,
  publishedAt: "2026-08-21T23:00:00Z",
  validUntil: "2026-08-29T23:00:00Z",
});

const wrongBuildDmg = {
  ...dmg,
  url: dmg.url.replace("-b82-", "-b83-"),
};
const wrongBuildManifest = structuredClone(manifest);
wrongBuildManifest.artifacts[0] = {
  ...wrongBuildManifest.artifacts[0],
  ...wrongBuildDmg,
  file_name: "Harness-Harlot-0.1.10-b83-macos-arm64-community.dmg",
};
assert.throws(
  () => validateManifest(wrongBuildManifest, { platform: "macos", architecture: "arm64", artifact: wrongBuildDmg, tag: "v0.1.10", now }),
  /canonical/,
);

for (const mutate of [
  (body) => { body.schema = "wrong"; },
  (body) => { body.product = "Other"; },
  (body) => { body.channel = "edge"; },
  (body) => { body.key_id = "unknown"; },
  (body) => { body.platform = "linux"; },
  (body) => { body.artifacts[0].architecture = "x86_64"; },
  (body) => { body.artifacts[0].file_name = "other.dmg"; },
  (body) => { body.artifacts[0].size += 1; },
  (body) => { body.artifacts.push({ ...body.artifacts[0] }); },
  (body) => { body.valid_until = "2026-08-21T00:00:00Z"; },
  (body) => { body.valid_until = "2026-08-22T00:30:00Z"; },
  (body) => { body.published_at = 1787353200000; },
  (body) => { body.published_at = "2026-08-21 23:00:00"; },
  (body) => { body.valid_until = "2026-08-29T23:00:00+00:00"; },
  (body) => { body.published_at = "2026-02-30T23:00:00Z"; },
]) {
  const changed = structuredClone(manifest);
  mutate(changed);
  assert.throws(() => validateManifest(changed, { platform: "macos", architecture: "arm64", artifact: dmg, tag: "v0.1.10", now }));
}

const archive = {
  url: "https://github.com/highlyproteus/harness-harlot/releases/download/v0.1.10/Harness-Harlot-0.1.10-b82-linux-x86_64.tar.gz",
  sha256: "b".repeat(64),
  size: 654321,
};
const linuxManifest = {
  ...structuredClone(manifest),
  platform: "linux",
  minimum_glibc: "2.35",
  artifacts: [{
    platform: "linux",
    architecture: "x86_64",
    format: "tar.gz",
    file_name: "Harness-Harlot-0.1.10-b82-linux-x86_64.tar.gz",
    ...archive,
  }],
};
delete linuxManifest.minimum_macos;
assert.deepEqual(
  validateManifest(linuxManifest, { platform: "linux", architecture: "x86_64", artifact: archive, tag: "v0.1.10", now }),
  { version: "0.1.10", build: 82, publishedAt: "2026-08-21T23:00:00Z", validUntil: "2026-08-29T23:00:00Z" },
);
for (const mutate of [
  (body) => { body.minimum_glibc = "glibc"; },
  (body) => { body.artifacts[0].format = "zip"; },
  (body) => { body.artifacts[0].platform = "macos"; },
]) {
  const changed = structuredClone(linuxManifest);
  mutate(changed);
  assert.throws(() => validateManifest(
    changed,
    { platform: "linux", architecture: "x86_64", artifact: archive, tag: "v0.1.10", now },
  ));
}

assert.doesNotThrow(() => assertNoRollback({ version: "0.1.9", build: 81 }, { version: "0.1.10", build: 82 }));
assert.throws(() => assertNoRollback({ version: "01.1.9", build: 81 }, { version: "0.1.10", build: 82 }), /version/);
assert.doesNotThrow(() => assertNoRollback({ version: "0.1.10", build: 82 }, { version: "0.1.10", build: 82 }));
assert.throws(() => assertNoRollback({ version: "0.1.10", build: 82 }, { version: "0.1.9", build: 81 }), /rollback/);
assert.throws(() => assertNoRollback({ version: "0.1.10", build: 82 }, { version: "0.1.10", build: 81 }), /rollback/);
assert.throws(() => assertNoRollback({ version: "0.1.10", build: 82 }, { version: "0.1.11", build: 1 }), /rollback/);
assert.throws(() => assertNoRollback({ version: "0.1.10", build: 82 }, { version: "0.1.9", build: 83 }), /rollback/);
assert.throws(() => assertNoRollback({ version: "0.1.10", build: "82" }, { version: "0.1.11", build: 83 }), /build/);
assert.doesNotThrow(() => assertNoRollback(
  { version: "0.1.10", build: 82 },
  { version: "0.1.9", build: 81 },
  { allowRollback: true },
));

console.log("release policy rejects malformed, expired, and rollback publications");
