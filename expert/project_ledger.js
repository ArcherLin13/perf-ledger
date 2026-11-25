// Scan a pixel-module tree and choose the smallest training ledger
// whose formula still fits the training pool. Held-out modules are
// predicted from that fit. Modules the scanner refuses get no milliseconds.

const fs = require("fs");
const path = require("path");

function extractFunction(src, name) {
  const re = new RegExp(`(?:^|\\n)[^\\n]*\\b${name}\\s*\\(`, "g");
  let match;
  while ((match = re.exec(src))) {
    const brace = src.indexOf("{", match.index);
    if (brace < 0) return null;
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(brace + 1, i);
      }
    }
  }
  return null;
}

function countMatches(text, re) {
  if (!text) return 0;
  return (text.match(re) || []).length;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function loopsContainingEnqueue(body) {
  if (!body) return 0;
  const src = stripComments(body);
  const re = /\b(?:for|while)\s*\(/g;
  let count = 0;
  let match;
  while ((match = re.exec(src))) {
    let i = match.index + match[0].length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== "{") {
      const semi = src.indexOf(";", i);
      const stmt = src.slice(i, semi === -1 ? src.length : semi);
      if (stmt.includes("dt_opencl_enqueue")) count += 1;
      continue;
    }
    let braceDepth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") braceDepth += 1;
      else if (src[i] === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          if (src.slice(start, i).includes("dt_opencl_enqueue")) count += 1;
          break;
        }
      }
    }
    re.lastIndex = i;
  }
  return count;
}

function classifyFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const id = path.basename(filePath, ".c");
  const colorsBody = extractFunction(src, "default_colorspace");
  const processBody = extractFunction(src, "process_cl");
  const colors = colorsBody ? colorsBody.match(/return\s+IOP_CS_([A-Z]+)/g) || [] : [];
  const colorNames = colors.map((item) => item.replace("return IOP_CS_", "").replace("return  IOP_CS_", ""));
  const uniqueColors = [...new Set(colorNames)];
  const enqueues = countMatches(processBody, /dt_opencl_enqueue_kernel_2d/g);
  const hostImage = countMatches(processBody, /dt_opencl_copy_host_to_image/g);
  const hostConstant = countMatches(processBody, /dt_opencl_copy_host_to_device_constant/g);
  const imageCopy = countMatches(processBody, /dt_opencl_enqueue_copy_image/g);
  const loops = loopsContainingEnqueue(processBody);
  const ifs = countMatches(processBody, /\bif\s*\(/g);
  const scan = {
    id,
    file: filePath.replace(/\\/g, "/"),
    colorspace: uniqueColors.length === 1 ? uniqueColors[0].toLowerCase() : null,
    enqueues,
    host_image_copies: hostImage,
    host_constant_copies: hostConstant,
    image_copies: imageCopy,
    loops,
    ifs,
  };
  if (!processBody) {
    scan.decision = "refuse";
    scan.reason = "no_process_cl";
  } else if (uniqueColors.length !== 1 || (uniqueColors[0] !== "LAB" && uniqueColors[0] !== "RGB")) {
    scan.decision = "refuse";
    scan.reason = "colorspace_not_a_single_lab_or_rgb";
  } else if (hostImage > 0) {
    scan.decision = "refuse";
    scan.reason = "host_image_copy";
  } else if (loops > 0) {
    scan.decision = "refuse";
    scan.reason = "loop_in_process_cl";
  } else if (enqueues < 1) {
    scan.decision = "refuse";
    scan.reason = "no_kernel";
  } else if (ifs > 0 && (imageCopy > 0 || enqueues > 1)) {
    scan.decision = "needs_branch";
    scan.reason = "conditional_path";
    scan.kernels = null;
    scan.halo = null;
  } else {
    scan.decision = "module_wall";
    scan.reason = hostConstant > 0 ? "fixed_launches_plus_small_constant" : "fixed_launches";
    scan.kernels = enqueues;
    scan.halo = 0;
  }
  return scan;
}

function scanIop(srcDir) {
  const abs = path.resolve(srcDir);
  const files = fs
    .readdirSync(abs)
    .filter((name) => name.endsWith(".c"))
    .map((name) => path.join(abs, name));
  const modules = files.map(classifyFile).sort((a, b) => a.id.localeCompare(b.id));
  const byDecision = {};
  const byReason = {};
  for (const item of modules) {
    byDecision[item.decision] = (byDecision[item.decision] || 0) + 1;
    byReason[item.reason] = (byReason[item.reason] || 0) + 1;
  }
  return { src: abs.replace(/\\/g, "/"), files: modules.length, by_decision: byDecision, by_reason: byReason, modules };
}

function cmdScanIop(opts) {
  if (!opts.src) throw new Error("missing --src");
  console.log(JSON.stringify(scanIop(opts.src), null, 2));
}

function combinations(items, k) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function featureSubsets() {
  const names = ["rgb", "extra_kernel", "halo"];
  const subsets = [[]];
  for (const name of names) {
    const extra = subsets.map((subset) => [...subset, name]);
    subsets.push(...extra);
  }
  return subsets;
}

function rowVector(row, features) {
  const values = { rgb: row.rgb, extra_kernel: row.extra, halo: row.halo };
  return [1, ...features.map((name) => values[name])];
}

function fitRows(rows, features, solveLinear) {
  const width = features.length + 1;
  if (rows.length < width) return { singular: true, reason: "fewer points than columns" };
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  for (const row of rows) {
    const x = rowVector(row, features);
    for (let i = 0; i < width; i++) {
      rhs[i] += x[i] * row.ms;
      for (let j = 0; j < width; j++) gram[i][j] += x[i] * x[j];
    }
  }
  try {
    const solved = solveLinear(gram, rhs);
    return { singular: false, coefficients: solved };
  } catch (error) {
    return { singular: true, reason: error.message };
  }
}

function predictMs(row, features, coefficients) {
  const x = rowVector(row, features);
  return x.reduce((sum, value, index) => sum + value * coefficients[index], 0);
}

function scored(rows, features, coefficients) {
  return rows.map((row) => {
    const report = predictMs(row, features, coefficients);
    const accuracy = 1 - Math.abs(row.ms - report) / row.ms;
    return {
      id: row.id,
      measured_ms: row.ms,
      report_ms: report,
      accuracy,
      passes_85: accuracy >= 0.85,
    };
  });
}

function featuresMatch(metric, entry) {
  if (metric.colorspace !== undefined && metric.colorspace !== entry.colorspace) return false;
  if (metric.kernels !== undefined && metric.kernels !== entry.kernels) return false;
  if (metric.halo !== undefined && (metric.halo || 0) !== entry.halo) return false;
  return true;
}

function loadMetric(entry) {
  if (!entry.record || !entry.metric_id) return null;
  const doc = JSON.parse(fs.readFileSync(path.resolve(entry.record), "utf8"));
  const metric = doc.metrics.find((item) => item.id === entry.metric_id);
  if (!metric) throw new Error(`${entry.id} has no metric ${entry.metric_id}`);
  return metric;
}

function toRow(entry, metric) {
  return {
    id: entry.id,
    metric_id: entry.metric_id,
    colorspace: entry.colorspace,
    kernels: entry.kernels,
    halo: entry.halo,
    rgb: entry.colorspace === "rgb" ? 1 : 0,
    extra: entry.kernels - 1,
    ms: metric ? metric.median : null,
    status: metric ? metric.status : "unmeasured",
    record: entry.record || null,
  };
}

function catalogAgrees(scan, entry) {
  if (!scan) return { ok: false, why: "source file was not scanned" };
  if (entry.role === "refuse") {
    return { ok: scan.decision === "refuse", why: scan.decision === "refuse" ? scan.reason : `scanner says ${scan.decision}` };
  }
  if (scan.colorspace !== entry.colorspace) return { ok: false, why: `scanner colorspace ${scan.colorspace}` };
  if (scan.decision === "refuse") return { ok: false, why: scan.reason };
  if (scan.decision === "module_wall") {
    const ok = scan.kernels === entry.kernels && entry.halo === 0;
    return { ok, why: ok ? scan.reason : `scanner kernels ${scan.kernels} halo 0` };
  }
  if (scan.decision === "needs_branch") {
    const ok = entry.branch_resolved === true && Number.isFinite(entry.kernels) && entry.kernels >= 1;
    return { ok, why: ok ? "branch_resolved" : "conditional path needs branch_resolved and a kernel count from source" };
  }
  return { ok: false, why: scan.decision };
}

function cmdMinLedger(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  const catalog = JSON.parse(fs.readFileSync(path.resolve(opts.catalog), "utf8"));
  const scanned = scanIop(catalog.iop_src);
  const byId = new Map(scanned.modules.map((item) => [item.id, item]));
  const checked = catalog.modules.map((entry) => {
    const scan = byId.get(entry.id);
    const agreement = catalogAgrees(scan, entry);
    return { ...entry, scan_decision: scan ? scan.decision : null, scan_reason: scan ? scan.reason : null, agreement };
  });
  const mismatches = checked.filter((entry) => !entry.agreement.ok);
  if (mismatches.length) {
    throw new Error(
      `catalog does not match source scan: ${mismatches
        .map((entry) => `${entry.id} (${entry.agreement.why})`)
        .join("; ")}`
    );
  }
  const trainEntries = checked.filter((entry) => entry.role === "train");
  const testEntries = checked.filter((entry) => entry.role === "test");
  const refusedEntries = checked.filter((entry) => entry.role === "refuse");
  const trainRows = trainEntries.map((entry) => {
    const metric = loadMetric(entry);
    if (!metric || metric.status !== "accepted") throw new Error(`${entry.id} train metric is not accepted`);
    if (!featuresMatch(metric, entry)) throw new Error(`${entry.id} record features differ from the catalog`);
    return toRow(entry, metric);
  });
  const testRows = testEntries.map((entry) => {
    const metric = loadMetric(entry);
    if (metric && metric.status === "accepted" && !featuresMatch(metric, entry)) {
      throw new Error(`${entry.id} record features differ from the catalog`);
    }
    const row = toRow(entry, metric && metric.status === "accepted" ? metric : null);
    if (metric && metric.status !== "accepted") row.status = metric.status;
    return row;
  });

  const formulaSearch = featureSubsets().map((features) => {
    const fit = fitRows(trainRows, features, deps.solveLinear);
    if (fit.singular) {
      return { features, columns: features.length + 1, singular: true, reason: fit.reason || "singular", passes_train_85: false };
    }
    const training = scored(trainRows, features, fit.coefficients);
    return {
      features,
      columns: features.length + 1,
      singular: false,
      coefficients: fit.coefficients,
      passes_train_85: training.every((item) => item.passes_85),
      training,
    };
  });
  const admissible = formulaSearch.filter((item) => item.passes_train_85);
  if (!admissible.length) throw new Error("no formula fits the training pool at 0.85");
  admissible.sort((a, b) => a.columns - b.columns || a.features.join(",").localeCompare(b.features.join(",")));
  const chosen = admissible[0];
  const smaller = combinations(trainRows, chosen.columns - 1).map((subset) => {
    const fit = fitRows(subset, chosen.features, deps.solveLinear);
    return {
      ids: subset.map((row) => row.id),
      usable: !fit.singular,
      reason: fit.singular ? fit.reason || "singular" : "full rank",
    };
  });
  const basis = combinations(trainRows, chosen.columns).map((subset) => {
    const fit = fitRows(subset, chosen.features, deps.solveLinear);
    if (fit.singular) return { ids: subset.map((row) => row.id), usable: false };
    const held = trainRows.filter((row) => !subset.includes(row));
    const heldScores = scored(held, chosen.features, fit.coefficients);
    return {
      ids: subset.map((row) => row.id),
      usable: heldScores.every((item) => item.passes_85),
      held_in_train: heldScores,
    };
  });
  const usableBasis = basis.filter((item) => item.usable);
  if (!usableBasis.length) throw new Error("chosen formula has no full-rank training basis");
  const minimum = usableBasis.slice().sort((a, b) => a.ids.join(",").localeCompare(b.ids.join(",")))[0];
  const minimumFit = fitRows(
    trainRows.filter((row) => minimum.ids.includes(row.id)),
    chosen.features,
    deps.solveLinear
  );
  const names = ["base_ms", ...chosen.features.map((name) => `${name}_ms`)];
  const coefficientMap = Object.fromEntries(names.map((name, index) => [name, minimumFit.coefficients[index]]));
  const test = testRows.map((row) => {
    const report = predictMs(row, chosen.features, minimumFit.coefficients);
    if (row.status !== "accepted") {
      return {
        id: row.id,
        status: row.status,
        colorspace: row.colorspace,
        kernels: row.kernels,
        halo: row.halo,
        report_ms: report,
        measured_ms: null,
        accuracy: null,
        passes_85: null,
      };
    }
    const accuracy = 1 - Math.abs(row.ms - report) / row.ms;
    return {
      id: row.id,
      status: "accepted",
      colorspace: row.colorspace,
      kernels: row.kernels,
      halo: row.halo,
      record: row.record,
      report_ms: report,
      measured_ms: row.ms,
      accuracy,
      passes_85: accuracy >= 0.85,
    };
  });
  const measuredTest = test.filter((item) => item.status === "accepted");
  const catalogIds = new Set(catalog.modules.map((entry) => entry.id));
  const pricedByScan = scanned.modules.filter((item) => item.decision === "module_wall" && !catalogIds.has(item.id));
  const body = {
    catalog: path.resolve(opts.catalog).replace(/\\/g, "/"),
    scanned_files: scanned.files,
    scan_by_decision: scanned.by_decision,
    scan_by_reason: scanned.by_reason,
    formula: `base_ms${chosen.features.map((name) => ` + ${name}_ms * ${name}`).join("")}`,
    minimum_measurements: chosen.columns,
    minimum_set: minimum.ids,
    dropping_one_measurement_is_usable: smaller.some((item) => item.usable),
    smaller_sets: smaller,
    coefficients: coefficientMap,
    formula_search: formulaSearch.map((item) => ({
      features: item.features,
      columns: item.columns,
      singular: item.singular,
      passes_train_85: item.passes_train_85,
    })),
    training: scored(
      trainRows.filter((row) => minimum.ids.includes(row.id)),
      chosen.features,
      minimumFit.coefficients
    ),
    test,
    measured_test_n: measuredTest.length,
    measured_test_passed_85: measuredTest.filter((item) => item.passes_85).length,
    measured_test_all_pass_85: measuredTest.length > 0 && measuredTest.every((item) => item.passes_85),
    refused: refusedEntries.map((entry) => ({ id: entry.id, reason: entry.scan_reason })),
    priceable_not_in_catalog: pricedByScan.map((item) => item.id),
  };
  const db = deps.openDb();
  body.audit_id = deps.audit(db, "min_ledger", null, body);
  console.log(JSON.stringify(body, null, 2));
}

module.exports = { cmdScanIop, cmdMinLedger, scanIop, classifyFile };
