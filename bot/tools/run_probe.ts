import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Compile and run one bandwidth probe. Writes a new record. Does not write prices. A blocked result has no rate. Backends: cpu, opencl, ascend_npu, ascend_aiv, or an extra id.",
  inputSchema: z.object({
    backend: z.string().min(1),
  }),
  effect: "write",
  dryRunResult: ({ backend }) => ({ ok: false, skipped: true, reason: "dry-run", backend }),
  async execute({ backend }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", backend };
    return runLedger(["run-probe", "--backend", backend]);
  },
});
