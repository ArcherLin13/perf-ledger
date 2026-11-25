import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Propose the first catalog from source features: minimal training modules, a sampled exam (two test entries per shape cell at different planned sizes), and claimed modules that join the claim from classification alone and need no measurement. Prints the exam budget in measure-module runs and a branch digest for each needs_branch module. Does not write records or prices.",
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
