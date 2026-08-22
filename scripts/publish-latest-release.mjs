import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertNoRollback, validateManifest } from "./release-policy.mjs";

const repository = "highlyproteus/harness-harlot";
const requestedTag = process.argv[2];
const releaseArgs = ["release", "view"];
if (requestedTag) releaseArgs.push(requestedTag);
releaseArgs.push("--repo", repository, "--json", "tagName,assets");
const release = JSON.parse(execFileSync("gh", releaseArgs, { encoding: "utf8" }));
const tag = release.tagName;
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
  return { url: asset.url, sha256: match[1], size: asset.size };
}

function publicationMatchesRelease() {
  try {
    const current = JSON.parse(readFileSync("public/releases/stable-macos.json", "utf8"));
    if (current.schema !== "hh-web-release-index-v1" || current.tag !== tag || current.version !== tag.slice(1)) return false;
    let expectedBuild;
    for (const architecture of ["arm64", "x86_64"]) {
      const dmg = select(new RegExp(`^Harness-Harlot-.*-b([0-9]+)-macos-${architecture}-community\\.dmg$`), `${architecture} community DMG`);
      const buildMatch = /-b([0-9]+)-macos-/.exec(dmg.name);
      expectedBuild ??= Number(buildMatch[1]);
      if (expectedBuild !== Number(buildMatch[1])) return false;
      const expectedAssets = {
        dmg: publishedMetadata(dmg),
        manifest: publishedMetadata(select(new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json$`), `${architecture} stable manifest`)),
        signature: publishedMetadata(select(new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json\\.sig$`), `${architecture} stable signature`)),
      };
      const currentArchitecture = current.macos?.[architecture];
      for (const kind of ["dmg", "manifest", "signature"]) {
        if (JSON.stringify(currentArchitecture?.[kind]) !== JSON.stringify(expectedAssets[kind])) return false;
      }
      if (!Number.isFinite(Date.parse(currentArchitecture?.manifest_valid_until))) return false;
      if (Date.parse(currentArchitecture.manifest_valid_until) <= Date.now()) return false;
    }
    if (current.build !== expectedBuild) return false;
    const installerAsset = select(/^install-community-macos\.sh$/, "macOS installer");
    const installerSha = createHash("sha256").update(readFileSync("public/install")).digest("hex");
    return installerAsset.digest === `sha256:${installerSha}`;
  } catch {
    return false;
  }
}

if (!requestedTag && publicationMatchesRelease()) {
  console.log(`website already publishes verified ${tag} assets`);
  process.exit(0);
}
work = mkdtempSync(join(tmpdir(), "hh-release-index-"));

function verifiedAsset(asset) {
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
  return { path, url: asset.url, sha256, size: asset.size };
}

function publicAsset(asset) {
  const { path: _path, ...published } = asset;
  return published;
}

try {
  const installer = verifiedAsset(select(/^install-community-macos\.sh$/, "macOS installer"));
  const installerBody = readFileSync(installer.path, "utf8");
  if (!installerBody.startsWith("#!/bin/sh\n")) throw new Error("installer is not a POSIX shell script");
  if (/command -v gh|gh release|gh attestation/.test(installerBody)) throw new Error("release installer still requires gh");
  if (!installerBody.includes("https://harnessharlot.com/releases/stable-macos.json")) {
    throw new Error("release installer does not trust the website release index");
  }
  execFileSync("sh", ["-n", installer.path]);

  const macos = {};
  let version;
  let build;
  for (const architecture of ["arm64", "x86_64"]) {
    const dmg = verifiedAsset(select(
      new RegExp(`^Harness-Harlot-.*-macos-${architecture}-community\\.dmg$`),
      `${architecture} community DMG`,
    ));
    const manifest = verifiedAsset(select(
      new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json$`),
      `${architecture} stable manifest`,
    ));
    const signature = verifiedAsset(select(
      new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json\\.sig$`),
      `${architecture} stable signature`,
    ));
    const body = JSON.parse(readFileSync(manifest.path, "utf8"));
    const identity = validateManifest(body, { architecture, dmg, tag });
    version ??= identity.version;
    build ??= identity.build;
    if (identity.version !== version || identity.build !== build) {
      throw new Error("release tag, version, or build disagree across architectures");
    }
    macos[architecture] = {
      dmg: publicAsset(dmg),
      manifest: publicAsset(manifest),
      signature: publicAsset(signature),
      manifest_published_at: identity.publishedAt,
      manifest_valid_until: identity.validUntil,
    };
  }

  let currentIdentity;
  try {
    const current = JSON.parse(readFileSync("public/releases/stable-macos.json", "utf8"));
    currentIdentity = { version: current.version, build: current.build };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assertNoRollback(
    currentIdentity,
    { version, build },
    { allowRollback: process.env.HH_ALLOW_RELEASE_ROLLBACK === "1" },
  );

  const index = { schema: "hh-web-release-index-v1", tag, version, build, macos };
  writeFileSync("public/releases/stable-macos.json", `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync("public/install", installerBody, { mode: 0o755 });
  console.log(`published verified ${tag} installer metadata from ${basename(installer.path)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
