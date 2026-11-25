# perf-ledger (opencode)

The agent, its skills, and its tools live under `.opencode/`. The runtime
under them is plain Node: `expert/cli.js` is the single entry point for every
measurement, fit, and verdict.

## Layout

- `.opencode/agents/perf-ledger.md` — the primary agent. Its body is the
  campaign loop. Permissions: skills and reads allowed, shell asks, edits
  denied (the ledger CLI writes files itself).
- `.opencode/plugins/perf-ledger.js` — one plugin, namespace `ledger`, 15
  tools. Each tool spawns `node expert/cli.js <args>` with the project root
  as cwd and returns the CLI's JSON stdout as `content`.
- `.opencode/skills/campaign/SKILL.md` — the goal, the coverage bar, the
  0.85 line, the exam protocol.
- `.opencode/skills/ledger-rules/SKILL.md` — when to refuse, what may be
  quoted, the minimum-ledger rules.
- `expert/cli.js`, `expert/project_ledger.js`, `expert/view.js` — the
  runtime. CommonJS, Node 18+. No build step.
- `probes/`, `fixtures/`, `catalog/`, `records/`, `examples/` — measurement
  code and data. These are runtime-agnostic and identical to the `main`
  branch.

## Loop

- `opencode` in this directory starts a session with the `perf-ledger`
  agent (set as `default_agent` in `opencode.jsonc`).
- The agent must call `ledger_*` tools for every number. It must not
  recompute milliseconds, prices, or accuracy.
- Direct CLI access stays available for development:
  `node expert/cli.js <command>` from the project root. Commands are listed
  by running it with no arguments.

## Invariants

1. A tool's JSON output is the only quotable number.
2. `freeze_tests` before fitting; a measured test never moves into the
   training pool.
3. `exam_predict` seals before measurement; a failed seal is an honest
   verdict, not a bug.
4. Records with `status != accepted` never enter a conclusion.
5. The plugin resolves the project root from `ctx.location.project` and
   falls back to its own path; every CLI call must run with the project
   root as cwd, because catalog and record paths are root-relative.

## Verifying changes

- `node expert/cli.js` with no arguments lists the commands — the CLI is
  self-checking.
- `node --check .opencode/plugins/perf-ledger.js` parses the plugin.
- `git diff main --stat` should show changes confined to `.opencode/`,
  `AGENTS.md`, `README.md`, and the removed Agent SDK files (`bot/`,
  `evals/`, `package.json`, `tsconfig.json`).
