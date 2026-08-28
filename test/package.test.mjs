import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package declares a discoverable Pi extension", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.name, "pi-fork-agent");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.ok(manifest.files.includes("runner.mjs"));
  assert.ok(manifest.files.includes("scripts/smoke-production.mjs"));
  assert.equal(manifest.scripts.smoke, "node scripts/smoke-production.mjs");
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.1 <0.85.0");
});

test("package documentation does not promise unconditional schema or cache identity", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.match(readme, /compare those provider-visible fields with the parent capture/);
  assert.match(readme, /Cache compatibility is an optimization, not a guarantee/);
});
