import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
      const expected = {
        dmg: publishedMetadata(dmg),
        manifest: publishedMetadata(select(new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json$`), `${architecture} stable manifest`)),
        signature: publishedMetadata(select(new RegExp(`^manifest-macos-community-${architecture}\\.update\\.json\\.sig$`), `${architecture} stable signature`)),
      };
      if (JSON.stringify(current.macos?.[architecture]) !== JSON.stringify(expected)) return false;
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
    if (body.artifacts?.[0]?.sha256 !== dmg.sha256) throw new Error(`${architecture} manifest does not match DMG`);
    if (body.artifacts?.[0]?.url !== dmg.url) throw new Error(`${architecture} manifest URL does not match release asset`);
    version ??= body.version;
    build ??= body.build;
    if (body.version !== version || body.build !== build || tag !== `v${body.version}`) {
      throw new Error("release tag, version, or build disagree across architectures");
    }
    macos[architecture] = {
      dmg: publicAsset(dmg),
      manifest: publicAsset(manifest),
      signature: publicAsset(signature),
    };
  }

  const index = { schema: "hh-web-release-index-v1", tag, version, build, macos };
  writeFileSync("public/releases/stable-macos.json", `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync("public/install", installerBody, { mode: 0o755 });
  console.log(`published verified ${tag} installer metadata from ${basename(installer.path)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
