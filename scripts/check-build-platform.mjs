#!/usr/bin/env node
/**
 * Refuse to ship a build whose native binaries are for the wrong platform.
 *
 * sharp resolves a platform-specific binary at install time. Running `sam build` on macOS packages
 * @img/sharp-darwin-x64, which cannot load on Lambda -- every function in this stack then throws
 * "Could not load the sharp module using the linux-x64 runtime" on its first invocation. That is the whole
 * service down: uploads, processing, resizing.
 *
 * Nothing else catches it. `sam build` exits 0, and the unit tests deliberately avoid loading sharp so
 * they can run on a dev machine at all. The only evidence is inside the package, so look there.
 *
 * Usage:  npm run verify:build     (after sam build, BEFORE sam deploy)
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// What the Lambda runtime needs. Amazon Linux 2023 on x86_64 is glibc, not musl.
const REQUIRED = "sharp-linux-x64";
const BUILD_DIR = ".aws-sam/build";

if (!existsSync(BUILD_DIR)) {
  console.error(`✗ ${BUILD_DIR} does not exist. Run \`sam build --use-container\` first.`);
  process.exit(1);
}

const problems = [];
let checked = 0;

for (const entry of readdirSync(BUILD_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const imgDir = join(BUILD_DIR, entry.name, "node_modules", "@img");
  if (!existsSync(imgDir)) continue; // this function does not bundle sharp
  checked += 1;
  const platforms = readdirSync(imgDir);
  if (!platforms.includes(REQUIRED)) {
    problems.push({ fn: entry.name, platforms });
  }
}

if (checked === 0) {
  console.error("✗ No packaged function bundles sharp. Either the build is empty or the layout changed;");
  console.error("  a check that silently passes is worse than no check.");
  process.exit(1);
}

if (problems.length) {
  console.error(`✗ ${problems.length} of ${checked} packaged function(s) lack ${REQUIRED}:\n`);
  for (const { fn, platforms } of problems) {
    console.error(`    ${fn}: ${platforms.join(", ") || "(no platform binaries at all)"}`);
  }
  console.error(`\n  These WILL fail on Lambda. Rebuild inside the runtime image:`);
  console.error(`      sam build --use-container --parallel\n`);
  console.error(`  Do NOT deploy this build.`);
  process.exit(1);
}

console.log(`✓ all ${checked} packaged function(s) carry ${REQUIRED} — safe to deploy`);
