#!/usr/bin/env node
// Runs automatically on `npm publish` (via prepublishOnly).
// It exists for one reason: the package.json ships with placeholder author/repository
// values, and a published tarball cannot be unpublished cleanly — better to stop here.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];

if (/your-github-name/i.test(JSON.stringify(pkg))) {
  problems.push(
    "package.json still contains the placeholder `your-github-name`: set `author`, `repository`, `homepage` and `bugs` to your real repository first (the plugin market links npm to the repo through `repository`).",
  );
}
if (pkg.version === "0.0.0") problems.push("version is 0.0.0: pick a real first version.");
for (const file of ["lib/index.js", "cordis.patch.yml", "README.md", "README.en.md", "LICENSE"]) {
  if (!existsSync(join(root, file))) problems.push(`missing ${file}`);
}
if (pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") {
  problems.push("dsh.bundle.patch must be ./cordis.patch.yml, otherwise `dsh plugin add` cannot mount the plugin.");
}

if (problems.length > 0) {
  console.error("publish blocked:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`preflight ok: ${pkg.name}@${pkg.version}`);
