import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function validReviewAttempt(id) {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
}

export function reviewAttemptPath(stateFile, id) {
  if (!validReviewAttempt(id)) throw new Error("Invalid review attempt ID");
  return path.join(path.dirname(stateFile), "review-attempts", `${id}.json`);
}

export function readReviewAttempt(stateFile, id) {
  try {
    return JSON.parse(readFileSync(reviewAttemptPath(stateFile, id), "utf8"));
  } catch {
    return null;
  }
}

export function updateReviewAttempt(stateFile, id, fields) {
  const file = reviewAttemptPath(stateFile, id);
  const prior = readReviewAttempt(stateFile, id);
  const record = { ...prior, ...fields };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return record;
}
