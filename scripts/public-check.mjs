import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";

const root = process.cwd();
const decoder = new TextDecoder("utf-8", { fatal: true });
const files = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const checks = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: "provider-secret", pattern: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/u },
  { name: "local-path", pattern: /(?:^|[\s"'`])(?:[A-Za-z]:[\\/]+Users[\\/]+|\\\\[^\s"'`]+|\/(?:Users|home)\/)[^\s"'`]+/iu },
];

const findings = [];
for (const relative of files) {
  if (relative === "scripts/public-check.mjs") continue;
  const target = path.resolve(root, relative);
  let text;
  try {
    text = decoder.decode(fs.readFileSync(target));
  } catch {
    findings.push({ file: relative.replaceAll("\\", "/"), check: "unreadable-or-non-utf8" });
    continue;
  }
  for (const check of checks) {
    if (check.pattern.test(text)) {
      findings.push({ file: relative.replaceAll("\\", "/"), check: check.name });
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Public hygiene check failed: ${JSON.stringify(findings, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ arbiter: 1, kind: "public-check", ok: true, files: files.length }) + "\n");
}
