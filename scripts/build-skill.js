// Generates skills/lavish/SKILL.md from the shared no-args home output so the
// installable skill never drifts from what `lavish-axi` (and the SessionStart hook) print.
// Also generates its companion skills/check-lavish/SKILL.md, the pickup path an agent uses after
// the bounded poll handoff. Both are emitted in every mode so one can never go stale alone.
//
//   node scripts/build-skill.js          # write the file
//   node scripts/build-skill.js --check  # fail (exit 1) if the committed file is stale
//   node scripts/build-skill.js --local  # write the gitignored dist/skill-local/SKILL.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createCheckSkillMarkdown,
  createSkillMarkdown,
  localInvocation,
  shortestEquivalentPath,
} from "../src/skill.js";

// [dir, committed SKILL.md, renderer] per generated skill.
const SKILLS = [
  ["lavish", new URL("../skills/lavish/SKILL.md", import.meta.url), createSkillMarkdown],
  ["check-lavish", new URL("../skills/check-lavish/SKILL.md", import.meta.url), createCheckSkillMarkdown],
];

if (process.argv.includes("--check")) {
  for (const [name, target, render] of SKILLS) {
    const expected = render();
    let actual = null;
    try {
      actual = await readFile(target, "utf8");
    } catch {
      // missing file falls through to the mismatch branch below
    }
    if (actual !== expected) {
      console.error(
        `skills/${name}/SKILL.md is out of date. Run \`node scripts/build-skill.js\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`skills/${name}/SKILL.md is up to date.`);
  }
} else if (process.argv.includes("--local")) {
  // The same source rendered with absolute `node <repo>/dist/cli.mjs` invocations, so this
  // checkout can be symlinked in as ~/.claude/skills/lavish (a Claude Code skill is a directory
  // named after the skill) instead of hand-adapted into a copy that goes stale on every merge.
  // The path comes from this script's own location, so no absolute path is ever committed, and it
  // lands under the gitignored dist/ because it is machine-specific build output. Node realpaths
  // that location, so shortestEquivalentPath trades it for any shorter path proven to be the same
  // directory - the emitted invocation repeats throughout a file every session loads.
  const repoRoot = shortestEquivalentPath(fileURLToPath(new URL("..", import.meta.url)));
  const invocation = localInvocation(repoRoot);

  // One directory per skill so both can be symlinked into ~/.claude/skills independently. The
  // lavish flavor keeps its historical dist/skill-local/ path because an existing symlink points
  // at it; siblings get their own top-level directory rather than nesting inside that one, which
  // would put a second skill inside the directory ~/.claude/skills/lavish resolves to.
  for (const [name, , render] of SKILLS) {
    const dir = new URL(name === "lavish" ? "../dist/skill-local/" : `../dist/skill-local-${name}/`, import.meta.url);
    const localTarget = new URL("SKILL.md", dir);
    await mkdir(dir, { recursive: true });
    await writeFile(localTarget, render({ invocation }));
    console.log(`Wrote ${fileURLToPath(localTarget)}`);
  }
} else {
  for (const [name, target, render] of SKILLS) {
    await mkdir(new URL(`../skills/${name}/`, import.meta.url), { recursive: true });
    await writeFile(target, render());
    console.log(`Wrote ${fileURLToPath(target)}`);
  }
}
