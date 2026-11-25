import { Plugin } from "@opencode/plugin";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Project root: this file lives in <root>/.opencode/plugins/.
const FALLBACK_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const BACKENDS = ["cpu", "opencl", "ascend_npu", "ascend_aiv"];

const TEMPLATE_SHAPES = ["base", "launch", "arith", "halo", "lut", "colorspace", "resize", "f32", "f32_arith"];

function str(description) {
  return { type: "string", description };
}
function int(description) {
  return { type: "integer", description };
}
function enumOf(values, description) {
  return { type: "string", enum: values, description };
}

function runCli(root, args, context) {
  const result = spawnSync(process.execPath, ["expert/cli.js", ...args], {
    cwd: root,
    encoding: "utf8",
    signal: context?.signal,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `expert cli failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return (result.stdout || "").trim();
}

export default Plugin.define({
  id: "perf-ledger",
  async setup(ctx) {
    const root =
      ctx.location?.project?.canonical ||
      ctx.location?.project?.directory ||
      FALLBACK_ROOT;

    const ledgerTool = ({ name, description, input, args }) => ({
      name,
      description,
      input: { type: "object", properties: input, additionalProperties: false },
      execute: async (values, context) => ({
        content: runCli(root, args(values || {}), context),
      }),
    });

    const catalogProp = str("Catalog JSON path, relative to the project root. Example: catalog/dt.json");

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "ledger",
        description:
          "Performance ledger: shapes, platform prices, frozen exams, and sealed predictions. All numbers come from these tools; never recompute.",
      });

      editor.add(
        ledgerTool({
          name: "discover_platform",
          description: "List probe backends available on this machine.",
          input: {},
          args: () => ["discover"],
        }),
        ledgerTool({
          name: "run_probe",
          description: "Compile and run the price probe for one backend. Writes records into records/.",
          input: {
            backend: enumOf(BACKENDS, "Probe backend to run."),
          },
          args: (v) => ["run-probe", "--backend", v.backend],
        }),
        ledgerTool({
          name: "commit_prices",
          description: "Commit a probe record as platform prices for one platform id.",
          input: {
            record: str("Record JSON path written by ledger_run_probe."),
            platform: str("Platform id, for example pc_iris_xe_mingw."),
          },
          args: (v) => ["commit-prices", "--record", v.record, "--platform", v.platform],
        }),
        ledgerTool({
          name: "plan_split",
          description:
            "Split a repository into modules and classify each into a cost shape, or report it unclassifiable.",
          input: {
            src: str("Repository source directory, relative to the project root."),
            out: str("Output JSON path, for example catalog/<name>.json."),
          },
          args: (v) => ["plan-split", "--src", v.src, "--out", v.out],
        }),
        ledgerTool({
          name: "scan_iop",
          description:
            "Re-read a repository and update a catalog's classifiable/unclassifiable counts.",
          input: {
            src: str("Repository source directory, relative to the project root."),
          },
          args: (v) => ["scan-iop", "--src", v.src],
        }),
        ledgerTool({
          name: "annotate_features",
          description:
            "Extract lut_entries, arith_ops and halo_px from kernel sources and write them into the catalog.",
          input: {
            catalog: catalogProp,
            kernels: str("Directory that contains the module kernel sources."),
          },
          args: (v) => ["annotate-features", "--catalog", v.catalog, "--kernels", v.kernels],
        }),
        ledgerTool({
          name: "freeze_tests",
          description:
            "Freeze the catalog's frozen test set. Requires breadth (every claimed shape cell), depth (two distinct cost signatures per cell), and coverage >= 0.8.",
          input: {
            catalog: catalogProp,
            refreeze: {
              type: "boolean",
              description: "Set true only when intentionally re-freezing an already frozen catalog.",
            },
          },
          args: (v) =>
            v.refreeze
              ? ["freeze-tests", "--catalog", v.catalog, "--refreeze", "true"]
              : ["freeze-tests", "--catalog", v.catalog],
        }),
        ledgerTool({
          name: "score",
          description:
            "Fit the catalog model and score the frozen test set. Verdict fails below 0.85 per-test accuracy.",
          input: { catalog: catalogProp },
          args: (v) => ["score", "--catalog", v.catalog],
        }),
        ledgerTool({
          name: "measure_module",
          description:
            "Compile and measure one catalog module on this platform and store the record.",
          input: {
            module: str("Module id from the catalog, for example temperature."),
            kernels: str("Kernel source directory (default fixtures/tiny/kernels)."),
            width: int("Image width in pixels."),
            height: int("Image height in pixels."),
          },
          args: (v) =>
            [
              "measure-module",
              "--module",
              v.module,
              v.kernels ? ["--kernels", v.kernels] : [],
              v.width !== undefined ? ["--width", String(v.width)] : [],
              v.height !== undefined ? ["--height", String(v.height)] : [],
            ].flat(),
        }),
        ledgerTool({
          name: "run_template",
          description: "Run one template probe shape n times and store the measurement.",
          input: {
            shape: enumOf(TEMPLATE_SHAPES, "Template shape to run."),
            n: int("Repetition count, for example 20."),
            width: int("Image width in pixels."),
            height: int("Image height in pixels."),
          },
          args: (v) =>
            [
              "run-template",
              "--shape",
              v.shape,
              "--n",
              String(v.n),
              v.width !== undefined ? ["--width", String(v.width)] : [],
              v.height !== undefined ? ["--height", String(v.height)] : [],
            ].flat(),
        }),
        ledgerTool({
          name: "exam_predict",
          description:
            "Seal a graduation-exam prediction for an unseen feature in the audit log, before any measurement.",
          input: {
            catalog: catalogProp,
            item: str("Exam item id, for example arith_75."),
            features: str(
              'Feature vector as JSON, for example {"mb_moved_ms":0,"arith_px_sq":1.5}. Unknown feature ids are rejected.'
            ),
          },
          args: (v) => ["exam-predict", "--catalog", v.catalog, "--item", v.item, "--features", v.features],
        }),
        ledgerTool({
          name: "exam_score",
          description:
            "Compare a sealed exam prediction with an accepted measurement record and write the verdict.",
          input: {
            catalog: catalogProp,
            exam: int("Exam id printed by ledger_exam_predict."),
            record: str("Measurement record JSON path for the sealed item."),
            metric: str("Metric id in the record (default kernel_wall)."),
          },
          args: (v) =>
            [
              "exam-score",
              "--catalog",
              v.catalog,
              "--exam",
              String(v.exam),
              "--record",
              v.record,
              v.metric ? ["--metric", v.metric] : [],
            ].flat(),
        }),
        ledgerTool({
          name: "min_ledger",
          description:
            "Show the minimal measurement basis and the full-pool fit for a frozen catalog: which tests each shape needs, and the formula report.",
          input: { catalog: catalogProp },
          args: (v) => ["min-ledger", "--catalog", v.catalog],
        }),
        ledgerTool({
          name: "estimate_cost",
          description:
            "Estimate a module's wall time from committed module_wall prices. Refuses when prices are missing.",
          input: {
            colorspace: enumOf(["lab", "rgb"], "Working colorspace of the module."),
            kernels: int("Number of kernels in the module."),
            halo: int("Halo radius in pixels (default 0)."),
            platform: str("Platform id (default: the platform from the last ledger_init)."),
          },
          args: (v) =>
            [
              "estimate-wall",
              "--colorspace",
              v.colorspace,
              "--kernels",
              String(v.kernels),
              "--halo",
              String(v.halo ?? 0),
              v.platform ? ["--platform", v.platform] : [],
            ].flat(),
        }),
        ledgerTool({
          name: "anchor_check",
          description:
            "Check one sealed estimate against a measured value. Writes an anchor verdict into the audit log.",
          input: {
            estimate: int("Estimate id printed by ledger_estimate_cost."),
            measured_ms: { type: "number", description: "Measured wall time in milliseconds." },
            record: str("Measurement record JSON path that produced the value."),
          },
          args: (v) =>
            [
              "anchor",
              "--estimate",
              String(v.estimate),
              "--measured-ms",
              String(v.measured_ms),
              v.record ? ["--record", v.record] : [],
            ].flat(),
        })
      );
    });
  },
});
