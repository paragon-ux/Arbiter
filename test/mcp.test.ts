import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { execFileSync } from "node:child_process";
import { ArbiterDatabase } from "../src/db/database.js";
import { WorktreeManager } from "../src/worktrees/worktreeManager.js";
import { WaymarkSupervisor } from "../src/waymark/waymarkSupervisor.js";
import { TaskService } from "../src/dag/taskService.js";
import { createArbiterTools } from "../src/mcp/tools.js";
import { ArbiterMcpServer } from "../src/mcp/server.js";

describe("Arbiter MCP Server Protocol Suite", () => {

function setupFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-mcp-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.email", "arbiter-mcp@example.com"], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Arbiter MCP"], { cwd: repoRoot, windowsHide: true });

  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".arbiter/\n.waymark/\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Arbiter MCP Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, windowsHide: true });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, windowsHide: true });

  return {
    repoRoot,
    cleanup: () => {
      try {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function callTool(server: ArbiterMcpServer, name: string, args: Record<string, unknown>, id = 1): Promise<Record<string, unknown>> {
  const raw = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }));
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, id);
  assert.ok(parsed.result);
  const text = parsed.result.content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

test("ArbiterMcpServer handles initialize, ping, tools/list, and full agent workflow", async () => {
  const { repoRoot, cleanup } = setupFixtureRepo();
  try {
    const db = new ArbiterDatabase(":memory:");
    const worktrees = new WorktreeManager(repoRoot);
    const waymarkCliPath = path.resolve(process.cwd(), "../../Deepseek-Project/Waymark/dist/src/cli.js");
    const waymark = new WaymarkSupervisor(waymarkCliPath);
    const taskService = new TaskService(db, worktrees, waymark);

    const tools = createArbiterTools(taskService, waymark);
    const server = new ArbiterMcpServer(tools);

    // 1. initialize
    const initRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }));
    assert.ok(initRaw);
    const initRes = JSON.parse(initRaw);
    assert.equal(initRes.result.serverInfo.name, "arbiter-mcp");

    // 2. tools/list
    const listRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }));
    assert.ok(listRaw);
    const listRes = JSON.parse(listRaw);
    assert.equal(listRes.result.tools.length, 11);

    // 3. Submit a task via MCP
    const submitRes = await callTool(server, "arbiter_submit_task", {
      task_id: "T-100",
      title: "Implement greeting endpoint",
      description: "How does the greeting service format output?",
      base_branch: "main",
    });
    assert.equal(submitRes.ok, true);
    assert.equal((submitRes.task as Record<string, unknown>).id, "T-100");

    // 4. Scan leases via MCP (none expired yet)
    const scanRes = await callTool(server, "arbiter_scan_leases", {});
    assert.equal(scanRes.ok, true);
    assert.equal(scanRes.scanned, 0);

    // 5. Agent claims task via MCP
    const claimRes = await callTool(server, "arbiter_claim_task", { worker_id: "agent-gemini", pid: process.pid });
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.task_id, "T-100");
    assert.ok(claimRes.worktree_path);
    assert.ok(claimRes.waymark_trajectory_id);

    // 6. Checkpoint with Waymark telemetry
    const checkpointRes = await callTool(server, "arbiter_checkpoint", {
      task_id: "T-100",
      worker_id: "agent-gemini",
      message: "Inspected routes and drafted greeting controller",
    });
    assert.equal(checkpointRes.ok, true);
    assert.ok(checkpointRes.waymark_status);

    // 6b. Observability metrics via MCP
    const metricsRes = await callTool(server, "arbiter_metrics", {});
    assert.equal(metricsRes.ok, true);
    assert.ok(Number((metricsRes.metrics as Record<string, unknown>).totalTasks) >= 1);

    // 7. Status check
    const statusRes = await callTool(server, "arbiter_status", { task_id: "T-100" });
    assert.equal(statusRes.ok, true);
    const inspectedTask = statusRes.task as Record<string, unknown>;
    assert.equal(inspectedTask.status, "IN_PROGRESS");

    // 8. Complete task
    const completeRes = await callTool(server, "arbiter_complete_task", {
      task_id: "T-100",
      worker_id: "agent-gemini",
      answer: "Created greeting endpoint with UTF-8 support.",
    });
    assert.equal(completeRes.ok, true);
    assert.equal(completeRes.status, "COMPLETED");

    // 9. Process merge queue via MCP
    const mergeRes = await callTool(server, "arbiter_process_merge_queue", {
      task_id: "T-100",
      target_branch: "main",
    });
    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.merged, true);

    // 10. Prune worktrees via MCP
    const pruneRes = await callTool(server, "arbiter_prune_worktrees", {});
    assert.equal(pruneRes.ok, true);

    // 11. Verify DB status
    const finishedTask = db.getTask("T-100");
    assert.equal(finishedTask?.status, "COMPLETED");
    assert.equal(finishedTask?.resultAnswer, "Created greeting endpoint with UTF-8 support.");
  } finally {
    cleanup();
  }
});
});
