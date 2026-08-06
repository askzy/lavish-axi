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
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NPX_INVOCATION, createSkillMarkdown, localInvocation, shortestEquivalentPath } from "../src/skill.js";

// Derived from this file's own location, then shortened exactly the way the build script does.
const DERIVED_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_INVOCATION = localInvocation(shortestEquivalentPath(DERIVED_ROOT));

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

test("the emitted path names this checkout, however it was shortened", () => {
  // The equivalence is the whole guarantee - asserting a literal path would put a machine path back
  // into the repo, which is the mistake this work exists to undo.
  const emitted = LOCAL_INVOCATION.slice("node ".length);
  const emittedRoot = path.dirname(path.dirname(emitted));

  assert.ok(path.isAbsolute(emitted), "the emitted invocation is not an absolute path");
  assert.equal(path.basename(emitted), "cli.mjs");
  assert.equal(realpathSync(emittedRoot), realpathSync(DERIVED_ROOT), "the emitted path is not this checkout");
  assert.ok(emittedRoot.length <= realpathSync(DERIVED_ROOT).length, "shortening made the path longer");
});

test("shortestEquivalentPath takes a shorter verified path and nothing else", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-skill-local-"));
  const root = path.join(dir, "a-checkout-with-a-deliberately-long-name");
  const link = path.join(dir, "s");
  const sibling = path.join(dir, "elsewhere");
  await mkdir(root);
  await mkdir(sibling);
  await symlink(root, link);

  try {
    assert.equal(shortestEquivalentPath(root, [link]), link, "a shorter verified path was not taken");
    assert.equal(shortestEquivalentPath(root, [`${link}/`]), link, "candidates are not normalised");

    // Everything unverifiable falls back to the realpath, even when it is shorter: a sibling
    // directory, a path that does not exist, a relative path, and no candidate at all.
    const fallback = realpathSync(root);
    assert.ok(sibling.length < fallback.length, "the sibling must be short enough to be tempting");
    assert.equal(shortestEquivalentPath(root, [sibling]), fallback, "an unrelated directory was accepted");
    assert.equal(shortestEquivalentPath(root, [path.join(dir, "x")]), fallback, "a missing path was accepted");
    assert.equal(shortestEquivalentPath(root, ["s"]), fallback, "a relative path was accepted");
    assert.equal(shortestEquivalentPath(root, [undefined]), fallback);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
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
