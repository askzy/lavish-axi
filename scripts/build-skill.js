// Generates skills/lavish/SKILL.md from the shared no-args home output so the
// installable skill never drifts from what `lavish-axi` (and the SessionStart hook) print.
//
//   node scripts/build-skill.js          # write the file
//   node scripts/build-skill.js --check  # fail (exit 1) if the committed file is stale
//   node scripts/build-skill.js --local  # write the gitignored dist/skill-local/SKILL.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSkillMarkdown, localInvocation, shortestEquivalentPath } from "../src/skill.js";

const target = new URL("../skills/lavish/SKILL.md", import.meta.url);

if (process.argv.includes("--check")) {
  const expected = createSkillMarkdown();
  let actual = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file falls through to the mismatch branch below
  }
  if (actual !== expected) {
    console.error("skills/lavish/SKILL.md is out of date. Run `node scripts/build-skill.js` and commit the result.");
    process.exit(1);
  }
  console.log("skills/lavish/SKILL.md is up to date.");
} else if (process.argv.includes("--local")) {
  // The same source rendered with absolute `node <repo>/dist/cli.mjs` invocations, so this
  // checkout can be symlinked in as ~/.claude/skills/lavish (a Claude Code skill is a directory
  // named after the skill) instead of hand-adapted into a copy that goes stale on every merge.
  // The path comes from this script's own location, so no absolute path is ever committed, and it
  // lands under the gitignored dist/ because it is machine-specific build output. Node realpaths
  // that location, so shortestEquivalentPath trades it for any shorter path proven to be the same
  // directory - the emitted invocation repeats throughout a file every session loads.
  const repoRoot = shortestEquivalentPath(fileURLToPath(new URL("..", import.meta.url)));
  const localTarget = new URL("../dist/skill-local/SKILL.md", import.meta.url);

  await mkdir(new URL("../dist/skill-local/", import.meta.url), { recursive: true });
  await writeFile(localTarget, createSkillMarkdown({ invocation: localInvocation(repoRoot) }));
  console.log(`Wrote ${fileURLToPath(localTarget)}`);
} else {
  await mkdir(new URL("../skills/lavish/", import.meta.url), { recursive: true });
  await writeFile(target, createSkillMarkdown());
  console.log(`Wrote ${fileURLToPath(target)}`);
}
