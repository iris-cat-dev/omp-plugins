import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageGenerationQuotaLedger, type QQImageQuotaContext } from './image-quota-ledger.ts';

const owner: QQImageQuotaContext = { appId: "app", scope: "c2c", senderId: "alice" };
const noon = Date.parse("2026-11-24T04:00:00Z");
const roots: string[] = [];
const ledgers: ImageGenerationQuotaLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "image-quota-"));
  roots.push(root);
  const databasePath = join(root, "private", "quota.sqlite");
  return { databasePath, ledger: open(databasePath) };
}
function open(databasePath: string) {
  const ledger = new ImageGenerationQuotaLedger(databasePath, 10);
  ledgers.push(ledger);
  return ledger;
}
function fill(ledger: ImageGenerationQuotaLedger, quota = owner, prefix = "request", now = noon) {
  for (let index = 0; index < 10; index++) {
    const id = `${prefix}:${index}`;
    ledger.reserve(id, quota, now);
    ledger.settle(id, "succeeded");
  }
}

describe("durable QQ image reservation quota", () => {
  it("refuses the eleventh new generation while successful replay consumes only once", () => {
    const { ledger } = fixture();
    fill(ledger);
    expect(ledger.reserve("request:0", owner, noon)).toMatchObject({ created: false, state: "succeeded" });
    expect(() => ledger.reserve("eleventh", owner, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
  });

  it("keeps sender, conversation scope and actual AppID buckets independent", () => {
    const { ledger } = fixture();
    const owners: QQImageQuotaContext[] = [owner, { ...owner, senderId: "bob" }, { ...owner, scope: "group" }, { ...owner, appId: "another-app" }];
    for (const [index, quota] of owners.entries()) {
      fill(ledger, quota, `bucket-${index}`);
      expect(() => ledger.reserve(`overflow-${index}`, quota, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
    }
  });

  it("starts the next bucket at Beijing midnight and settles against the admission day", () => {
    const { ledger } = fixture();
    const before = Date.parse("2026-11-24T15:59:59.999Z");
    fill(ledger, owner, "old-day", before);
    expect(() => ledger.reserve("too-soon", owner, before)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
    const after = before + 1;
    expect(ledger.reserve("next-day", owner, after)).toEqual({ created: true, state: "pending", day: "2026-11-25" });
    ledger.settle("next-day", "succeeded");
    expect(ledger.reserve("old-day:0", owner, after)).toMatchObject({ day: "2026-11-24", state: "succeeded", created: false });
  });

  it("releases explicit failures once and cannot refund successful or uncertain outcomes", () => {
    const { ledger } = fixture();
    for (let index = 0; index < 10; index++) ledger.reserve(`pending:${index}`, owner, noon);
    expect(() => ledger.reserve("full", owner, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
    ledger.settle("pending:0", "failed");
    ledger.settle("pending:0", "failed");
    expect(ledger.reserve("replacement", owner, noon)).toMatchObject({ created: true });
    ledger.settle("replacement", "succeeded");
    ledger.settle("replacement", "failed");
    expect(ledger.reserve("replacement", owner, noon)).toMatchObject({ state: "succeeded", created: false });
    expect(ledger.reserve("pending:1", owner, noon)).toMatchObject({ state: "pending", created: false });
    expect(() => ledger.reserve("cannot-refund", owner, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
  });

  it("retains pending reservations on reopen and reconciles known results without resetting usage", () => {
    const { ledger, databasePath } = fixture();
    for (let index = 0; index < 10; index++) ledger.reserve(`restart:${index}`, owner, noon);
    ledger.close();
    ledgers.splice(ledgers.indexOf(ledger), 1);
    const reopened = open(databasePath);
    expect(() => reopened.reserve("restart-overflow", owner, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
    reopened.settle("restart:0", "succeeded");
    reopened.settle("restart:1", "failed");
    reopened.reserve("after-reconcile", owner, noon);
    expect(() => reopened.reserve("still-full", owner, noon)).toThrow("QQ_IMAGE_QUOTA_EXHAUSTED");
  });

  it("shares the ten-call ceiling between simultaneously running robot processes", async () => {
    const { databasePath } = fixture();
    const program = `import { ImageGenerationQuotaLedger } from ${JSON.stringify(new URL('./image-quota-ledger.ts', import.meta.url).href)};
const ledger = new ImageGenerationQuotaLedger(${JSON.stringify(databasePath)}, 10);
const start = Promise.withResolvers();
process.stdin.once('data', () => start.resolve());
process.stdout.write('READY\\n');
await start.promise;
let admitted = 0, rejected = 0;
try {
  for (let i = 0; i < 20; i++) {
    try { ledger.reserve('process:' + process.pid + ':' + i, ${JSON.stringify(owner)}, ${noon}); admitted++; }
    catch (error) { if (!String(error).includes('QQ_IMAGE_QUOTA_EXHAUSTED')) throw error; rejected++; }
  }
} finally { ledger.close(); process.stdin.destroy(); }
process.stdout.write(JSON.stringify({admitted, rejected}));`;
    const workers = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
      const ready = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<{ admitted: number; rejected: number }>();
      let output = "", errors = "";
      child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("READY\n")) ready.resolve(); });
      child.stderr.on("data", chunk => { errors += String(chunk); });
      child.once("error", error => { ready.reject(error); completed.reject(error); });
      child.once("close", code => {
        if (code !== 0) { const error = new Error(`Quota worker failed (${code}): ${errors}`); ready.reject(error); completed.reject(error); return; }
        try { completed.resolve(JSON.parse(output.slice(output.indexOf("\n") + 1))); }
        catch (error) { completed.reject(error); }
      });
      return { child, ready: ready.promise, completed: completed.promise };
    });
    try {
      await Promise.all(workers.map(worker => worker.ready));
      for (const worker of workers) worker.child.stdin.end("go\n");
      const results = await Promise.all(workers.map(worker => worker.completed));
      expect(results.reduce((sum, result) => sum + result.admitted, 0)).toBe(10);
      expect(results.reduce((sum, result) => sum + result.rejected, 0)).toBe(30);
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    }
  });

  it("rejects missing sender and cross-owner request replay instead of transferring reservations", () => {
    const { ledger } = fixture();
    expect(() => ledger.reserve("anonymous", { ...owner, senderId: " " }, noon)).toThrow("QQ_IMAGE_QUOTA_IDENTITY_REQUIRED");
    ledger.reserve("owned", owner, noon);
    expect(() => ledger.reserve("owned", { ...owner, senderId: "bob" }, noon)).toThrow("request identity changed");
  });
});
