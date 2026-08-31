import { createHash } from "node:crypto";

export const STABLE_V2_BASE_URL = "https://harnessharlot.com/releases/stable-v2";
export const REFRESH_DESCRIPTOR = "stable-v2-refresh.json";
export const REFRESH_WORKFLOW = ".github/workflows/refresh-stable-v2.yml";
export const REFRESH_REPOSITORY = "highlyproteus/harness-harlot";
export const CANONICAL_MANIFESTS = [
  "manifest-macos-community-arm64-v2.update.json",
  "manifest-macos-community-x86_64-v2.update.json",
  "manifest-linux-arm64-v2.update.json",
  "manifest-linux-x86_64-v2.update.json",
];
export const CANONICAL_REFRESH_FILES = [
  ...CANONICAL_MANIFESTS.flatMap((name) => [name, `${name}.sig`]),
  REFRESH_DESCRIPTOR,
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalTimestamp(value, label) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value), `invalid ${label}`);
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace("Z", ".000Z"), `invalid ${label}`);
  return parsed;
}

export function validateRefreshDescriptor(descriptor, { run, release, now = new Date() }) {
  requireValue(descriptor && typeof descriptor === "object" && !Array.isArray(descriptor), "refresh descriptor must be an object");
  const expectedFields = [
    "generated_at", "head_sha", "release_id", "release_tag", "repository", "run_attempt",
    "run_id", "schema", "source_ref", "workflow",
  ].sort();
  requireValue(JSON.stringify(Object.keys(descriptor).sort()) === JSON.stringify(expectedFields), "refresh descriptor has unexpected fields");
  requireValue(descriptor.schema === "hh-stable-v2-refresh-v1", "unexpected refresh descriptor schema");
  requireValue(descriptor.repository === REFRESH_REPOSITORY, "unexpected refresh repository");
  requireValue(descriptor.workflow === REFRESH_WORKFLOW, "unexpected refresh workflow");
  requireValue(descriptor.source_ref === "refs/heads/main", "unexpected refresh source ref");
  requireValue(run?.status === "completed" && run?.conclusion === "success", "refresh run was not successful");
  requireValue(run?.head_branch === "main", "refresh run was not on main");
  requireValue(run?.path === REFRESH_WORKFLOW, "refresh run used the wrong workflow");
  requireValue(run?.event === "schedule" || run?.event === "workflow_dispatch", "refresh run used an untrusted event");
  requireValue(Number.isSafeInteger(descriptor.run_id) && descriptor.run_id === run.id, "refresh descriptor run id mismatch");
  requireValue(Number.isSafeInteger(descriptor.run_attempt) && descriptor.run_attempt > 0 && descriptor.run_attempt === run.run_attempt, "refresh descriptor run attempt mismatch");
  requireValue(typeof descriptor.head_sha === "string" && /^[a-f0-9]{40}$/.test(descriptor.head_sha) && descriptor.head_sha === run.head_sha, "refresh descriptor head SHA mismatch");
  requireValue(Number.isSafeInteger(descriptor.release_id) && descriptor.release_id > 0 && descriptor.release_id === release.id, "refresh descriptor release id mismatch");
  requireValue(descriptor.release_tag === release.tagName, "refresh descriptor release tag mismatch");
  const generatedAt = canonicalTimestamp(descriptor.generated_at, "refresh generation time");
  requireValue(generatedAt <= now.getTime() + 5 * 60 * 1000, "refresh generation time is in the future");
  return { generatedAt: descriptor.generated_at };
}

export function validateRefreshEntries(entries) {
  requireValue(Array.isArray(entries), "refresh artifact entries are invalid");
  const names = new Set();
  for (const entry of entries) {
    requireValue(entry && typeof entry.name === "string" && !entry.name.includes("/") && !entry.name.includes("\\") && entry.name !== "." && entry.name !== "..", "refresh artifact contains a nested or invalid path");
    requireValue(!names.has(entry.name), `refresh artifact contains duplicate path: ${entry.name}`);
    names.add(entry.name);
    requireValue(entry.kind === "file", `refresh artifact contains non-regular path: ${entry.name}`);
    const maximumSize = entry.name === REFRESH_DESCRIPTOR ? 16 * 1024 : entry.name.endsWith(".sig") ? 4 * 1024 : 1024 * 1024;
    requireValue(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= maximumSize, `refresh artifact file has invalid size: ${entry.name}`);
  }
  requireValue(entries.length === CANONICAL_REFRESH_FILES.length, "refresh artifact has missing or extra paths");
  for (const expected of CANONICAL_REFRESH_FILES) {
    requireValue(names.has(expected), `refresh artifact is missing canonical path: ${expected}`);
  }
}

export function installerSupportsStableV2Base(body) {
  return typeof body === "string" && body.includes(STABLE_V2_BASE_URL);
}

export function validateCanonicalReleaseAsset(asset, tag) {
  requireValue(asset && typeof asset.name === "string" && !asset.name.includes("/"), "release asset has an invalid name");
  requireValue(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag), "release asset tag is invalid");
  const expectedUrl = `https://github.com/${REFRESH_REPOSITORY}/releases/download/${tag}/${asset.name}`;
  requireValue(asset.url === expectedUrl, `release asset has a noncanonical URL: ${asset.name}`);
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? "");
  requireValue(digest, `release asset has no valid digest: ${asset.name}`);
  requireValue(Number.isSafeInteger(asset.size) && asset.size > 0, `release asset has invalid size: ${asset.name}`);
  return { url: asset.url, sha256: digest[1], size: asset.size };
}

export function buildRefreshedAssetMetadata(name, bytes) {
  requireValue(CANONICAL_REFRESH_FILES.includes(name) && name !== REFRESH_DESCRIPTOR, `noncanonical refreshed file: ${name}`);
  requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024, `invalid refreshed file bytes: ${name}`);
  return {
    url: `${STABLE_V2_BASE_URL}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

export function assertRefreshMonotonic(current, candidate) {
  if (!current) return;
  const currentPublished = canonicalTimestamp(current.publishedAt, "current manifest publication time");
  const candidatePublished = canonicalTimestamp(candidate.publishedAt, "candidate manifest publication time");
  const currentValid = canonicalTimestamp(current.validUntil, "current manifest expiration time");
  const candidateValid = canonicalTimestamp(candidate.validUntil, "candidate manifest expiration time");
  requireValue(candidatePublished >= currentPublished, "manifest publication rollback refused");
  requireValue(candidateValid >= currentValid, "manifest expiration rollback refused");
}
