import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function withRunner(files, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-test-runner-"));
  try {
    await mkdir(path.join(dir, "scripts"));
    await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    await writeFile(
      path.join(dir, "scripts", "run-tests.js"),
      await readFile(new URL("../scripts/run-tests.js", import.meta.url)),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, "test", file)), { recursive: true });
      await writeFile(path.join(dir, "test", file), source);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFixture(dir, args = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, "scripts", "run-tests.js"), ...args], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

test("test runner completes discovery before starting other suites and keeps them parallel", async () => {
  const peerSource = (name, peer) => `
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
test("${name}", { timeout: 5000 }, async () => {
  await access("discovery-complete");
  await writeFile("${name}-started", "");
  const deadline = Date.now() + 4000;
  while (true) {
    try { await access("${peer}-started"); break; }
    catch {
      assert.ok(Date.now() < deadline, "other suites must run in parallel");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
});`;
  await withRunner(
    {
      "server-discovery.test.js": `
import { writeFile } from "node:fs/promises";
import test from "node:test";
test("discovery", async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  await writeFile("discovery-complete", "");
});`,
      "a.test.js": peerSource("a", "b"),
      "nested/b.test.js": peerSource("b", "a"),
    },
    async (dir) => {
      const result = await runFixture(dir, ["--test-concurrency=2"]);
      assert.equal(result.status, 0, result.output);
    },
  );
});

test("test runner forwards name filters to both groups", async () => {
  const source = `
import test from "node:test";
test("selected", () => {});
test("excluded", () => { throw new Error("filter was ignored"); });`;
  await withRunner({ "server-discovery.test.js": source, "other.test.js": source }, async (dir) => {
    const result = await runFixture(dir, ["--test-name-pattern=selected"]);
    assert.equal(result.status, 0, result.output);
  });
});

test("test runner stops after discovery fails and returns its exit code", async () => {
  await withRunner(
    {
      "server-discovery.test.js":
        'import test from "node:test"; test("failure", () => { throw new Error("expected"); });',
      "other.test.js": 'import { writeFileSync } from "node:fs"; writeFileSync("other-started", "");',
    },
    async (dir) => {
      const result = await runFixture(dir);
      assert.equal(result.status, 1, result.output);
      await assert.rejects(readFile(path.join(dir, "other-started")), { code: "ENOENT" });
    },
  );
});
