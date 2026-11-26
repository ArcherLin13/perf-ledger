import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Compile and run one bandwidth probe. Writes a new record. Does not write prices. A blocked result has no rate. Backends: cpu, opencl, ascend_npu, ascend_aiv, or an extra id.",
  inputSchema: z.object({
    backend: z.string().min(1),
    force: z.boolean().optional(),
  }),
  effect: "write",
  dryRunResult: ({ backend }) => ({ ok: false, skipped: true, reason: "dry-run", backend }),
  async execute({ backend, force }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", backend };
    const args = ["run-probe", "--backend", backend];
    if (force) args.push("--force", "true");
    return runLedger(args);
  },
});
