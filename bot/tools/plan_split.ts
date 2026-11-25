import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Choose the training modules and the held-out modules from source features, before any module is measured. Writes a catalog. Does not write records or prices. needs_branch modules stay out of both sets until a branch is counted.",
  inputSchema: z.object({
    src: z.string().min(1),
    out: z.string().min(1).describe("Catalog path relative to perf-ledger, for example catalog/new-project.json"),
  }),
  effect: "write",
  dryRunResult: ({ out }) => ({ ok: false, skipped: true, reason: "dry-run", out }),
  async execute({ src, out }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", out };
    return runLedger(["plan-split", "--src", src, "--out", out]);
  },
});
