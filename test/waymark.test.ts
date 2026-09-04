import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WaymarkSupervisor } from "../src/waymark/waymarkSupervisor.js";

test("WaymarkSupervisor fallback mode manages lifecycle without native CLI", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-waymark-test-"));
  try {
    const supervisor = new WaymarkSupervisor("/non/existent/path/waymark.js");
    assert.equal(supervisor.isFallbackMode(), true);

    // 1. initWorktree
    const inited = supervisor.initWorktree(tempDir, "recording");
    assert.equal(inited, true);
    assert.equal(fs.existsSync(path.join(tempDir, ".waymark")), true);

    // 2. beginTrajectory
    const trajId = supervisor.beginTrajectory(tempDir, "Test continuity task");
    assert.ok(trajId.startsWith("trj_mock_"));

    // 3. getStatus
    const status = supervisor.getStatus(tempDir);
    assert.equal(status.status, "STAGED");
    assert.equal(status.trajectoryId, trajId);

    // 4. checkIntegrity & recoverLock
    const integrity = supervisor.checkIntegrity(tempDir);
    assert.equal(integrity.ok, true);

    const recovery = supervisor.recoverLock(tempDir);
    assert.equal(recovery.ok, true);

    // 5. completeTrajectory
    const completed = supervisor.completeTrajectory(tempDir, trajId, "Resolved successfully.");
    assert.equal(completed.ok, true);
    assert.equal(completed.id, trajId);

    const postStatus = supervisor.getStatus(tempDir);
    assert.equal(postStatus.status, "COMMITTED");

    // 6. abandonTrajectory
    const abandoned = supervisor.abandonTrajectory(tempDir, trajId, "Cancelled");
    assert.equal(abandoned, true);
    const postAbandonStatus = supervisor.getStatus(tempDir);
    assert.equal(postAbandonStatus.status, "ABANDONED");
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
