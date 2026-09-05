import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const crateDir = path.join(repoRoot, 'crates', 'arbiter-kernel');
const targetReleaseDir = path.join(crateDir, 'target', 'release');
const distNativeDir = path.join(repoRoot, 'dist', 'native');
const srcNativeDir = path.join(repoRoot, 'native');

function findExistingBinary() {
  const candidates = [
    path.join(targetReleaseDir, 'arbiter_kernel.node'),
    path.join(targetReleaseDir, 'arbiter_kernel.dll'),
    path.join(targetReleaseDir, 'libarbiter_kernel.so'),
    path.join(targetReleaseDir, 'libarbiter_kernel.dylib'),
    path.join(distNativeDir, 'arbiter-kernel.node'),
    path.join(srcNativeDir, 'arbiter-kernel.node'),
  ];
  return candidates.find(fs.existsSync) ?? null;
}

function buildWithCargo() {
  console.log('[arbiter-kernel] Building native Rust kernel via cargo...');
  if (process.platform === 'win32') {
    const vcvarsCandidates = [
      'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat',
    ];
    let vcvars = vcvarsCandidates.find((p) => fs.existsSync(p));
    if (vcvars) {
      execFileSync('cmd.exe', ['/c', `call "${vcvars}" && cargo build --release`], {
        cwd: crateDir,
        stdio: 'inherit',
      });
      return;
    }
  }

  execFileSync('cargo', ['build', '--release'], {
    cwd: crateDir,
    stdio: 'inherit',
  });
}

function copyArtifacts(srcPath) {
  fs.mkdirSync(distNativeDir, { recursive: true });
  fs.mkdirSync(srcNativeDir, { recursive: true });

  const destDist = path.join(distNativeDir, 'arbiter-kernel.node');
  const destSrc = path.join(srcNativeDir, 'arbiter-kernel.node');

  fs.copyFileSync(srcPath, destDist);
  fs.copyFileSync(srcPath, destSrc);
  console.log(`[arbiter-kernel] Installed native addon: ${destDist}`);
}

function main() {
  const force = process.argv.includes('--force') || process.argv.includes('--rebuild');
  let binary = findExistingBinary();

  if (!binary || force) {
    try {
      buildWithCargo();
      binary = findExistingBinary();
    } catch (err) {
      console.warn(`[arbiter-kernel] Cargo build failed or skipped: ${err.message}`);
    }
  }

  if (binary) {
    copyArtifacts(binary);
  } else {
    console.warn('[arbiter-kernel] Warning: No compiled native kernel binary found. Arbiter will operate in CLI fallback mode.');
  }
}

main();
