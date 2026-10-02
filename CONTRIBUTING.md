# Contributing

This is [askzy/lavish-axi](https://github.com/askzy/lavish-axi), a fork of [kunchenguid/lavish-axi](https://github.com/kunchenguid/lavish-axi). Changes here land in the fork; they are not sent upstream from this repo.
Upstream requires human-authored PRs to go through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes). That gate does not apply to the fork.

## Workflow

1. Clone the fork and install from source:

   ```sh
   git clone https://github.com/askzy/lavish-axi.git
   cd lavish-axi
   corepack pnpm install --frozen-lockfile
   npm run build
   ```

   Install with `corepack pnpm`, never `npm install`: `npm` ignores `pnpm-lock.yaml`, so the Prettier it resolves disagrees with the one CI pins. `dist/` is gitignored; the CLI is `node dist/cli.mjs` and exists only after `npm run build`.

2. Create a branch named `type/slug` (for example `fix/update-from-source`) and make your changes.
3. Run `pnpm run check` before pushing.
4. Push the branch to this repo and open a PR against `main`. Use Conventional Commits for commit messages.

## Syncing with upstream

The fork tracks upstream releases by replaying upstream commits onto `main`. The deliberate divergences are listed in AGENTS.md and guarded by `test/fork-customizations.test.js`; a sync that turns one of those guards red has silently restored upstream behaviour the fork removed, so fix the sync, not the test.

## Repo Conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Run `pnpm run check` before pushing.
- Do not reformat repo-provided `.agents/` skill content; `.prettierignore` excludes it intentionally.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- User-facing telemetry docs should stay minimal: anonymous usage telemetry, no sensitive content, and `LAVISH_AXI_TELEMETRY=0` opt-out.

## Questions

Open an issue on [askzy/lavish-axi](https://github.com/askzy/lavish-axi/issues). For upstream Lavish questions, use upstream's [Discord](https://discord.gg/Wsy2NpnZDu).
