import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging helper is plain ESM without declarations.
import { publishedManifest } from "../scripts/pack-manifest.mjs";

const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8"));

describe("published manifest", () => {
  it("drops only the Git-only build commands", () => {
    const manifest = read("paseo-plugin.json");
    expect(manifest.build).toBeDefined();
    const { build: _build, ...rest } = manifest;
    expect(publishedManifest(manifest)).toEqual(rest);
  });

  it("ships the generated launcher that the dropped build would have produced", () => {
    const pkg = read("package.json");
    expect(pkg.files).toContain("server/");
    expect(pkg.scripts.prepack).toContain("npm run build");
    expect(pkg.scripts.prepack).toContain("pack-manifest.mjs strip");
    expect(pkg.scripts.postpack).toContain("pack-manifest.mjs restore");
  });
});
