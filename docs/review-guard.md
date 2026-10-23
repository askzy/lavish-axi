# Personal review Stop guard

The guard continues an agent that tries to finish while its own Lavish review command is still starting or waiting. It also catches a successful legacy open with no first poll. Claude can hand back with the exact native tracked background task whose completion returns to the same parent.

This is a local source-checkout integration. It is opt-in and does not change settings when built. `lavish-axi setup hooks` remains disabled.

## Install after validation

Keep existing hooks. Merge these entries into personal settings, replacing `/absolute/lavish-axi` with this checkout's real path. For Claude, use `claude` as the final command argument and personal `~/.claude/settings.json`. For Codex, use `codex` and `~/.codex/hooks.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /absolute/lavish-axi/bin/lavish-review-guard.js codex", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /absolute/lavish-axi/bin/lavish-review-guard.js codex", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/lavish-axi/bin/lavish-review-guard.js codex", "timeout": 5 }
        ]
      }
    ]
  }
}
```

Start a new harness session. Codex requires the user to review and trust the exact new hook definition through `/hooks`. Do not bypass trust in a live installation. Remove only these entries to roll back.

The parent opens and listens. Children build or edit the artifact and return its path. If a child already opened the artifact, the parent polls that artifact without reopening it; taking a still-held listener requires explicit `--takeover`.

## Scope and limits

- The observer accepts direct native Bash calls to `node <this-checkout>/dist/cli.mjs <artifact>` and `poll <artifact>`, plus direct `lavish-axi` commands. It handles quoted paths and path aliases. Shell wrappers, environment prefixes, `npx`, pipelines, and JavaScript source text are outside this adapter's coverage. The combined open command still starts listening for those callers.
- `--view-only` and zero-timeout drains create no listening obligation. Native task IDs, session IDs, and the canonical transcript path bind observed commands. Working directories and process IDs never establish ownership.
- Runtime attempts carry the native harness identity. Claude's `CLAUDE_CODE_SESSION_ID` takes priority over an inherited `CODEX_THREAD_ID`. The hook reads only its session's attempt index. The index retains all active attempts and the latest 64 historical attempts.
- Codex's exact registered native command must finish before normal hand-back. Native `CommandExecution` completion retires the corresponding tool and inner process. Outer cell completion can still contain a running inner shell handle. A finished review is not blocked by another command's running handle.
- Claude hand-back requires an exact join between `PostToolUse.backgroundTaskId` and `Stop.background_tasks`, including the command, shell type, and running status. A detached process or a listener alone does not qualify.
- The guard allows handoff after the exact native command ends, including socket loss, browser disconnect, end, replacement, or error. Runtime attempt outcomes supply context and never clear an unfinished parent command. A new Codex turn does not inherit an interrupted prior turn's listening obligation. Feedback and leases remain available through `check-lavish`.
- Two corrections are allowed for each observed command. Unknown identity, a child transcript, corrupt state, or a read limit permits handoff with a diagnostic. The hook does not retry or restart a poll. It cannot keep an exited harness alive.

The hook reads at most a 16 MiB Codex transcript, 256 native command records of 64 KiB each, a 64 KiB session index, and 256 indexed attempts of 16 KiB each. Missing attempt indexes permit native-command checks, including legacy opens. Corrupt indexes fail open with a diagnostic. Observers write separate files per native call, so concurrent tools cannot overwrite each other. Completed calls are removed after Stop. Guard state lives under `LAVISH_AXI_STATE_DIR/review-guard` or `~/.lavish-axi/review-guard` and is separate from the feedback queue.

## Validation evidence

Captured fixtures cover installed Codex 0.162.1 and Claude Code 2.1.309. The actual Stop snapshots include an early final with an outer running cell, then an outer completed wait whose inner shell still runs. The full-wait capture includes native command completion. Claude's task notification woke the same parent model after hand-back.

`node --test test/review-guard.test.js` checks those captures plus session separation, startup before attempt creation, TOON legacy output, interrupted handoff, and bounded corrections. Constructed attempt state in those unit tests is separate from installed-client acceptance tests. Revalidate the real hook flow after harness upgrades because transcript formats can change.
