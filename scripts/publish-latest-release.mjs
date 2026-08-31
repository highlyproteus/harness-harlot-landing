import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoRollback, validateManifest, verifyManifestSignature } from "./release-policy.mjs";
import {
  CANONICAL_REFRESH_FILES,
  REFRESH_DESCRIPTOR,
  REFRESH_REPOSITORY,
  REFRESH_WORKFLOW,
  assertRefreshMonotonic,
  buildRefreshedAssetMetadata,
  installerSupportsStableV2Base,
  validateCanonicalReleaseAsset,
  validateRefreshDescriptor,
  validateRefreshEntries,
} from "./renewable-stable-v2.mjs";

const repository = REFRESH_REPOSITORY;
const requestedTag = process.argv[2];
const releaseArgs = ["release", "view"];
if (requestedTag) releaseArgs.push(requestedTag);
releaseArgs.push("--repo", repository, "--json", "tagName,apiUrl,assets");
const release = JSON.parse(execFileSync("gh", releaseArgs, { encoding: "utf8" }));
const tag = release.tagName;
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error(`invalid release tag: ${tag}`);
release.id = Number(new URL(release.apiUrl).pathname.split("/").at(-1));
if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error("latest release has no valid immutable id");
const releaseVersionPattern = tag.slice(1).replaceAll(".", "\\.");
const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
const work = mkdtempSync(join(tmpdir(), "hh-release-index-"));
const verifiedAssets = new Map();

function select(pattern, label) {
  const matches = [...assets.values()].filter((asset) => pattern.test(asset.name));
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`);
  return matches[0];
}


function releaseAsset(platform, architecture) {
  const pattern = platform === "macos"
    ? `^Harness-Harlot-${releaseVersionPattern}-b([0-9]+)-macos-${architecture}-community\\.dmg$`
    : `^Harness-Harlot-${releaseVersionPattern}-b([0-9]+)-linux-${architecture}\\.tar\\.gz$`;
  return select(new RegExp(pattern), `${platform} ${architecture} binary artifact`);
}

function releaseManifest(platform, architecture) {
  return select(new RegExp(`^manifest-${platform === "macos" ? "macos-community" : "linux"}-${architecture}-v2\\.update\\.json$`), `${platform} ${architecture} stable-v2 manifest`);
}

function releaseSignature(platform, architecture) {
  return select(new RegExp(`^manifest-${platform === "macos" ? "macos-community" : "linux"}-${architecture}-v2\\.update\\.json\\.sig$`), `${platform} ${architecture} stable-v2 signature`);
}

function verifiedReleaseAsset(asset) {
  if (verifiedAssets.has(asset.name)) return verifiedAssets.get(asset.name);
  const published = validateCanonicalReleaseAsset(asset, tag);
  execFileSync("gh", ["release", "download", tag, "--repo", repository, "--dir", work, "--pattern", asset.name], { stdio: "inherit" });
  const path = join(work, asset.name);
  execFileSync("gh", [
    "attestation", "verify", path,
    "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/release.yml`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
  ], { stdio: "inherit" });
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (published.sha256 !== sha256) throw new Error(`GitHub digest mismatch for ${asset.name}`);
  if (published.size !== bytes.length) throw new Error(`GitHub size mismatch for ${asset.name}`);
  const verified = { path, url: asset.url, sha256, size: bytes.length };
  verifiedAssets.set(asset.name, verified);
  return verified;
}

function publicAsset(asset) {
  const { path: _path, ...published } = asset;
  return published;
}

function validateInstaller(installer, platform, indexUrl) {
  const body = readFileSync(installer.path, "utf8");
  if (!body.startsWith("#!/bin/sh\n")) throw new Error(`${platform} installer is not a POSIX shell script`);
  if (/command -v gh|gh release|gh attestation/.test(body)) throw new Error(`${platform} release installer still requires gh`);
  if (/--tag/.test(body)) throw new Error(`${platform} release installer still advertises historical tags`);
  if (!body.includes(indexUrl)) throw new Error(`${platform} release installer does not trust the website release index`);
  if (!body.includes("curl -fsS https://harnessharlot.com/install | sh")) throw new Error(`${platform} release installer does not advertise the universal command`);
  execFileSync("sh", ["-n", installer.path]);
  return body;
}

function readCurrentIndexes() {
  const result = {};
  for (const platform of ["macos", "linux"]) {
    const path = `public/releases/stable-${platform}.json`;
    if (!existsSync(path)) continue;
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current.schema !== "hh-web-release-index-v1" || !current[platform]) throw new Error(`current ${platform} release index is malformed`);
    result[platform] = current;
  }
  if (result.macos && result.linux && (result.macos.version !== result.linux.version || result.macos.build !== result.linux.build)) {
    throw new Error("current macOS and Linux release indexes disagree");
  }
  return result;
}

function latestSuccessfulRefreshRun() {
  const response = JSON.parse(execFileSync("gh", [
    "api", "--method", "GET", `repos/${repository}/actions/workflows/refresh-stable-v2.yml/runs`,
    "-f", "branch=main", "-f", "status=success", "-f", "per_page=20",
  ], { encoding: "utf8" }));
  const run = response.workflow_runs?.find((candidate) =>
    candidate.status === "completed" && candidate.conclusion === "success" && candidate.head_branch === "main"
    && candidate.path === REFRESH_WORKFLOW && (candidate.event === "schedule" || candidate.event === "workflow_dispatch"));
  if (!run) throw new Error("no successful main stable-v2 refresh run exists");
  return run;
}

function downloadAndVerifyRefresh() {
  const run = latestSuccessfulRefreshRun();
  const rolling = JSON.parse(execFileSync("gh", [
    "release", "view", "stable-v2-refresh", "--repo", repository,
    "--json", "tagName,isDraft,isPrerelease,assets",
  ], { encoding: "utf8" }));
  if (rolling.tagName !== "stable-v2-refresh" || rolling.isDraft || !rolling.isPrerelease) {
    throw new Error("renewable stable-v2 release identity is invalid");
  }
  validateRefreshEntries(rolling.assets.map((asset) => ({ name: asset.name, kind: "file", size: asset.size })));
  const byName = new Map(rolling.assets.map((asset) => [asset.name, asset]));
  const directory = join(work, "refresh");
  mkdirSync(directory, { mode: 0o700 });
  for (const name of CANONICAL_REFRESH_FILES) {
    execFileSync("gh", [
      "release", "download", "stable-v2-refresh", "--repo", repository,
      "--dir", directory, "--pattern", name,
    ], { stdio: "inherit" });
    const path = join(directory, name);
    const bytes = readFileSync(path);
    const asset = byName.get(name);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (asset?.size !== bytes.length || asset?.digest !== `sha256:${digest}`) {
      throw new Error(`renewable release asset metadata mismatch: ${name}`);
    }
    execFileSync("gh", [
      "attestation", "verify", path,
      "--repo", repository,
      "--signer-workflow", `${repository}/${REFRESH_WORKFLOW}`,
      "--source-ref", "refs/heads/main",
      "--source-digest", run.head_sha,
      "--deny-self-hosted-runners",
    ], { stdio: "inherit" });
  }
  const descriptorBytes = readFileSync(join(directory, REFRESH_DESCRIPTOR));
  const descriptor = JSON.parse(descriptorBytes);
  if (!descriptorBytes.equals(Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`))) {
    throw new Error("refresh descriptor is not canonical JSON");
  }
  validateRefreshDescriptor(descriptor, { run, release });
  return directory;
}

function manifestName(platform, architecture) {
  return `manifest-${platform === "macos" ? "macos-community" : "linux"}-${architecture}-v2.update.json`;
}

function planPublication() {
  const macosInstaller = verifiedReleaseAsset(select(/^install-community-macos\.sh$/, "macOS installer"));
  const linuxInstaller = verifiedReleaseAsset(select(/^install-linux\.sh$/, "Linux installer"));
  const macosInstallerBody = validateInstaller(macosInstaller, "macos", "https://harnessharlot.com/releases/stable-macos.json");
  const linuxInstallerBody = validateInstaller(linuxInstaller, "linux", "https://harnessharlot.com/releases/stable-linux.json");
  const useRefresh = installerSupportsStableV2Base(macosInstallerBody) && installerSupportsStableV2Base(linuxInstallerBody);
  const refreshDirectory = useRefresh ? downloadAndVerifyRefresh() : undefined;
  const currentIndexes = readCurrentIndexes();
  const publication = { macos: {}, linux: {} };
  const refreshedFiles = new Map();
  let version;
  let build;

  for (const platform of ["macos", "linux"]) {
    for (const architecture of ["arm64", "x86_64"]) {
      const primary = verifiedReleaseAsset(releaseAsset(platform, architecture));
      const name = manifestName(platform, architecture);
      let manifest;
      let signature;
      if (useRefresh) {
        const manifestBytes = readFileSync(join(refreshDirectory, name));
        const signatureBytes = readFileSync(join(refreshDirectory, `${name}.sig`));
        manifest = { path: join(refreshDirectory, name), ...buildRefreshedAssetMetadata(name, manifestBytes) };
        signature = { path: join(refreshDirectory, `${name}.sig`), ...buildRefreshedAssetMetadata(`${name}.sig`, signatureBytes) };
        refreshedFiles.set(name, manifestBytes);
        refreshedFiles.set(`${name}.sig`, signatureBytes);
      } else {
        manifest = verifiedReleaseAsset(releaseManifest(platform, architecture));
        signature = verifiedReleaseAsset(releaseSignature(platform, architecture));
      }
      const manifestBytes = readFileSync(manifest.path);
      const body = JSON.parse(manifestBytes);
      if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(body, null, 2)}\n`))) {
        throw new Error(`update manifest is not canonical JSON: ${name}`);
      }
      verifyManifestSignature(manifestBytes, readFileSync(signature.path, "utf8"), body.key_id);
      const identity = validateManifest(body, { platform, architecture, artifact: publicAsset(primary), tag });
      version ??= identity.version;
      build ??= identity.build;
      if (identity.version !== version || identity.build !== build) throw new Error("release tag, version, or build disagree across platforms or architectures");
      const current = currentIndexes[platform]?.[platform]?.[architecture];
      if (useRefresh && current) {
        assertRefreshMonotonic(
          { publishedAt: current.manifest_published_at, validUntil: current.manifest_valid_until },
          identity,
        );
      }
      publication[platform][architecture] = {
        [platform === "macos" ? "dmg" : "archive"]: publicAsset(primary),
        manifest: publicAsset(manifest),
        signature: publicAsset(signature),
        manifest_published_at: identity.publishedAt,
        manifest_valid_until: identity.validUntil,
      };
    }
  }
  for (const current of Object.values(currentIndexes)) {
    assertNoRollback({ version: current.version, build: current.build }, { version, build }, { allowRollback: process.env.HH_ALLOW_RELEASE_ROLLBACK === "1" });
  }
  const common = { schema: "hh-web-release-index-v1", tag, version, build };
  return {
    installMacos: macosInstallerBody,
    installLinux: linuxInstallerBody,
    macosIndex: `${JSON.stringify({ ...common, macos: publication.macos }, null, 2)}\n`,
    linuxIndex: `${JSON.stringify({ ...common, linux: publication.linux }, null, 2)}\n`,
    refreshedFiles,
    useRefresh,
  };
}

function publicationMatches(plan) {
  const expected = [
    ["public/install-macos", Buffer.from(plan.installMacos)],
    ["public/install-linux", Buffer.from(plan.installLinux)],
    ["public/releases/stable-macos.json", Buffer.from(plan.macosIndex)],
    ["public/releases/stable-linux.json", Buffer.from(plan.linuxIndex)],
  ];
  if (!plan.useRefresh && existsSync("public/releases/stable-v2")) return false;
  if (plan.useRefresh) {
    if (!existsSync("public/releases/stable-v2")) return false;
    const actualNames = readdirSync("public/releases/stable-v2").sort();
    if (JSON.stringify(actualNames) !== JSON.stringify([...plan.refreshedFiles.keys()].sort())) return false;
  }
  for (const [name, bytes] of plan.refreshedFiles) expected.push([`public/releases/stable-v2/${name}`, bytes]);
  return expected.every(([path, bytes]) => existsSync(path) && readFileSync(path).equals(bytes));
}

function writePublication(plan) {
  if (plan.useRefresh) {
    rmSync("public/releases/stable-v2", { recursive: true, force: true });
    mkdirSync("public/releases/stable-v2", { recursive: true });
    for (const [name, bytes] of plan.refreshedFiles) writeFileSync(`public/releases/stable-v2/${name}`, bytes);
  } else {
    rmSync("public/releases/stable-v2", { recursive: true, force: true });
  }
  writeFileSync("public/releases/stable-macos.json", plan.macosIndex);
  writeFileSync("public/releases/stable-linux.json", plan.linuxIndex);
  writeFileSync("public/install-macos", plan.installMacos, { mode: 0o755 });
  writeFileSync("public/install-linux", plan.installLinux, { mode: 0o755 });
}

try {
  const plan = planPublication();
  if (!requestedTag && publicationMatches(plan)) {
    console.log(`website already publishes fully verified ${tag} ${plan.useRefresh ? "renewed stable-v2" : "GitHub-v2"} assets`);
  } else {
    writePublication(plan);
    console.log(`published verified ${tag} ${plan.useRefresh ? "renewed same-origin stable-v2" : "backward-compatible GitHub-v2"} installer metadata`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
