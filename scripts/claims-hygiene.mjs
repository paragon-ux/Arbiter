#!/usr/bin/env node

/**
 * Claims & Anti-Mock Hygiene Linter (Arbiter)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const BANNED_PATTERNS = [
  { pattern: /pre-recorded/i, name: 'pre-recorded' },
  { pattern: /sub-5ms across all 18/i, name: 'sub-5ms across all 18' },
  { pattern: /Mulberry32/i, name: 'Mulberry32' },
  { pattern: /\bTODO\b/, name: 'TODO' },
  { pattern: /\bFIXME\b/, name: 'FIXME' }
];

const TARGET_FILES = [
  'README.md',
  'FEATURE_STATUS.md',
  'CLAIMS.md'
];

let violations = 0;

for (const file of TARGET_FILES) {
  const filePath = resolve(rootDir, file);
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const { pattern, name } of BANNED_PATTERNS) {
        if (pattern.test(line)) {
          console.error(`Violation in ${file}:${idx + 1}: banned pattern "${name}" found: "${line.trim()}"`);
          violations++;
        }
      }
    });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Error reading ${file}:`, err.message);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`Claims hygiene failed with ${violations} violations.`);
  process.exit(1);
}

console.log('Claims hygiene check passed: 0 unannotated violations.');
process.exit(0);
