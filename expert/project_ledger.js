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

function blockSpan(src, i) {
  if (src[i] === "{") {
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
      }
    }
    return { text: src.slice(start), end: src.length };
  }
  const semi = src.indexOf(";", i);
  const end = semi === -1 ? src.length : semi + 1;
  return { text: src.slice(i, end), end };
}

// A branch digest turns "read the whole file" into "read a few lines":
// each conditional in process_cl with the enqueue count of each side.
function branchDigest(body) {
  if (!body) return [];
  const re = /\bif\s*\(/g;
  const digest = [];
  let match;
  while ((match = re.exec(body))) {
    let i = match.index + match[0].length - 1;
    let depth = 0;
    const condStart = i + 1;
    for (; i < body.length; i++) {
      if (body[i] === "(") depth += 1;
      else if (body[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const condition = body.slice(condStart, i).replace(/\s+/g, " ").trim().slice(0, 160);
    i += 1;
    while (i < body.length && /\s/.test(body[i])) i += 1;
    const thenBlock = blockSpan(body, i);
    i = thenBlock.end;
    let j = i;
    while (j < body.length && /\s/.test(body[j])) j += 1;
    let elseEnqueues = null;
    if (body.slice(j, j + 4) === "else") {
      j += 4;
      while (j < body.length && /\s/.test(body[j])) j += 1;
      const elseBlock = blockSpan(body, j);
      elseEnqueues = countMatches(elseBlock.text, /dt_opencl_enqueue/g);
      i = elseBlock.end;
    }
    digest.push({
      condition,
      then_enqueues: countMatches(thenBlock.text, /dt_opencl_enqueue/g),
      else_enqueues: elseEnqueues,
    });
    re.lastIndex = i;
  }
  return digest;
}

function classifyFile(filePath) {
  const src = stripComments(fs.readFileSync(filePath, "utf8"));
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
    scan.branch_digest = branchDigest(processBody);
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
  const names = ["rgb", "extra_kernel", "halo", "lookup_wide", "lut_entries", "arith_ops", "pixels", "mb_moved", "arith_px", "arith_px_sq", "halo_px", "halo_px_px"];
  const subsets = [[]];
  for (const name of names) {
    const extra = subsets.map((subset) => [...subset, name]);
    subsets.push(...extra);
  }
  return subsets;
}

function rowVector(row, features) {
  const values = {
    rgb: row.rgb,
    extra_kernel: row.extra,
    halo: row.halo,
    lookup_wide: row.lookup_wide,
    lut_entries: row.lut_entries,
    arith_ops: row.arith_ops,
    pixels: row.pixels || 0,
    mb_moved: row.mb_moved || 0,
    arith_px: (row.arith_ops || 0) * (row.pixels || 0),
    arith_px_sq: (row.arith_ops || 0) * (row.arith_ops || 0) * (row.pixels || 0),
    halo_px: row.halo_px || 0,
    halo_px_px: (row.halo_px || 0) * (row.pixels || 0),
  };
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
  if (metric.halo !== undefined) {
    // A record's halo certifies a neighborhood width declared either at the
    // wall level (entry.halo) or inside the kernel (entry.halo_px).
    const width = metric.halo || 0;
    if (width !== (entry.halo || 0) && width !== (entry.halo_px || 0)) return false;
  }
  return true;
}

function loadMetric(entry) {
  if (!entry.record || !entry.metric_id) return null;
  const doc = JSON.parse(fs.readFileSync(path.resolve(entry.record), "utf8"));
  const metric = doc.metrics.find((item) => item.id === entry.metric_id);
  if (!metric) throw new Error(`${entry.id} has no metric ${entry.metric_id}`);
  return metric;
}

// A record measured under a different source sha than the catalog's current
// sha is stale: it stays on disk and stays queryable, but it no longer
// certifies the current source. Records without a catalog_sha stamp predate
// stamping and are treated as current.
function staleRecordOf(entry, catalogSha) {
  if (!catalogSha || !entry.record) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.resolve(entry.record), "utf8"));
    if (doc.catalog_sha && doc.catalog_sha !== catalogSha) {
      return { id: entry.id, record: entry.record, record_sha: doc.catalog_sha, catalog_sha: catalogSha };
    }
  } catch {
    return null;
  }
  return null;
}

function staleRecordsOf(checked, catalogSha) {
  return checked.map((entry) => staleRecordOf(entry, catalogSha)).filter(Boolean);
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
    lookup_wide: entry.lookup_wide ? 1 : 0,
    lut_entries: entry.lut_entries || 0,
    arith_ops: entry.arith_ops || 0,
    pixels: entry.width && entry.height ? (entry.width * entry.height) / 1e6 : 0,
    mb_moved: entry.mb_moved || 0,
    halo_px: entry.halo_px || 0,
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

function loadCheckedCatalog(catalogPath) {
  const abs = path.resolve(catalogPath);
  const catalog = JSON.parse(fs.readFileSync(abs, "utf8"));
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
  return { catalog, catalogPath: abs, scanned, checked };
}

function trainRowsOf(checked) {
  return checked
    .filter((entry) => entry.role === "train")
    .map((entry) => {
      const metric = loadMetric(entry);
      if (!metric || metric.status !== "accepted") throw new Error(`${entry.id} train metric is not accepted`);
      if (!featuresMatch(metric, entry)) throw new Error(`${entry.id} record features differ from the catalog`);
      return toRow(entry, metric);
    });
}

function testRowsOf(testEntries) {
  return testEntries.map((entry) => {
    const metric = loadMetric(entry);
    if (metric && metric.status === "accepted" && !featuresMatch(metric, entry)) {
      throw new Error(`${entry.id} record features differ from the catalog`);
    }
    const row = toRow(entry, metric && metric.status === "accepted" ? metric : null);
    if (metric && metric.status !== "accepted") row.status = metric.status;
    return row;
  });
}

function fitMinimumFormula(trainRows, deps) {
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
  const tied = admissible.filter((item) => item.columns === chosen.columns);
  return { formulaSearch, chosen, minimum, minimumFit, tied };
}

// When several minimal formulas fit the training pool, an alphabetical
// pick hides that the data cannot tell them apart. Ambiguity is when the
// tied formulas disagree on a claimed prediction by more than 30% of the
// midpoint. The fix is a train module where the tied columns differ.
function modelAmbiguity(tied, rows) {
  const tiedFeatures = tied.map((item) => item.features);
  if (tied.length < 2 || !rows.length) {
    return { ambiguous: false, rows: [], tied_formulas: tiedFeatures, confounded_columns: [] };
  }
  const bad = [];
  for (const row of rows) {
    const preds = tied.map((item) => predictMs(row, item.features, item.coefficients));
    const max = Math.max(...preds);
    const min = Math.min(...preds);
    const scale = Math.max(Math.abs((max + min) / 2), 1e-9);
    if ((max - min) / scale > 0.3) bad.push(row.id);
  }
  const union = new Set(tiedFeatures.flat());
  const confounded = [...union].filter((name) => !tiedFeatures.every((features) => features.includes(name))).sort();
  return { ambiguous: bad.length > 0, rows: bad, tied_formulas: tiedFeatures, confounded_columns: confounded };
}

function claimedRowsOf(checked) {
  return checked.filter((entry) => entry.role === "claimed").map((entry) => toRow(entry, null));
}

function cellKeyOf(entry) {
  return [entry.colorspace, `k${entry.kernels}`, `h${entry.halo || 0}`, `lw${entry.lookup_wide ? 1 : 0}`].join("|");
}

function costSignature(entry) {
  return `${entry.width || "?"}x${entry.height || "?"}`;
}

function claimAccounting(scanned, checked) {
  const classifiable = scanned.modules.filter((item) => item.decision === "module_wall" || item.decision === "needs_branch");
  const unclassifiable = scanned.modules.filter((item) => item.decision === "refuse");
  const claimedIds = new Set(
    checked
      .filter((entry) => entry.role === "train" || entry.role === "test" || entry.role === "claimed")
      .map((entry) => entry.id)
  );
  const uncovered = classifiable
    .filter((item) => !claimedIds.has(item.id))
    .map((item) => ({
      id: item.id,
      scan_decision: item.decision,
      reason: item.decision === "needs_branch" ? "branch_not_resolved" : "not_in_catalog",
    }));
  return {
    classifiable: classifiable.length,
    unclassifiable: unclassifiable.length,
    claimed: claimedIds.size,
    coverage: classifiable.length ? claimedIds.size / classifiable.length : 0,
    uncovered,
  };
}

function cellBuckets(checked) {
  const cells = new Map();
  for (const entry of checked) {
    if (entry.role !== "train" && entry.role !== "test" && entry.role !== "claimed") continue;
    const key = cellKeyOf(entry);
    if (!cells.has(key)) cells.set(key, { train: [], test: [], claimed: [] });
    cells.get(key)[entry.role].push(entry);
  }
  return [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function cmdMinLedger(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  const { catalog, catalogPath, scanned, checked } = loadCheckedCatalog(opts.catalog);
  const testEntries = checked.filter((entry) => entry.role === "test");
  const refusedEntries = checked.filter((entry) => entry.role === "refuse");
  const staleRecords = staleRecordsOf(checked, catalog.sha);
  const staleIds = new Set(staleRecords.map((item) => item.id));
  const trainRows = trainRowsOf(checked.filter((entry) => !staleIds.has(entry.id)));
  const testRows = testRowsOf(testEntries);

  const { formulaSearch, chosen, minimum, minimumFit, tied } = fitMinimumFormula(trainRows, deps);
  const ambiguity = modelAmbiguity(tied, [...testRows, ...claimedRowsOf(checked)]);
  const smaller = combinations(trainRows, chosen.columns - 1).map((subset) => {
    const fit = fitRows(subset, chosen.features, deps.solveLinear);
    return {
      ids: subset.map((row) => row.id),
      usable: !fit.singular,
      reason: fit.singular ? fit.reason || "singular" : "full rank",
    };
  });
  const names = ["base_ms", ...chosen.features.map((name) => `${name}_ms`)];
  // The report uses least squares over the whole accepted training pool —
  // the same coefficients the admissibility gate checked. The minimum basis
  // stays in the output as proof of the measurement floor.
  const coefficientMap = Object.fromEntries(names.map((name, index) => [name, chosen.coefficients[index]]));
  const test = testRows.map((row) => {
    const report = predictMs(row, chosen.features, chosen.coefficients);
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
    catalog_sha: catalog.sha ?? null,
    stale_records: staleRecords,
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
    training: scored(trainRows, chosen.features, chosen.coefficients),
    basis_fit: scored(
      trainRows.filter((row) => minimum.ids.includes(row.id)),
      chosen.features,
      minimumFit.coefficients
    ),
    test,
    measured_test_n: measuredTest.length,
    measured_test_passed_85: measuredTest.filter((item) => item.passes_85).length,
    measured_test_all_pass_85: measuredTest.length > 0 && measuredTest.every((item) => item.passes_85),
    tied_formulas: ambiguity.tied_formulas,
    model_ambiguous: ambiguity.ambiguous,
    ambiguous_rows: ambiguity.rows,
    confounded_columns: ambiguity.confounded_columns,
    refused: refusedEntries.map((entry) => ({ id: entry.id, reason: entry.scan_reason })),
    priceable_not_in_catalog: pricedByScan.map((item) => item.id),
  };
  const db = deps.openDb();
  body.audit_id = deps.audit(db, "min_ledger", null, body);
  console.log(JSON.stringify(body, null, 2));
}

// freeze-tests judges the test set before any fitting. It refuses to
// freeze a claim that is narrow, shallow, or covers too little of the
// repository. A frozen catalog is the exam; score grades against it.

function freezeTests(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  const minCoverage = opts["min-coverage"] === undefined ? 0.8 : Number(opts["min-coverage"]);
  const minDepth = opts["min-depth"] === undefined ? 2 : Number(opts["min-depth"]);
  if (!(minCoverage > 0 && minCoverage <= 1)) throw new Error("min-coverage must be in (0, 1]");
  if (!(Number.isInteger(minDepth) && minDepth >= 1)) throw new Error("min-depth must be an integer >= 1");
  const { catalog, catalogPath, scanned, checked } = loadCheckedCatalog(opts.catalog);
  if (catalog.freeze && !(opts.refreeze === true || opts.refreeze === "true")) {
    throw new Error(`catalog already frozen at ${catalog.freeze.stamp}; pass --refreeze true to replace it`);
  }
  const account = claimAccounting(scanned, checked);
  const testEntries = checked.filter((entry) => entry.role === "test");
  const cells = cellBuckets(checked).map(([cell, bucket]) => {
    // Undeclared size ("?") cannot prove depth: it collapses into one
    // bucket that never counts as a distinct cost signature.
    const signatures = new Map();
    const undeclared = [];
    for (const entry of bucket.test) {
      const sig = costSignature(entry);
      if (sig === "?x?") {
        undeclared.push(entry.id);
        continue;
      }
      if (!signatures.has(sig)) signatures.set(sig, []);
      signatures.get(sig).push(entry.id);
    }
    return {
      cell,
      train: bucket.train.map((entry) => entry.id).sort(),
      test: bucket.test.map((entry) => entry.id).sort(),
      claimed: bucket.claimed.map((entry) => entry.id).sort(),
      distinct_cost_signatures: signatures.size,
      undeclared_signature: undeclared.sort(),
      signatures: [...signatures.entries()].map(([signature, ids]) => ({ signature, ids: ids.sort() })),
    };
  });
  const breadth = cells
    .filter((item) => item.test.length === 0)
    .map((item) => ({
      cell: item.cell,
      train: item.train,
      claimed: item.claimed,
      gap: "no_test_for_claimed_shape",
      fix: "add a test module of this shape; measured tests never move into train",
    }));
  const depth = cells
    .filter((item) => item.test.length > 0 && item.distinct_cost_signatures < minDepth)
    .map((item) => ({
      cell: item.cell,
      test: item.test,
      distinct_cost_signatures: item.distinct_cost_signatures,
      undeclared_signature: item.undeclared_signature,
      need: minDepth,
      gap: "depth_insufficient",
      fix: "add a test of this shape that differs in size, repetition, or intensity",
    }));
  const gaps = {
    coverage:
      account.coverage < minCoverage
        ? {
            coverage: account.coverage,
            need: minCoverage,
            uncovered_n: account.uncovered.length,
            need_additional_claimed: Math.ceil(minCoverage * account.classifiable) - account.claimed,
            fix: "resolve needs_branch modules into the claim or add missing module_wall modules to the catalog",
          }
        : null,
    breadth,
    depth,
  };
  const ok = !gaps.coverage && breadth.length === 0 && depth.length === 0;
  const body = {
    catalog: catalogPath.replace(/\\/g, "/"),
    catalog_sha: catalog.sha ?? null,
    ok,
    frozen: false,
    min_coverage: minCoverage,
    min_depth: minDepth,
    classifiable: account.classifiable,
    unclassifiable: account.unclassifiable,
    claimed: account.claimed,
    coverage: account.coverage,
    uncovered: account.uncovered,
    test_n: testEntries.length,
    cells,
    gaps,
  };
  if (ok) {
    const previous = catalog.freeze ? catalog.freeze.stamp : null;
    catalog.freeze = {
      stamp: new Date().toISOString(),
      min_coverage: minCoverage,
      min_depth: minDepth,
      classifiable: account.classifiable,
      claimed: account.claimed,
      coverage: account.coverage,
      test_ids: testEntries.map((entry) => entry.id).sort(),
    };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    body.frozen = true;
    body.previous_freeze = previous;
    body.freeze = catalog.freeze;
  }
  const db = deps.openDb();
  body.audit_id = deps.audit(db, "freeze_tests", null, body);
  return body;
}

function cmdFreezeTests(opts, deps) {
  console.log(JSON.stringify(freezeTests(opts, deps), null, 2));
}

// score grades the frozen test set. Every claimed test must be measured
// and accurate; an unmeasured claimed test is a failure, not a skip.

function cmdScore(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  const { catalog, catalogPath, scanned, checked } = loadCheckedCatalog(opts.catalog);
  const failures = [];
  const freeze = catalog.freeze || null;
  if (!freeze) {
    failures.push({ reason: "catalog_not_frozen", fix: "run freeze-tests; the frozen test set is the exam" });
  }
  const account = claimAccounting(scanned, checked);
  const staleRecords = staleRecordsOf(checked, catalog.sha);
  const staleIds = new Set(staleRecords.map((item) => item.id));
  const minCoverage = freeze ? freeze.min_coverage : 0.8;
  if (account.coverage < minCoverage) {
    failures.push({
      reason: "coverage_below_min",
      coverage: account.coverage,
      need: minCoverage,
      uncovered_n: account.uncovered.length,
    });
  }
  let fit = null;
  try {
    fit = fitMinimumFormula(trainRowsOf(checked.filter((entry) => !staleIds.has(entry.id))), deps);
  } catch (error) {
    failures.push({ reason: "train_fit_failed", detail: error.message });
  }
  let testEntries = checked.filter((entry) => entry.role === "test");
  let postFreezeTests = [];
  if (freeze) {
    const frozenIds = new Set(freeze.test_ids);
    const missing = freeze.test_ids.filter(
      (id) => !testEntries.some((entry) => entry.id === id)
    );
    if (missing.length) failures.push({ reason: "frozen_test_missing_from_catalog", ids: missing });
    postFreezeTests = testEntries.filter((entry) => !frozenIds.has(entry.id)).map((entry) => entry.id);
    testEntries = testEntries.filter((entry) => frozenIds.has(entry.id));
  }
  const names = fit ? ["base_ms", ...fit.chosen.features.map((name) => `${name}_ms`)] : null;
  const coefficients = fit
    ? Object.fromEntries(names.map((name, index) => [name, fit.chosen.coefficients[index]]))
    : null;
  const testRows = testRowsOf(testEntries);
  const tests = testRows.map((row) => {
    const report = fit ? predictMs(row, fit.chosen.features, fit.chosen.coefficients) : null;
    if (staleIds.has(row.id)) {
      return {
        id: row.id,
        status: "stale",
        record: row.record,
        report_ms: report,
        measured_ms: row.ms,
        accuracy: null,
        passes_85: false,
        fail: "stale_record",
      };
    }
    if (row.status !== "accepted") {
      return {
        id: row.id,
        status: row.status,
        report_ms: report,
        measured_ms: null,
        accuracy: null,
        passes_85: false,
        fail: "unmeasured_claimed_test",
      };
    }
    const accuracy = 1 - Math.abs(row.ms - report) / row.ms;
    return {
      id: row.id,
      status: "accepted",
      record: row.record,
      report_ms: report,
      measured_ms: row.ms,
      accuracy,
      passes_85: accuracy >= 0.85,
      fail: accuracy >= 0.85 ? null : "accuracy_below_85",
    };
  });
  if (fit) {
    const ambiguity = modelAmbiguity(fit.tied, [...testRows, ...claimedRowsOf(checked)]);
    if (ambiguity.ambiguous) {
      failures.push({
        reason: "model_ambiguous",
        rows: ambiguity.rows,
        tied_formulas: ambiguity.tied_formulas,
        confounded_columns: ambiguity.confounded_columns,
        fix: "add a train module where the confounded columns differ; the training pool cannot separate them",
      });
    }
  }
  const unmeasured = tests.filter((item) => item.fail === "unmeasured_claimed_test");
  if (unmeasured.length) {
    failures.push({ reason: "unmeasured_claimed_test", ids: unmeasured.map((item) => item.id) });
  }
  const inaccurate = tests.filter((item) => item.fail === "accuracy_below_85");
  if (inaccurate.length) {
    failures.push({ reason: "accuracy_below_85", ids: inaccurate.map((item) => item.id) });
  }
  if (!tests.length) failures.push({ reason: "no_tests" });
  const staleTests = tests.filter((item) => item.fail === "stale_record");
  if (staleTests.length) {
    failures.push({
      reason: "stale_record",
      ids: staleTests.map((item) => item.id),
      fix: "re-measure under the current catalog sha; stale records stay on disk and queryable",
    });
  }
  const body = {
    catalog: catalogPath.replace(/\\/g, "/"),
    catalog_sha: catalog.sha ?? null,
    verdict: failures.length === 0 ? "pass" : "fail",
    frozen: Boolean(freeze),
    freeze_stamp: freeze ? freeze.stamp : null,
    post_freeze_tests: postFreezeTests,
    stale_records: staleRecords,
    line: "accuracy = 1 - |measured_ms - report_ms| / measured_ms, pass >= 0.85 per claimed test",
    formula: fit ? `base_ms${fit.chosen.features.map((name) => ` + ${name}_ms * ${name}`).join("")}` : null,
    coefficients,
    coverage: account.coverage,
    classifiable: account.classifiable,
    claimed: account.claimed,
    uncovered: account.uncovered,
    test_n: tests.length,
    measured_n: tests.filter((item) => item.status === "accepted").length,
    tests,
    failures,
  };
  const db = deps.openDb();
  body.audit_id = deps.audit(db, "score", null, body);
  console.log(JSON.stringify(body, null, 2));
}

function kernelSlice(src, name) {
  const re = new RegExp(`(?:__kernel\\s+void|kernel\\s+void)\\s+${name}\\s*\\(`);
  const match = re.exec(src);
  if (!match) return null;
  const brace = src.indexOf("{", match.index);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(match.index, i + 1);
    }
  }
  return null;
}

const ARITH_RE =
  /\b(?:pow|powf|exp|exp2|exp10|log|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh)\s*\(/g;

function lutEntries(text) {
  let max = 0;
  for (const match of text.matchAll(/\[(\d+)\]/g)) max = Math.max(max, Number(match[1]));
  for (const match of text.matchAll(/#define\s+\w+\s+(\d+)/g)) max = Math.max(max, Number(match[1]));
  return max;
}

function arithOps(text) {
  return (text.match(ARITH_RE) || []).length;
}

// Largest constant pixel offset in image reads, e.g. (int2)(x + 2, y - 1).
// Variable radii stay 0 here; they are declared in the catalog instead.
function haloPx(text) {
  let max = 0;
  for (const m of text.matchAll(/\(int2\)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    for (const off of m[1].matchAll(/\b[xy]\s*[+-]\s*(\d+)/g)) max = Math.max(max, Number(off[1]));
  }
  return max;
}

// Quantitative features from the module's own kernel: table size in
// entries, transcendental call count, constant neighbor radius.
function kernelFeaturesFor(kernelDir, id) {
  const files = fs.readdirSync(kernelDir).filter((name) => name.endsWith(".cl"));
  for (const file of files) {
    const src = stripComments(fs.readFileSync(path.join(kernelDir, file), "utf8"));
    const slice = kernelSlice(src, id) || kernelSlice(src, `kernel_${id}`);
    if (!slice) continue;
    const kernels = src.match(/(?:__kernel\s+void|kernel\s+void)\s+\w+\s*\(/g) || [];
    const unit = kernels.length === 1 ? src : slice;
    const entries = lutEntries(unit);
    return {
      lookup_wide: entries >= 64 ? 1 : 0,
      lut_entries: entries,
      arith_ops: arithOps(unit),
      halo_px: haloPx(unit),
      kernel_file: file,
    };
  }
  return { lookup_wide: 0, lut_entries: 0, arith_ops: 0, halo_px: 0, kernel_file: null };
}

function lookupWideFor(kernelDir, id) {
  const found = kernelFeaturesFor(kernelDir, id);
  return { lookup_wide: found.lookup_wide, kernel_file: found.kernel_file };
}

function cmdAnnotateFeatures(opts) {
  if (!opts.catalog) throw new Error("missing --catalog");
  if (!opts.kernels) throw new Error("missing --kernels");
  const catalog = JSON.parse(fs.readFileSync(path.resolve(opts.catalog), "utf8"));
  const annotated = [];
  for (const entry of catalog.modules) {
    if (entry.role === "refuse") continue;
    const found = kernelFeaturesFor(path.resolve(opts.kernels), entry.id);
    entry.lookup_wide = found.lookup_wide;
    entry.lut_entries = found.lut_entries;
    entry.arith_ops = found.arith_ops;
    entry.halo_px = found.halo_px;
    annotated.push({ id: entry.id, ...found });
  }
  fs.writeFileSync(path.resolve(opts.catalog), JSON.stringify(catalog, null, 2));
  console.log(JSON.stringify({ catalog: path.resolve(opts.catalog).replace(/\\/g, "/"), modules: annotated }, null, 2));
}

// The graduation exam: predict a feature vector you have never measured,
// seal the prediction in the audit trail, and only then check it against
// a record. A sealed prediction can never be edited after the fact.

function featuresToRow(features, id) {
  const colorspace = features.colorspace;
  if (colorspace !== "lab" && colorspace !== "rgb") throw new Error("features.colorspace must be lab or rgb");
  const kernels = Number(features.kernels ?? 1);
  if (!(Number.isInteger(kernels) && kernels >= 1)) throw new Error("features.kernels must be an integer >= 1");
  return {
    id: id || features.id || "exam_item",
    colorspace,
    kernels,
    halo: Number(features.halo || 0),
    rgb: colorspace === "rgb" ? 1 : 0,
    extra: kernels - 1,
    lookup_wide: features.lookup_wide ? 1 : 0,
    lut_entries: Number(features.lut_entries || 0),
    arith_ops: Number(features.arith_ops || 0),
    pixels: Number(features.pixels || 0) || (((Number(features.width) || 0) * (Number(features.height) || 0)) / 1e6),
    mb_moved: Number(features.mb_moved || 0),
    halo_px: Number(features.halo_px || 0),
    ms: null,
    status: "exam",
  };
}

function loadFeatures(opts) {
  if (!opts.features) throw new Error("missing --features (JSON string or @file)");
  const raw = opts.features.startsWith("@")
    ? fs.readFileSync(path.resolve(opts.features.slice(1)), "utf8")
    : opts.features;
  return JSON.parse(raw);
}

function cmdExamPredict(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  const { catalog, checked } = loadCheckedCatalog(opts.catalog);
  const staleRecords = staleRecordsOf(checked, catalog.sha);
  const staleIds = new Set(staleRecords.map((item) => item.id));
  const trainRows = trainRowsOf(checked.filter((entry) => !staleIds.has(entry.id)));
  const fit = fitMinimumFormula(trainRows, deps);
  const row = featuresToRow(loadFeatures(opts), opts.item);
  const db = deps.openDb();
  const ambiguity = modelAmbiguity(fit.tied, [row]);
  if (ambiguity.ambiguous) {
    const refused = {
      sealed: false,
      reason: "model_ambiguous",
      catalog: path.resolve(opts.catalog).replace(/\\/g, "/"),
      catalog_sha: catalog.sha ?? null,
      item: row.id,
      confounded_columns: ambiguity.confounded_columns,
      tied_formulas: ambiguity.tied_formulas,
      fix: "add a train module where the confounded columns differ before pricing this item",
    };
    refused.audit_id = deps.audit(db, "exam_predict", null, refused);
    console.log(JSON.stringify(refused, null, 2));
    return;
  }
  const names = ["base_ms", ...fit.chosen.features.map((name) => `${name}_ms`)];
  const coefficients = Object.fromEntries(names.map((name, index) => [name, fit.chosen.coefficients[index]]));
  // A coefficient fit over a narrow range is a local correction, not a
  // physical rate. Sealing outside the trained range is allowed, but the
  // seal records which feature values are extrapolations.
  const examVector = rowVector(row, fit.chosen.features);
  const outOfRange = fit.chosen.features
    .map((name, index) => {
      const seen = trainRows.map((train) => rowVector(train, fit.chosen.features)[index + 1]);
      const min = Math.min(...seen);
      const max = Math.max(...seen);
      const value = examVector[index + 1];
      return value < min || value > max ? { feature: name, value, trained_min: min, trained_max: max } : null;
    })
    .filter(Boolean);
  const body = {
    sealed: true,
    catalog: path.resolve(opts.catalog).replace(/\\/g, "/"),
    catalog_sha: catalog.sha ?? null,
    stale_records: staleRecords,
    item: row.id,
    features: {
      colorspace: row.colorspace,
      kernels: row.kernels,
      halo: row.halo,
      lookup_wide: row.lookup_wide,
      lut_entries: row.lut_entries,
      arith_ops: row.arith_ops,
      pixels: row.pixels,
      mb_moved: row.mb_moved,
    },
    formula: `base_ms${fit.chosen.features.map((name) => ` + ${name}_ms * ${name}`).join("")}`,
    coefficients,
    report_ms: predictMs(row, fit.chosen.features, fit.chosen.coefficients),
    sealed_at: new Date().toISOString(),
    seal_note: "prediction sealed in the audit trail before any measurement is attached",
    range_note: outOfRange.length
      ? { warning: "prediction extrapolates beyond the trained range; treat as a guess", out_of_range: outOfRange }
      : null,
  };
  const examId = deps.audit(db, "exam_predict", null, body);
  body.exam_id = examId;
  console.log(JSON.stringify(body, null, 2));
}

function cmdExamScore(opts, deps) {
  if (!opts.exam) throw new Error("missing --exam");
  if (!opts.record) throw new Error("missing --record");
  if (!opts.metric) throw new Error("missing --metric");
  const db = deps.openDb();
  const sealed = db.prepare("SELECT id, action, detail FROM audit WHERE id = ?").get(Number(opts.exam));
  if (!sealed || sealed.action !== "exam_predict") throw new Error(`no sealed exam prediction ${opts.exam}`);
  const prediction = JSON.parse(sealed.detail);
  if (!prediction.sealed || !Number.isFinite(prediction.report_ms)) {
    throw new Error("sealed exam has no report_ms (refused seals cannot be scored)");
  }
  const doc = JSON.parse(fs.readFileSync(path.resolve(opts.record), "utf8"));
  const metric = doc.metrics.find((item) => item.id === opts.metric);
  if (!metric) throw new Error(`no metric ${opts.metric} in ${opts.record}`);
  if (metric.status !== "accepted") throw new Error(`metric ${opts.metric} is ${metric.status}, not accepted`);
  const measured = metric.median;
  const accuracy = 1 - Math.abs(measured - prediction.report_ms) / measured;
  const body = {
    exam_id: sealed.id,
    catalog: prediction.catalog ?? null,
    catalog_sha: prediction.catalog_sha ?? null,
    item: prediction.item,
    sealed_at: prediction.sealed_at,
    formula: prediction.formula,
    report_ms: prediction.report_ms,
    measured_ms: measured,
    record: path.resolve(opts.record).replace(/\\/g, "/"),
    metric: metric.id,
    accuracy,
    passes_85: accuracy >= 0.85,
    verdict: accuracy >= 0.85 ? "pass" : "fail",
  };
  body.audit_id = deps.audit(db, "exam_score", null, body);
  console.log(JSON.stringify(body, null, 2));
}

// bump-sha moves the catalog's source fingerprint forward. It is an explicit
// event: records stamped with the old sha become stale (computed at read
// time, never deleted), and the audit log keeps both shas.
function cmdBumpSha(opts, deps) {
  if (!opts.catalog) throw new Error("missing --catalog");
  if (!opts.sha) throw new Error("missing --sha");
  const catalogPath = path.resolve(opts.catalog);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  let sha = String(opts.sha);
  if (sha === "auto") {
    if (!catalog.iop_src) throw new Error("catalog has no iop_src for --sha auto");
    const { spawnSync } = require("child_process");
    const ran = spawnSync("git", ["-C", catalog.iop_src, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (ran.status !== 0) throw new Error(`git rev-parse failed in ${catalog.iop_src}: ${(ran.stderr || "").trim()}`);
    sha = ran.stdout.trim();
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("sha must be a hex string (7-40 chars) or auto");
  const previous = catalog.sha ?? null;
  catalog.sha = sha;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  const staleAfter = staleRecordsOf(catalog.modules || [], sha);
  const body = {
    catalog: catalogPath.replace(/\\/g, "/"),
    previous_sha: previous,
    sha,
    stale_after_bump: staleAfter,
    note: "stale records stay on disk and stay queryable; re-measure under the new sha to refresh them",
  };
  const db = deps.openDb();
  body.audit_id = deps.audit(db, "bump_sha", null, body);
  console.log(JSON.stringify(body, null, 2));
}

module.exports = {
  cmdScanIop,
  cmdMinLedger,
  cmdAnnotateFeatures,
  cmdFreezeTests,
  cmdScore,
  cmdExamPredict,
  cmdExamScore,
  cmdBumpSha,
  scanIop,
  classifyFile,
  lookupWideFor,
  kernelFeaturesFor,
};
