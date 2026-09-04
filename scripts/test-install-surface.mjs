import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const installer = await readFile(new URL("../public/install", import.meta.url), "utf8");
const macosInstaller = await readFile(new URL("../public/install-macos", import.meta.url), "utf8");
const linuxInstaller = await readFile(new URL("../public/install-linux", import.meta.url), "utf8");
const releaseIndex = JSON.parse(
  await readFile(new URL("../public/releases/stable-macos.json", import.meta.url), "utf8"),
);
const linuxReleaseIndex = JSON.parse(
  await readFile(new URL("../public/releases/stable-linux.json", import.meta.url), "utf8"),
);
const page = await readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8");
const publisher = await readFile(new URL("./publish-latest-release.mjs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/sync-release.yml", import.meta.url), "utf8");

assert.match(installer, /^#!\/bin\/sh\n/);
assert.doesNotMatch(installer, /command -v gh|gh release|gh attestation/);
assert.match(installer, /Darwin\) installer_url='https:\/\/harnessharlot\.com\/install-macos'/);
assert.match(installer, /Linux\) installer_url='https:\/\/harnessharlot\.com\/install-linux'/);
assert.match(installer, /curl --max-filesize 1048576 -fsS "\$installer_url" -o "\$platform_installer"/);
assert.match(installer, /sh -n "\$platform_installer"/);
assert.match(installer, /sh "\$platform_installer" "\$@"/);
assert.doesNotMatch(installer, /curl --proto|curl .* -L/);
assert.match(macosInstaller, /https:\/\/harnessharlot\.com\/releases\/stable-macos\.json/);
assert.match(macosInstaller, /actual=\$\(shasum -a 256 "\$file"/);
assert.match(linuxInstaller, /https:\/\/harnessharlot\.com\/releases\/stable-linux\.json/);
assert.match(linuxInstaller, /actual=\$\(sha256sum "\$file"/);
assert.doesNotMatch(linuxInstaller, /command -v gh|gh release|gh attestation/);
assert.match(page, /curl -fsS https:\/\/harnessharlot\.com\/install \| sh/);
assert.doesNotMatch(page, /curl --proto|linuxCommand|data-linux-command/);
assert.match(publisher, /"attestation", "verify"/);
assert.match(publisher, /stable-macos\.json/);
assert.match(publisher, /stable-linux\.json/);
assert.match(workflow, /schedule:/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /contents: write/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /needs: verify/);
assert.match(workflow, /upload-artifact@/);
assert.match(workflow, /download-artifact@/);
assert.match(publisher, /--signer-workflow/);
assert.match(publisher, /--source-ref/);
assert.match(publisher, /--source-digest/);
assert.match(publisher, /refresh descriptor is not canonical JSON/);
assert.match(publisher, /update manifest is not canonical JSON/);
assert.match(publisher, /--deny-self-hosted-runners/);
assert.match(publisher, /latestSuccessfulRefreshRun\(\)/);
assert.match(publisher, /stable-v2-refresh/);
assert.match(publisher, /validateRefreshDescriptor/);
assert.match(publisher, /validateRefreshEntries/);
assert.match(publisher, /assertRefreshMonotonic/);
assert.match(publisher, /installerSupportsStableV2Base/);
assert.match(publisher, /fully verified/);
assert.match(publisher, /backward-compatible GitHub-v2/);
const planOffset = publisher.lastIndexOf("const plan = planPublication()");
const noOpOffset = publisher.lastIndexOf("publicationMatches(plan)");
const writeOffset = publisher.lastIndexOf("writePublication(plan)");
assert.ok(planOffset >= 0 && noOpOffset > planOffset && writeOffset > noOpOffset, "full verification must precede no-op and every write");
for (const name of [
  "manifest-macos-community-arm64-v2.update.json",
  "manifest-macos-community-x86_64-v2.update.json",
  "manifest-linux-arm64-v2.update.json",
  "manifest-linux-x86_64-v2.update.json",
]) {
  assert.ok(workflow.includes(`public/releases/stable-v2/${name}`));
  assert.ok(workflow.includes(`public/releases/stable-v2/${name}.sig`));
}

function assertManifestSource(item, alias, tag) {
  const allowed = [
    `https://github.com/highlyproteus/harness-harlot/releases/download/${tag}/${alias}`,
    `https://harnessharlot.com/releases/stable-v2/${alias}`,
  ];
  assert.ok(allowed.includes(item.manifest.url), "unexpected manifest source");
  assert.equal(item.signature.url, `${item.manifest.url}.sig`, "signature must match manifest source");
}

for (const platform of ["macos-community", "linux"]) {
  for (const architecture of ["arm64", "x86_64"]) {
    const alias = `manifest-${platform}-${architecture}-v2.update.json`;
    const github = `https://github.com/highlyproteus/harness-harlot/releases/download/${releaseIndex.tag}/${alias}`;
    const website = `https://harnessharlot.com/releases/stable-v2/${alias}`;
    const entry = (url) => ({ manifest: { url }, signature: { url: `${url}.sig` } });
    for (const valid of [github, website]) {
      assertManifestSource(entry(valid), alias, releaseIndex.tag);
    }
    for (const invalid of [
      website.replace("https:", "http:"),
      website.replace("harnessharlot.com", "harnessharlot.com.evil.example"),
      website.replace("harnessharlot.com/", "user@harnessharlot.com/"),
      website.replace("stable-v2/", "other/"),
      `${website}?override=1`,
      `${website}#fragment`,
      github.replace(`/download/${releaseIndex.tag}/`, "/download/wrong-tag/"),
      website.replace(alias, "wrong-architecture.update.json"),
    ]) {
      assert.throws(() => assertManifestSource(entry(invalid), alias, releaseIndex.tag));
    }
    assert.throws(() => assertManifestSource({
      manifest: { url: website }, signature: { url: `${github}.sig` },
    }, alias, releaseIndex.tag));
  }
}

assert.equal(releaseIndex.schema, "hh-web-release-index-v1");
assert.match(releaseIndex.tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/);
assert.match(releaseIndex.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
for (const architecture of ["arm64", "x86_64"]) {
  const item = releaseIndex.macos[architecture];
  assert.ok(item, `missing ${architecture} release`);
  assert.equal(
    new URL(item.manifest.url).pathname.split("/").at(-1),
    `manifest-macos-community-${architecture}-v2.update.json`,
  );
  assert.equal(
    new URL(item.signature.url).pathname.split("/").at(-1),
    `manifest-macos-community-${architecture}-v2.update.json.sig`,
  );
  assert.match(item.manifest_published_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(item.manifest_valid_until, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(item.manifest_valid_until) > Date.now(), `${architecture} manifest must remain valid`);
  assertManifestSource(item, `manifest-macos-community-${architecture}-v2.update.json`, releaseIndex.tag);
  assert.equal(item.dmg.url,
    `https://github.com/highlyproteus/harness-harlot/releases/download/${releaseIndex.tag}/Harness-Harlot-${releaseIndex.version}-b${releaseIndex.build}-macos-${architecture}-community.dmg`);
  for (const asset of [item.dmg, item.manifest, item.signature]) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
}

assert.equal(linuxReleaseIndex.schema, "hh-web-release-index-v1");
assert.equal(linuxReleaseIndex.tag, releaseIndex.tag);
assert.equal(linuxReleaseIndex.version, releaseIndex.version);
assert.equal(linuxReleaseIndex.build, releaseIndex.build);
for (const architecture of ["arm64", "x86_64"]) {
  const item = linuxReleaseIndex.linux[architecture];
  assert.ok(item, `missing Linux ${architecture} release`);
  assert.equal(
    new URL(item.manifest.url).pathname.split("/").at(-1),
    `manifest-linux-${architecture}-v2.update.json`,
  );
  assert.equal(
    new URL(item.signature.url).pathname.split("/").at(-1),
    `manifest-linux-${architecture}-v2.update.json.sig`,
  );
  assert.ok(Date.parse(item.manifest_valid_until) > Date.now(), `${architecture} Linux manifest must remain valid`);
  assertManifestSource(item, `manifest-linux-${architecture}-v2.update.json`, linuxReleaseIndex.tag);
  assert.equal(item.archive.url,
    `https://github.com/highlyproteus/harness-harlot/releases/download/${linuxReleaseIndex.tag}/Harness-Harlot-${linuxReleaseIndex.version}-b${linuxReleaseIndex.build}-linux-${architecture}.tar.gz`);
  for (const asset of [item.archive, item.manifest, item.signature]) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
}

console.log("clean universal installer surface contains macOS and Linux releases");
