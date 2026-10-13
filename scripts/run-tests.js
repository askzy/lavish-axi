import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = (await readdir(path.join(root, "test"), { recursive: true }))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => path.join("test", file))
  .sort();
const isolatedFiles = ["server-discovery.test.js", "cli-version.test.js"].map((file) => path.join("test", file));

// Discovery reuses ports; version timing needs startup free from parallel suite load.
const groups = [...isolatedFiles.map((file) => [file]), files.filter((file) => !isolatedFiles.includes(file))];
for (const group of groups) {
  const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...group], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
