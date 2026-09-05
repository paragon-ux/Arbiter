#!/usr/bin/env node

/**
 * Version Registry & Automated Suite Version Bumper (Arbiter)
 *
 * Keeps all version references across living documentation and manifests synchronized.
 *
 * Usage:
 *   node scripts/bump-version.mjs --check        -> Asserts zero version drift across living targets
 *   node scripts/bump-version.mjs <new-version>  -> Atomically updates all living version targets
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const pkgPath = resolve(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

export const LIVING_VERSION_TARGETS = [
  {
    name: 'Package Manifest',
    file: 'package.json',
    regex: /"version":\s*"[^"]+"/,
    format: (v) => `"version": "${v}"`,
    extract: (content) => content.match(/"version":\s*"([^"]+)"/)?.[1],
  },
  {
    name: 'Cargo Kernel Manifest',
    file: 'crates/arbiter-kernel/Cargo.toml',
    regex: /version\s*=\s*"[^"]+"/,
    format: (v) => `version = "${v}"`,
    extract: (content) => content.match(/version\s*=\s*"([^"]+)"/)?.[1],
  },
  {
    name: 'README Version Badge',
    file: 'README.md',
    regex: /https:\/\/img\.shields\.io\/badge\/version-[0-9.]+-blue\.svg/,
    format: (v) => `https://img.shields.io/badge/version-${v}-blue.svg`,
    extract: (content) => content.match(/badge\/version-([0-9.]+)-blue/)?.[1],
  },
  {
    name: 'CLAIMS Document Header',
    file: 'CLAIMS.md',
    regex: /\*\*Document Version:\*\*\s*[0-9.]+(-PROD)?/,
    format: (v) => `**Document Version:** ${v}-PROD`,
    extract: (content) => content.match(/\*\*Document Version:\*\*\s*([0-9.]+)(?:-PROD)?/)?.[1],
  },
  {
    name: 'Feature Status Document Header',
    file: 'docs/FEATURE_STATUS.md',
    regex: /\*\*Document Version:\*\*\s*[0-9.]+(-PROD)?/,
    format: (v) => `**Document Version:** ${v}-PROD`,
    extract: (content) => content.match(/\*\*Document Version:\*\*\s*([0-9.]+)(?:-PROD)?/)?.[1],
  },
];

const targetArg = process.argv[2];

if (!targetArg || targetArg === '--help') {
  console.log(`Current suite version: ${currentVersion}`);
  console.log('\nUsage:');
  console.log('  node scripts/bump-version.mjs --check       Assert all files match package.json');
  console.log('  node scripts/bump-version.mjs <X.Y.Z>       Bump all living version references');
  process.exit(0);
}

if (targetArg === '--check') {
  let drifts = 0;
  for (const target of LIVING_VERSION_TARGETS) {
    const fullPath = resolve(rootDir, target.file);
    const content = readFileSync(fullPath, 'utf8');
    const detected = target.extract(content);
    if (detected !== currentVersion) {
      console.error(`[VERSION DRIFT] ${target.name} (${target.file}): expected ${currentVersion}, found ${detected}`);
      drifts++;
    }
  }

  if (drifts > 0) {
    console.error(`Version check failed with ${drifts} drifts against package.json (${currentVersion}).`);
    process.exit(1);
  }

  console.log(`All living version targets synchronized to v${currentVersion} (0 drift).`);
  process.exit(0);
}

// Bump mode
const nextVersion = targetArg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(nextVersion)) {
  console.error(`Error: Invalid semver format: ${targetArg}`);
  process.exit(1);
}

console.log(`Bumping suite version from ${currentVersion} -> ${nextVersion}...`);

for (const target of LIVING_VERSION_TARGETS) {
  const fullPath = resolve(rootDir, target.file);
  const content = readFileSync(fullPath, 'utf8');
  if (!target.regex.test(content)) {
    console.error(`Error: Pattern not found in ${target.file}`);
    process.exit(1);
  }
  const updated = content.replace(target.regex, target.format(nextVersion));
  writeFileSync(fullPath, updated, 'utf8');
  console.log(`  ✓ Updated ${target.name} (${target.file})`);
}

// Add changelog section if not already present
const changelogPath = resolve(rootDir, 'CHANGELOG.md');
const changelogContent = readFileSync(changelogPath, 'utf8');
const header = `## [${nextVersion}]`;
if (!changelogContent.includes(header)) {
  const today = new Date().toISOString().slice(0, 10);
  const newSection = `## [${nextVersion}] — ${today}\n\n- Version bump to ${nextVersion}.\n\n`;
  const insertIndex = changelogContent.indexOf('## [');
  if (insertIndex !== -1) {
    const updatedChangelog = changelogContent.slice(0, insertIndex) + newSection + changelogContent.slice(insertIndex);
    writeFileSync(changelogPath, updatedChangelog, 'utf8');
    console.log(`  ✓ Prepended release entry to CHANGELOG.md`);
  }
}

console.log(`\nSuccessfully bumped living version targets to ${nextVersion}.`);
