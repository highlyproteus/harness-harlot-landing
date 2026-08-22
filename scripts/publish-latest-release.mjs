import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertNoRollback, validateManifest, verifyManifestSignature } from "./release-policy.mjs";

const repository = "highlyproteus/harness-harlot";
const requestedTag = process.argv[2];
const releaseArgs = ["release", "view"];
if (requestedTag) releaseArgs.push(requestedTag);
releaseArgs.push("--repo", repository, "--json", "tagName,assets");
const release = JSON.parse(execFileSync("gh", releaseArgs, { encoding: "utf8" }));
const tag = release.tagName;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid release tag: ${tag}`);
const releaseVersionPattern = tag.slice(1).replaceAll(".", "\\.");
const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
let work;

function select(pattern, label) {
  const matches = [...assets.values()].filter((asset) => pattern.test(asset.name));
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`);
  return matches[0];
}

function publishedMetadata(asset) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? "");
  if (!match) throw new Error(`release asset has no valid SHA-256 digest: ${asset.name}`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`release asset has invalid size: ${asset.name}`);
  return { url: asset.url, sha256: match[1], size: asset.size };
}

function releaseAsset(platform, architecture) {
  if (platform === "macos") {
    return select(
      new RegExp(`^Harness-Harlot-${releaseVersionPattern}-b([0-9]+)-macos-${architecture}-community\\.dmg$`),
      `${architecture} community DMG`,
    );
  }
  return select(
    new RegExp(`^Harness-Harlot-${releaseVersionPattern}-b([0-9]+)-linux-${architecture}\\.tar\\.gz$`),
    `${architecture} Linux archive`,
  );
}

function releaseManifest(platform, architecture) {
  return select(
    new RegExp(`^manifest-${platform === "macos" ? "macos-community" : "linux"}-${architecture}\\.update\\.json$`),
    `${platform} ${architecture} stable manifest`,
  );
}

function releaseSignature(platform, architecture) {
  return select(
    new RegExp(`^manifest-${platform === "macos" ? "macos-community" : "linux"}-${architecture}\\.update\\.json\\.sig$`),
    `${platform} ${architecture} stable signature`,
  );
}

function localFileMatchesVerifiedAsset(path, verified) {
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return verified.sha256 === sha256;
}

work = mkdtempSync(join(tmpdir(), "hh-release-index-"));
const verifiedAssets = new Map();

function verifiedAsset(asset) {
  if (verifiedAssets.has(asset.name)) return verifiedAssets.get(asset.name);
  execFileSync("gh", ["release", "download", tag, "--repo", repository, "--dir", work, "--pattern", asset.name], { stdio: "inherit" });
  const path = join(work, asset.name);
  execFileSync("gh", [
    "attestation", "verify", path,
    "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/release.yml`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
  ], { stdio: "inherit" });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (asset.digest && asset.digest !== `sha256:${sha256}`) {
    throw new Error(`GitHub digest mismatch for ${asset.name}`);
  }
  const verified = { path, url: asset.url, sha256, size: asset.size };
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
  if (!body.includes("curl -fsS https://harnessharlot.com/install | sh")) {
    throw new Error(`${platform} release installer does not advertise the universal command`);
  }
  execFileSync("sh", ["-n", installer.path]);
  return body;
}

function verifiedIndexMatchesRelease(index, platform) {
  if (index.schema !== "hh-web-release-index-v1" || index.tag !== tag || index.version !== tag.slice(1)) return false;
  let expectedBuild;
  for (const architecture of ["arm64", "x86_64"]) {
    const primary = publishedMetadata(releaseAsset(platform, architecture));
    const manifest = verifiedAsset(releaseManifest(platform, architecture));
    const signature = verifiedAsset(releaseSignature(platform, architecture));
    const manifestBytes = readFileSync(manifest.path);
    const manifestBody = JSON.parse(manifestBytes);
    verifyManifestSignature(manifestBytes, readFileSync(signature.path, "utf8"), manifestBody.key_id);
    const identity = validateManifest(
      manifestBody,
      { platform, architecture, artifact: primary, tag },
    );
    expectedBuild ??= identity.build;
    if (identity.version !== index.version || identity.build !== expectedBuild) return false;
    const current = index[platform]?.[architecture];
    const expectedAssets = {
      [platform === "macos" ? "dmg" : "archive"]: primary,
      manifest: publicAsset(manifest),
      signature: publicAsset(signature),
    };
    for (const [kind, metadata] of Object.entries(expectedAssets)) {
      if (JSON.stringify(current?.[kind]) !== JSON.stringify(metadata)) return false;
    }
    if (current?.manifest_published_at !== identity.publishedAt) return false;
    if (current?.manifest_valid_until !== identity.validUntil) return false;
  }
  return index.build === expectedBuild;
}

function verifiedPublicationMatchesRelease() {
  const macosInstaller = verifiedAsset(select(/^install-community-macos\.sh$/, "macOS installer"));
  const linuxInstaller = verifiedAsset(select(/^install-linux\.sh$/, "Linux installer"));
  validateInstaller(macosInstaller, "macos", "https://harnessharlot.com/releases/stable-macos.json");
  validateInstaller(linuxInstaller, "linux", "https://harnessharlot.com/releases/stable-linux.json");
  if (!localFileMatchesVerifiedAsset("public/install-macos", macosInstaller)) return false;
  if (!localFileMatchesVerifiedAsset("public/install-linux", linuxInstaller)) return false;
  let macos;
  let linux;
  try {
    macos = JSON.parse(readFileSync("public/releases/stable-macos.json", "utf8"));
    linux = JSON.parse(readFileSync("public/releases/stable-linux.json", "utf8"));
  } catch {
    return false;
  }
  if (!verifiedIndexMatchesRelease(macos, "macos")) return false;
  if (!verifiedIndexMatchesRelease(linux, "linux")) return false;
  return macos.version === linux.version && macos.build === linux.build;
}

try {
  if (!requestedTag && verifiedPublicationMatchesRelease()) {
    console.log(`website already publishes attestation-verified ${tag} assets`);
  } else {
  const macosInstaller = verifiedAsset(select(/^install-community-macos\.sh$/, "macOS installer"));
  const linuxInstaller = verifiedAsset(select(/^install-linux\.sh$/, "Linux installer"));
  const macosInstallerBody = validateInstaller(
    macosInstaller,
    "macos",
    "https://harnessharlot.com/releases/stable-macos.json",
  );
  const linuxInstallerBody = validateInstaller(
    linuxInstaller,
    "linux",
    "https://harnessharlot.com/releases/stable-linux.json",
  );

  const publication = { macos: {}, linux: {} };
  let version;
  let build;
  for (const platform of ["macos", "linux"]) {
    for (const architecture of ["arm64", "x86_64"]) {
      const primary = verifiedAsset(releaseAsset(platform, architecture));
      const manifest = verifiedAsset(releaseManifest(platform, architecture));
      const signature = verifiedAsset(releaseSignature(platform, architecture));
      const manifestBytes = readFileSync(manifest.path);
      const body = JSON.parse(manifestBytes);
      verifyManifestSignature(manifestBytes, readFileSync(signature.path, "utf8"), body.key_id);
      const identity = validateManifest(body, { platform, architecture, artifact: primary, tag });
      version ??= identity.version;
      build ??= identity.build;
      if (identity.version !== version || identity.build !== build) {
        throw new Error("release tag, version, or build disagree across platforms or architectures");
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

  const currentIdentities = [];
  for (const [platform, path] of [
    ["macos", "public/releases/stable-macos.json"],
    ["linux", "public/releases/stable-linux.json"],
  ]) {
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current.schema !== "hh-web-release-index-v1" || !current[platform]) {
        throw new Error(`current ${platform} release index is malformed`);
      }
      currentIdentities.push({ platform, version: current.version, build: current.build });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (currentIdentities.length === 2) {
    const [macosCurrent, linuxCurrent] = currentIdentities;
    if (macosCurrent.version !== linuxCurrent.version || macosCurrent.build !== linuxCurrent.build) {
      throw new Error("current macOS and Linux release indexes disagree");
    }
  }
  for (const current of currentIdentities) {
    assertNoRollback(
      current,
      { version, build },
      { allowRollback: process.env.HH_ALLOW_RELEASE_ROLLBACK === "1" },
    );
  }

  const common = { schema: "hh-web-release-index-v1", tag, version, build };
  writeFileSync(
    "public/releases/stable-macos.json",
    `${JSON.stringify({ ...common, macos: publication.macos }, null, 2)}\n`,
  );
  writeFileSync(
    "public/releases/stable-linux.json",
    `${JSON.stringify({ ...common, linux: publication.linux }, null, 2)}\n`,
  );
  writeFileSync("public/install-macos", macosInstallerBody, { mode: 0o755 });
  writeFileSync("public/install-linux", linuxInstallerBody, { mode: 0o755 });
  console.log(`published verified ${tag} macOS and Linux installer metadata from ${basename(macosInstaller.path)} and ${basename(linuxInstaller.path)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
