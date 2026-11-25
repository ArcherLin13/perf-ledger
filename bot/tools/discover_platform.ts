import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "See which backends this machine can probe: cpu, opencl, ascend_npu, ascend_aiv, and any probes/extra backend. A missing SDK is not a price.",
  inputSchema: z.object({}),
  effect: "read",
  async execute() {
    return runLedger(["discover"]);
  },
});
