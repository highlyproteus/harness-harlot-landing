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
const verifiedAssetOffset = publisher.indexOf("function verifiedAsset");
const verifiedNoOpOffset = publisher.indexOf("verifiedPublicationMatchesRelease()");
assert.ok(verifiedAssetOffset >= 0 && verifiedNoOpOffset > verifiedAssetOffset, "no-op must run only after attestation verification is available");

assert.equal(releaseIndex.schema, "hh-web-release-index-v1");
assert.match(releaseIndex.tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/);
assert.match(releaseIndex.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
for (const architecture of ["arm64", "x86_64"]) {
  const item = releaseIndex.macos[architecture];
  assert.ok(item, `missing ${architecture} release`);
  assert.match(item.manifest_published_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(item.manifest_valid_until, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(item.manifest_valid_until) > Date.now(), `${architecture} manifest must remain valid`);
  for (const asset of [item.dmg, item.manifest, item.signature]) {
    assert.match(asset.url, /^https:\/\/github\.com\/highlyproteus\/harness-harlot\/releases\/download\//);
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
  assert.ok(Date.parse(item.manifest_valid_until) > Date.now(), `${architecture} Linux manifest must remain valid`);
  for (const asset of [item.archive, item.manifest, item.signature]) {
    assert.match(asset.url, /^https:\/\/github\.com\/highlyproteus\/harness-harlot\/releases\/download\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
}

console.log("clean universal installer surface contains macOS and Linux releases");
