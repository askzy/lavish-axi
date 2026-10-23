import { createHash } from "node:crypto";
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
  if (record.harness) {
    try {
      const indexFile = reviewSessionIndexPath(stateFile, record.harness);
      let index = { v: 1, active: [], recent: [] };
      try {
        index = JSON.parse(readFileSync(indexFile, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const active = index.active.filter((item) => item !== id);
      if (!record.finishedAt) active.push(id);
      const recent = [...index.recent.filter((item) => item !== id), id].slice(-64);
      mkdirSync(path.dirname(indexFile), { recursive: true });
      writeFileSync(`${indexFile}.tmp`, JSON.stringify({ v: 1, active, recent }) + "\n", { mode: 0o600 });
      renameSync(`${indexFile}.tmp`, indexFile);
    } catch {
      process.stderr.write(
        "[lavish-axi] Review guard session index could not be updated. Review delivery continues.\n",
      );
    }
  }
  return record;
}

export function reviewSessionIndexPath(stateFile, harness) {
  const key = createHash("sha256")
    .update(JSON.stringify([harness.name, harness.sessionId]))
    .digest("hex");
  return path.join(path.dirname(stateFile), "review-attempts", "by-session", `${key}.json`);
}
