import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "paseo-plugin.json");
const backupPath = join(root, "paseo-plugin.json.git");

// Paseo runs manifest build commands for npm installs too, but installs the
// package with --omit=dev and without its lockfile. The tarball therefore ships
// the generated launcher and a manifest without the Git-only build commands.
export function publishedManifest(manifest) {
  const { build: _gitOnly, ...published } = manifest;
  return published;
}

async function strip() {
  if (existsSync(backupPath)) throw new Error("paseo-plugin.json.git exists. Run `node scripts/pack-manifest.mjs restore` first.");
  await copyFile(manifestPath, backupPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(publishedManifest(manifest))}\n`);
}

async function restore() {
  if (existsSync(backupPath)) await rename(backupPath, manifestPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "strip") await strip();
  else if (command === "restore") await restore();
  else throw new Error("Usage: node scripts/pack-manifest.mjs <strip|restore>");
}
