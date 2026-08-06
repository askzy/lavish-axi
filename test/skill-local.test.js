// Guards for the checkout-local flavor of the lavish skill.
//
// `~/.claude/skills/lavish` is a symlink at the generated `dist/skill-local/`, so this file is
// what an agent session actually loads. If it ever tells the agent to run `npx -y lavish-axi`,
// npm fetches upstream's published package instead of this checkout: sharing re-enabled, none of
// the fork's guards, none of its fixes - and nothing about the session looks wrong. That silent
// substitution is what the first two tests exist to catch.
//
// This lives in its own file for the same reason as test/fork-customizations.test.js: upstream
// owns test/skill.test.js, so a file-level "take upstream" resolution there would delete the guard
// and restore the npx invocation in one move.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NPX_INVOCATION, createSkillMarkdown, localInvocation } from "../src/skill.js";

const LOCAL_INVOCATION = localInvocation(fileURLToPath(new URL("..", import.meta.url)));

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test("local flavor never routes an agent through the npm package", () => {
  const local = createSkillMarkdown({ invocation: LOCAL_INVOCATION });

  assert.ok(!local.includes(NPX_INVOCATION), "the local skill still tells agents to npx the upstream package");
  // Anything of the form `lavish-axi <arg>` resolves through PATH to whatever global install
  // exists, which is not this checkout either. The bare `` `lavish-axi` `` token in "a follow-up
  // command starting with `lavish-axi`" is naming the command, not invoking it, so it stays.
  assert.doesNotMatch(local, /`lavish-axi [^`]/, "the local skill invokes a PATH-resolved lavish-axi");
  assert.doesNotMatch(local, /Run `lavish-axi/);
});

test("local flavor invokes this checkout's built CLI everywhere the npx flavor invokes npx", () => {
  const local = createSkillMarkdown({ invocation: LOCAL_INVOCATION });
  const npx = createSkillMarkdown();

  assert.match(LOCAL_INVOCATION, /^node \/.*\/dist\/cli\.mjs$/, "the local invocation is an absolute node call");
  assert.ok(local.includes(`\`${LOCAL_INVOCATION} <html-file>\``), "the local skill opens sessions via this checkout");
  assert.equal(
    occurrences(local, LOCAL_INVOCATION),
    occurrences(npx, NPX_INVOCATION),
    "some invocation sites were not rewritten - a partially converted skill sends part of the work to upstream",
  );
});

test("local flavor carries the fork note", () => {
  const local = createSkillMarkdown({ invocation: LOCAL_INVOCATION });

  assert.match(local, /local fork \(askzy\/lavish-axi\)/);
  assert.match(local, /`share` and `setup hooks` subcommands disabled/);
  assert.match(local, /never `npx lavish-axi`, which would fetch the upstream package and bypass the fork/);
});

test("the published flavor keeps npx and no checkout path", () => {
  const npx = createSkillMarkdown();

  assert.match(npx, /`npx -y lavish-axi <html-file>`/);
  assert.doesNotMatch(npx, /dist\/cli\.mjs/, "an absolute checkout path leaked into the published skill");
  assert.doesNotMatch(npx, /local fork/);
  assert.notEqual(npx, createSkillMarkdown({ invocation: LOCAL_INVOCATION }), "the two flavors collapsed into one");
});

test("build emits the local flavor into gitignored dist, and never the committed one", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const buildSkill = await readFile(new URL("../scripts/build-skill.js", import.meta.url), "utf8");

  assert.match(packageJson.scripts.build, /node scripts\/build-skill\.js --local/, "run `npm run build` to refresh it");
  // Regenerating the committed skill during `build` would make `check`'s trailing freshness gate
  // vacuous, since `check` runs `build` first.
  assert.doesNotMatch(packageJson.scripts.build, /node scripts\/build-skill\.js(?! --local)/);
  assert.match(buildSkill, /dist\/skill-local\/SKILL\.md/);
  assert.match(gitignore, /^dist\/$/m, "the local flavor is machine-specific and must stay uncommitted");
});
