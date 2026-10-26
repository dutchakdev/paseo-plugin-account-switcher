import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { inspectPackage } from "../scripts/check-package.mjs";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { publishedManifest } from "../scripts/pack-manifest.mjs";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
const sourceManifest = JSON.parse(read("paseo-plugin.json"));
const files = [
  "package.json", "npm-shrinkwrap.json", "paseo-plugin.json", "OVERVIEW.md", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "assets/icon.png",
  "index.client.tsx", "index.server.ts", "server/launcher-artifact.ts", "shared/contracts.ts", "client/runtime.ts",
];
const overviews = { "OVERVIEW.md": read("OVERVIEW.md"), "OVERVIEW.zh-CN.md": read("OVERVIEW.zh-CN.md") };
const inspect = (overrides: Record<string, unknown>) => inspectPackage({ files, manifest: publishedManifest(sourceManifest), overviews, sourceManifest, ...overrides });

describe("packed tarball", () => {
  it("accepts the repository's own manifest and overviews", () => {
    expect(inspect({})).toEqual([]);
  });

  it("names missing files and development files that leaked in", () => {
    expect(inspect({ files: [...files.filter((file) => file !== "OVERVIEW.md"), "tests/setup.ts", "paseo-plugin.json.git"] }))
      .toEqual(["missing OVERVIEW.md", "unexpected tests/setup.ts", "unexpected paseo-plugin.json.git"]);
  });

  it("rejects a manifest that still carries the Git-only build commands", () => {
    expect(inspect({ manifest: sourceManifest })).toEqual(["paseo-plugin.json differs from the source manifest without its build commands"]);
  });

  it("requires the icon the manifest declares, which the plugin directory reads from the tarball", () => {
    expect(inspect({ files: files.filter((file) => file !== "assets/icon.png") })).toEqual(["missing assets/icon.png, the manifest icon"]);
  });

  it("rejects an overview with an install command, which the plugin directory refuses", () => {
    expect(inspect({ overviews: { "OVERVIEW.md": "Run `paseo plugin add dutchakdev/account-switcher`." } })).toEqual(["OVERVIEW.md contains an install command"]);
    expect(inspect({ overviews: { "OVERVIEW.md": "Then npm i the CLI." } })).toEqual(["OVERVIEW.md contains an install command"]);
  });

  it("applies the same rule to translated overviews, which the directory shows per language", () => {
    expect(inspect({ overviews: { ...overviews, "OVERVIEW.zh-CN.md": "运行 `paseo plugin add dutchakdev/account-switcher`。" } }))
      .toEqual(["OVERVIEW.zh-CN.md contains an install command"]);
  });
});
