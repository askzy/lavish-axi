#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { guardFailureMessage, runReviewGuard } from "../src/review-guard-hook.js";

let result;
try {
  const input = readFileSync(0, "utf8");
  if (input.length > 1024 * 1024) throw new Error("Hook input exceeds its read limit");
  result = runReviewGuard(JSON.parse(input), process.argv[2]);
} catch (error) {
  result = guardFailureMessage(error);
}
if (Object.keys(result).length) process.stdout.write(JSON.stringify(result) + "\n");
