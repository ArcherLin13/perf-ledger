import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

const inputSchema = z.object({
  kind: z.enum(["module_wall", "streaming"]),
  platform: z.string().min(1).optional(),
  colorspace: z.enum(["lab", "rgb"]).optional(),
  kernels: z.number().int().positive().optional(),
  halo: z.number().nonnegative().optional(),
  shape: z.enum(["sequential", "stencil", "pyramid", "reduction"]).optional(),
  access: z.enum(["streaming", "naive"]).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  bppIn: z.number().positive().optional(),
  bppOut: z.number().positive().optional(),
  readPasses: z.number().positive().optional(),
  writePasses: z.number().positive().optional(),
  radius: z.number().nonnegative().optional(),
  levels: z.number().int().positive().optional(),
});

export default defineTool({
  description:
    "Write one estimate. module_wall uses colorspace, kernel count, and halo on iris-xe-opencl. streaming uses width, height, bytes per pixel, and pass counts. Quote estimate_id, report, and report_ms. A refused result means no millisecond.",
  inputSchema,
  effect: "write",
  dryRunResult: (input) => ({ ok: false, skipped: true, reason: "dry-run", kind: input.kind }),
  async execute(input, ctx) {
    if (ctx.session.purpose === "eval") {
      return { ok: false, skipped: true, reason: "eval", kind: input.kind };
    }
    if (input.kind === "module_wall") {
      if (!input.colorspace || !input.kernels) {
        return { ok: false, error: "module_wall needs colorspace and kernels" };
      }
      const args = [
        "estimate-wall",
        "--platform",
        input.platform ?? "iris-xe-opencl",
        "--colorspace",
        input.colorspace,
        "--kernels",
        String(input.kernels),
        "--halo",
        String(input.halo ?? 0),
      ];
      if (input.width) args.push("--width", String(input.width));
      if (input.height) args.push("--height", String(input.height));
      return runLedger(args);
    }
    if (!input.shape || !input.width || !input.height || !input.bppIn || !input.bppOut) {
      return { ok: false, error: "streaming needs shape, width, height, bppIn, and bppOut" };
    }
    const args = [
      "estimate",
      "--platform",
      input.platform ?? "iris-xe-opencl",
      "--shape",
      input.shape,
      "--width",
      String(input.width),
      "--height",
      String(input.height),
      "--bpp-in",
      String(input.bppIn),
      "--bpp-out",
      String(input.bppOut),
    ];
    if (input.access) args.push("--access", input.access);
    if (input.readPasses) args.push("--read-passes", String(input.readPasses));
    if (input.writePasses) args.push("--write-passes", String(input.writePasses));
    if (input.radius !== undefined) args.push("--radius", String(input.radius));
    if (input.levels) args.push("--levels", String(input.levels));
    return runLedger(args);
  },
});
