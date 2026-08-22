import { basename } from "node:path";

const TRUSTED_KEY_IDS = new Set(["hh-stable-2026"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseVersion(version) {
  requireValue(typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version), `invalid release version: ${version}`);
  const components = version.split(".").map(Number);
  requireValue(components.every(Number.isSafeInteger), `invalid release version: ${version}`);
  return components;
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parseCanonicalTimestamp(value, label) {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  requireValue(typeof value === "string" && pattern.test(value), `invalid manifest ${label} time`);
  const timestamp = Date.parse(value);
  requireValue(Number.isFinite(timestamp), `invalid manifest ${label} time`);
  requireValue(
    new Date(timestamp).toISOString() === value.replace("Z", ".000Z"),
    `invalid manifest ${label} time`,
  );
  return timestamp;
}

export function assertNoRollback(current, candidate, { allowRollback = false } = {}) {
  parseVersion(candidate.version);
  requireValue(Number.isSafeInteger(candidate.build) && candidate.build > 0, "invalid candidate build");
  if (!current) return;
  parseVersion(current.version);
  requireValue(Number.isSafeInteger(current.build) && current.build > 0, "invalid current build");
  if (allowRollback) return;
  const versionOrder = compareVersion(candidate.version, current.version);
  if (versionOrder < 0 || candidate.build < current.build) {
    throw new Error(
      `release rollback refused: current ${current.version}+${current.build}, candidate ${candidate.version}+${candidate.build}`,
    );
  }
}

export function validateManifest(body, { platform, architecture, artifact, tag, now = new Date() }) {
  requireValue(body && typeof body === "object" && !Array.isArray(body), "manifest must be an object");
  requireValue(platform === "macos" || platform === "linux", "unsupported manifest platform");
  requireValue(body.schema === "hh-update-manifest-v2", "unexpected manifest schema");
  requireValue(body.product === "Harness Harlot", "unexpected manifest product");
  requireValue(body.channel === "stable", "unexpected manifest channel");
  requireValue(TRUSTED_KEY_IDS.has(body.key_id), "untrusted manifest key id");
  requireValue(body.platform === platform, "unexpected manifest platform");
  requireValue(tag === `v${body.version}`, "release tag and manifest version disagree");
  parseVersion(body.version);
  requireValue(Number.isSafeInteger(body.build) && body.build > 0, "invalid manifest build");
  if (platform === "macos") {
    requireValue(typeof body.minimum_macos === "string" && /^\d+\.\d+$/.test(body.minimum_macos), "invalid minimum macOS version");
  } else {
    requireValue(typeof body.minimum_glibc === "string" && /^\d+\.\d+$/.test(body.minimum_glibc), "invalid minimum glibc version");
  }
  requireValue(
    Number.isSafeInteger(body.session_service?.protocol_version) && body.session_service.protocol_version > 0,
    "invalid session service protocol version",
  );
  requireValue(
    typeof body.session_service?.requires_quiescent_service === "boolean",
    "invalid session service quiescence policy",
  );

  const publishedAt = parseCanonicalTimestamp(body.published_at, "publication");
  const validUntil = parseCanonicalTimestamp(body.valid_until, "expiration");
  const nowMs = now.getTime();
  requireValue(publishedAt <= nowMs + 5 * 60 * 1000, "manifest publication time is in the future");
  requireValue(validUntil > nowMs, "manifest is expired");
  requireValue(validUntil >= nowMs + 2 * 60 * 60 * 1000, "manifest has insufficient remaining validity");
  requireValue(validUntil > publishedAt, "manifest expiration precedes publication");

  requireValue(Array.isArray(body.artifacts) && body.artifacts.length === 1, "manifest must contain exactly one artifact");
  const manifestArtifact = body.artifacts[0];
  requireValue(manifestArtifact.platform === platform, "unexpected artifact platform");
  requireValue(manifestArtifact.architecture === architecture, "artifact architecture mismatch");
  requireValue(manifestArtifact.format === (platform === "macos" ? "dmg" : "tar.gz"), "unexpected artifact format");
  requireValue(manifestArtifact.url === artifact.url, "manifest URL does not match release asset");
  requireValue(manifestArtifact.sha256 === artifact.sha256, "manifest digest does not match release asset");
  requireValue(manifestArtifact.size === artifact.size, "manifest size does not match release asset");
  requireValue(
    manifestArtifact.file_name === basename(new URL(artifact.url).pathname),
    "manifest filename does not match release asset",
  );
  requireValue(/^[a-f0-9]{64}$/.test(manifestArtifact.sha256), "invalid artifact digest");
  requireValue(Number.isSafeInteger(manifestArtifact.size) && manifestArtifact.size > 0, "invalid artifact size");

  return {
    version: body.version,
    build: body.build,
    publishedAt: body.published_at,
    validUntil: body.valid_until,
  };
}
