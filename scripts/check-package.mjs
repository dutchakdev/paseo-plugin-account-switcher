import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { publishedManifest } from "./pack-manifest.mjs";
import { inspectShrinkwrap } from "./shrinkwrap.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The tarball is what npm, Paseo Cafe and the Paseo plugin directory install.
const REQUIRED = [
  "package.json", "npm-shrinkwrap.json", "paseo-plugin.json", "OVERVIEW.md", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
  "index.client.tsx", "index.server.ts", "server/launcher-artifact.ts", "shared/contracts.ts",
];
const FORBIDDEN = ["tests/", "docs/", "scripts/", ".github/", ".local/", "node_modules/", "paseo-plugin.json.git"];
// The plugin directory rejects overviews, translations included, that carry install commands.
const OVERVIEW_COMMANDS = /paseo plugin add|npm install|\bnpm i\b/;
const OVERVIEW_FILE = /^OVERVIEW(\.[^/]+)?\.md$/;

/** Problems with a packed tarball, given its file list and the files the registry reads. */
export function inspectPackage({ files, manifest, overviews = {}, sourceManifest, packageJson, shrinkwrap }) {
  const problems = [];
  for (const file of REQUIRED) if (!files.includes(file)) problems.push(`missing ${file}`);
  for (const file of files) if (FORBIDDEN.some((prefix) => file.startsWith(prefix))) problems.push(`unexpected ${file}`);
  if (JSON.stringify(manifest) !== JSON.stringify(publishedManifest(sourceManifest))) {
    problems.push("paseo-plugin.json differs from the source manifest without its build commands");
  }
  // The plugin directory resolves the manifest icon inside the tarball.
  if (manifest?.icon && !files.includes(manifest.icon)) problems.push(`missing ${manifest.icon}, the manifest icon`);
  for (const [file, text] of Object.entries(overviews)) if (OVERVIEW_COMMANDS.test(text)) problems.push(`${file} contains an install command`);
  // Paseo installs npm plugins with npm, which honors only a published shrinkwrap.
  if (packageJson) problems.push(...inspectShrinkwrap(shrinkwrap, packageJson));
  return problems;
}

function tar(tarball, ...args) {
  return execFileSync("tar", [...args, tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error("Usage: node scripts/check-package.mjs <package.tgz>");
    process.exit(2);
  }
  const files = tar(tarball, "-tzf").split("\n").filter(Boolean).map((entry) => entry.replace(/^package\//, ""));
  const extract = (file) => (files.includes(file) ? execFileSync("tar", ["-xOzf", tarball, `package/${file}`], { encoding: "utf8" }) : undefined);
  const problems = inspectPackage({
    files,
    manifest: JSON.parse(extract("paseo-plugin.json") ?? "null"),
    overviews: Object.fromEntries(files.filter((file) => OVERVIEW_FILE.test(file)).map((file) => [file, extract(file)])),
    sourceManifest: JSON.parse(readFileSync(join(root, "paseo-plugin.json"), "utf8")),
    packageJson: JSON.parse(extract("package.json") ?? "null"),
    shrinkwrap: JSON.parse(extract("npm-shrinkwrap.json") ?? "null"),
  });
  if (problems.length) {
    console.error(`${tarball}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${tarball}: ${files.length} files, manifest and overview as expected.`);
}
