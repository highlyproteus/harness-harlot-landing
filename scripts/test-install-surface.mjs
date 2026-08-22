import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const installer = await readFile(new URL("../public/install", import.meta.url), "utf8");
const releaseIndex = JSON.parse(
  await readFile(new URL("../public/releases/stable-macos.json", import.meta.url), "utf8"),
);
const page = await readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8");
const publisher = await readFile(new URL("./publish-latest-release.mjs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/sync-release.yml", import.meta.url), "utf8");

assert.match(installer, /^#!\/bin\/sh\n/);
assert.doesNotMatch(installer, /command -v gh|gh release|gh attestation/);
assert.match(installer, /https:\/\/harnessharlot\.com\/releases\/stable-macos\.json/);
assert.match(installer, /curl --proto '=https' --tlsv1\.2 -f/);
assert.match(installer, /shasum -a 256 -c -/);
assert.doesNotMatch(installer, /Fetch the release index[\s\S]{0,160}proto-redir/);
assert.match(page, /curl --proto '=https' --tlsv1\.2 -fsS https:\/\/harnessharlot\.com\/install \| sh/);
assert.match(publisher, /"attestation", "verify"/);
assert.match(publisher, /stable-macos\.json/);
assert.match(workflow, /schedule:/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /contents: write/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /needs: verify/);
assert.match(workflow, /upload-artifact@/);
assert.match(workflow, /download-artifact@/);
assert.match(publisher, /--signer-workflow/);
assert.match(publisher, /--source-ref/);

assert.equal(releaseIndex.schema, "hh-web-release-index-v1");
assert.match(releaseIndex.tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/);
assert.match(releaseIndex.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
for (const architecture of ["arm64", "x86_64"]) {
  const item = releaseIndex.macos[architecture];
  assert.ok(item, `missing ${architecture} release`);
  for (const asset of [item.dmg, item.manifest, item.signature]) {
    assert.match(asset.url, /^https:\/\/github\.com\/highlyproteus\/harness-harlot\/releases\/download\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
}

console.log("clean curl installer surface is complete and contains both macOS architectures");
