// Discover a machine, run a bandwidth probe, and price only accepted medians.
// A missing device or SDK writes no rate and no price.

const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const probeDir = path.join(root, "probes");
const recordDir = path.join(root, "records", "hardware");

const BUILTINS = {
  cpu: { kind: "cpu", source: "cpu_seq.c" },
  opencl: { kind: "gpu", source: "opencl_seq.c" },
  ascend_npu: { kind: "npu", source: "ascend_npu.c" },
  ascend_aiv: { kind: "aiv", source: "ascend_aiv.c" },
};

const PRICE_MAP = {
  cpu: { read: "sequential_read_dram_GBps", write: "sequential_write_dram_GBps", copy: "sequential_copy_dram_GBps" },
  opencl: { read: "sequential_read_dram_GBps", write: "sequential_write_dram_GBps", copy: "sequential_copy_dram_GBps" },
  ascend_npu: { copy: "sequential_copy_dram_GBps" },
  ascend_aiv: { elementwise: "aiv_elementwise_GBps" },
};

function exists(file) {
  try {
    return Boolean(file) && fs.existsSync(file);
  } catch {
    return false;
  }
}

function walkFor(fileName, roots) {
  const queue = roots.filter(Boolean);
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir) || !exists(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
      if (entry.isDirectory() && seen.size < 400) queue.push(full);
    }
  }
  return null;
}

function commandPath(name) {
  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, [name], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const line = (found.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line || null;
}

function findGcc() {
  if (process.env.CC && exists(process.env.CC)) return process.env.CC;
  const onPath = commandPath("gcc");
  if (onPath) return onPath;
  const bundled = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WinGet",
    "Packages",
    "BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "mingw64",
    "bin",
    "gcc.exe"
  );
  return exists(bundled) ? bundled : null;
}

function ascendRoots() {
  return [
    process.env.ASCEND_HOME,
    process.env.ASCEND_TOOLKIT_HOME,
    process.env.ASCEND_ACL_HOME,
    "C:/Program Files/Huawei/Ascend",
    "/usr/local/Ascend",
  ];
}

function discoverBackends() {
  const cpu = os.cpus()[0] ? os.cpus()[0].model : "unknown";
  const gcc = findGcc();
  const openclLib = process.platform === "win32" ? "C:/Windows/System32/OpenCL.dll" : commandPath("libOpenCL.so");
  const headerRoots = [
    process.env.OPENCL_HEADERS,
    path.join(root, "third_party", "OpenCL-Headers"),
    "D:/WorkStation/PerfRepo/upstream/OpenCL-Headers",
    "/usr/include",
  ];
  const clHeader = walkFor("cl.h", headerRoots.map((item) => (item && item.endsWith("CL") ? path.dirname(item) : item)));
  const aclHeader = walkFor("acl.h", ascendRoots());
  const aivHeader = walkFor("aclnn_add.h", ascendRoots());
  const backends = [
    {
      id: "cpu",
      kind: "cpu",
      present: true,
      compiler: gcc,
      evidence: cpu,
      missing: gcc ? [] : ["gcc"],
    },
    {
      id: "opencl",
      kind: "gpu",
      present: Boolean(openclLib && exists(openclLib)),
      compiler: gcc,
      evidence: openclLib || "OpenCL library not found",
      headers: clHeader ? path.dirname(path.dirname(clHeader)) : null,
      missing: [openclLib && exists(openclLib) ? null : "opencl_library", clHeader ? null : "opencl_headers", gcc ? null : "gcc"].filter(Boolean),
    },
    {
      id: "ascend_npu",
      kind: "npu",
      present: Boolean(aclHeader),
      compiler: gcc,
      evidence: aclHeader || "acl.h not found",
      headers: aclHeader ? path.dirname(path.dirname(aclHeader)) : null,
      missing: [aclHeader ? null : "acl.h", gcc ? null : "gcc"].filter(Boolean),
    },
    {
      id: "ascend_aiv",
      kind: "aiv",
      present: Boolean(aivHeader),
      compiler: gcc,
      evidence: aivHeader || "aclnn_add.h not found",
      headers: aivHeader ? path.dirname(path.dirname(aivHeader)) : null,
      missing: [aivHeader ? null : "aclnn_add.h", gcc ? null : "gcc"].filter(Boolean),
    },
  ];
  const extraRoot = path.join(probeDir, "extra");
  if (exists(extraRoot)) {
    for (const name of fs.readdirSync(extraRoot)) {
      const metaPath = path.join(extraRoot, name, "backend.json");
      if (!exists(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const marker = meta.present_file ? exists(path.resolve(extraRoot, name, meta.present_file)) : false;
      backends.push({
        id: name,
        kind: meta.kind || "custom",
        present: marker,
        compiler: gcc,
        evidence: meta.present_file || "backend.json",
        source: path.join(extraRoot, name, meta.source || "probe.c"),
        headers: meta.headers || null,
        libs: meta.libs || [],
        missing: marker ? [] : ["present_file"],
        extra: true,
      });
    }
  }
  return { hostname: os.hostname(), os: `${os.type()} ${os.release()}`, cpu, backends };
}

function summarize(samples) {
  if (!Array.isArray(samples) || samples.length !== 11) {
    const n = Array.isArray(samples) ? samples.length : 0;
    return {
      median: null,
      stdev: null,
      stdev_over_median: null,
      status: "rejected_variance",
      reason: `expected 11 samples, got ${n}`,
      n,
      samples: samples || [],
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) >> 1];
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const stdev = Math.sqrt(variance);
  const ratio = median === 0 ? Infinity : stdev / median;
  const rejected = ratio > 0.08;
  return {
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdev,
    stdev_over_median: ratio,
    status: rejected ? "rejected_variance" : "accepted",
    reason: rejected ? `stdev/median ${ratio.toFixed(4)} > 0.08` : null,
    n: samples.length,
    samples,
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeRecord(backend, body) {
  fs.mkdirSync(recordDir, { recursive: true });
  // Millisecond timestamps can collide (two writes for one backend inside
  // the same ms). Never overwrite an existing record: suffix instead.
  const base = path.join(recordDir, `${stamp()}-${backend}`);
  let file = `${base}.json`;
  for (let i = 2; fs.existsSync(file); i++) file = `${base}-${i}.json`;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

// Work-layer actions append to the same audit table as verdicts, so a
// campaign replays from the log instead of from git history. Deps are
// optional: callers without a database keep the old unaudited behavior.
function audited(out, deps, action) {
  if (deps && deps.openDb && deps.audit) {
    out.audit_id = deps.audit(deps.openDb(), action, null, out);
  }
  return out;
}

// Write-time dedup, Mem0-V3 style: an equivalent accepted record (same
// probe set, same metric id, same catalog sha, median within 3%) makes a
// new write redundant. The check is deterministic; re-measuring on purpose
// (cross-session validation) passes --force true.
function catalogStamp(catalogOpt) {
  if (!catalogOpt) return { catalog: null, sha: null };
  const abs = path.resolve(catalogOpt);
  const doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  return { catalog: abs.replace(/\\/g, "/"), sha: typeof doc.sha === "string" ? doc.sha : null };
}

function findDuplicate(newDoc, median) {
  const metric = newDoc.metrics && newDoc.metrics[0];
  if (!metric || !Number.isFinite(median)) return null;
  const keySha = newDoc.catalog_sha ?? null;
  let files;
  try {
    files = fs.readdirSync(recordDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(recordDir, name), "utf8"));
    } catch {
      continue;
    }
    if (doc.probe_set !== newDoc.probe_set) continue;
    if ((doc.catalog_sha ?? null) !== keySha) continue;
    const other = (doc.metrics || []).find((item) => item.id === metric.id);
    if (!other || other.status !== "accepted" || !Number.isFinite(other.median)) continue;
    // Do not trust the metric id to carry the size: when both sides carry
    // structured dimensions, they must match exactly, or two different
    // data points could merge into one.
    const dimsDiffer = ["width", "height", "param", "bytes"].some(
      (field) => Number.isFinite(metric[field]) && Number.isFinite(other[field]) && metric[field] !== other[field]
    );
    if (dimsDiffer) continue;
    if (Math.abs(other.median - median) / median <= 0.03) {
      return { file: path.join(recordDir, name).replace(/\\/g, "/"), median: other.median };
    }
  }
  return null;
}

// A blocked run carries no new information once the same blocker is on
// file: re-probing an absent device must not flood records/hardware.
function findBlockedDuplicate(backend, reason) {
  let files;
  try {
    files = fs.readdirSync(recordDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(recordDir, name), "utf8"));
    } catch {
      continue;
    }
    if (doc.probe_set !== backend) continue;
    const metric = (doc.metrics || [])[0];
    if (!metric || metric.kind !== "blocked" || metric.what !== reason) continue;
    return path.join(recordDir, name).replace(/\\/g, "/");
  }
  return null;
}

function blockedRecord(backend, reason, force) {
  if (force !== true && force !== "true") {
    const dup = findBlockedDuplicate(backend, reason);
    if (dup) {
      return {
        ok: false,
        blocked: reason,
        record: dup,
        duplicate_of: dup,
        dedup: "skipped_write",
        prices_written: false,
        note: "the same blocker is already on file; rerun with --force true to keep a new record",
      };
    }
  }
  const file = writeRecord(backend, {
    perfbind: 1,
    backend,
    probe_set: backend,
    protocol: { warmup: 3, samples: 11, target_ms: 150, variance_gate: 0.08 },
    metrics: [
      {
        id: backend,
        kind: "blocked",
        what: reason,
        input: "probe did not run",
        unit: "GB/s",
        median: null,
        stdev: null,
        status: "blocked",
        samples: [],
      },
    ],
  });
  return { ok: false, blocked: reason, record: file.replace(/\\/g, "/"), prices_written: false };
}

function compileProbe(backend, info) {
  const spec = BUILTINS[backend];
  const source = spec ? path.join(probeDir, spec.source) : info.source;
  if (!exists(source)) return { ok: false, reason: "probe_source_missing", source };
  const exe = path.join(probeDir, "build", `${backend}${process.platform === "win32" ? ".exe" : ""}`);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const args = ["-std=c11", "-O3", "-DNDEBUG", "-static-libgcc", source, "-o", exe];
  if (backend === "opencl") {
    if (!info.headers) return { ok: false, reason: "opencl_headers" };
    args.splice(4, 0, "-I", info.headers);
    args.push(process.platform === "win32" ? "C:/Windows/System32/OpenCL.dll" : "-lOpenCL");
  }
  if (backend === "ascend_npu" || backend === "ascend_aiv") {
    if (!info.headers) return { ok: false, reason: "sdk_missing" };
    args.splice(4, 0, "-I", info.headers);
    args.push("-lascendcl");
  }
  if (info.extra && info.headers) args.splice(4, 0, "-I", info.headers);
  if (info.libs) for (const lib of info.libs) args.push(`-l${lib}`);
  const compiled = spawnSync(info.compiler, args, { encoding: "utf8" });
  if (compiled.status !== 0) {
    return { ok: false, reason: "compile_failed", stderr: `${compiled.stdout || ""}\n${compiled.stderr || ""}`.trim() };
  }
  return { ok: true, exe, command: `${info.compiler} ${args.join(" ")}` };
}

// Same idea as findDuplicate, for multi-metric platform probes: every
// metric must exist, be accepted on both sides, carry the same structured
// dimensions, and sit within 3%.
function findProbeDuplicate(newDoc) {
  const metrics = newDoc.metrics || [];
  if (!metrics.length || metrics.some((metric) => metric.status !== "accepted" || !Number.isFinite(metric.median))) {
    return null;
  }
  let files;
  try {
    files = fs.readdirSync(recordDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(recordDir, name), "utf8"));
    } catch {
      continue;
    }
    if (doc.probe_set !== newDoc.probe_set) continue;
    const others = doc.metrics || [];
    if (others.length !== metrics.length) continue;
    const allMatch = metrics.every((metric) => {
      const other = others.find((item) => item.id === metric.id);
      if (!other || other.status !== "accepted" || !Number.isFinite(other.median)) return false;
      const dimsDiffer = ["width", "height", "param", "bytes"].some(
        (field) => Number.isFinite(metric[field]) && Number.isFinite(other[field]) && metric[field] !== other[field]
      );
      return !dimsDiffer && Math.abs(other.median - metric.median) / metric.median <= 0.03;
    });
    if (allMatch) return path.join(recordDir, name).replace(/\\/g, "/");
  }
  return null;
}

function runProbe(backend, opts = {}) {
  const found = discoverBackends();
  const info = found.backends.find((item) => item.id === backend);
  if (!info) throw new Error(`unknown backend ${backend}`);
  const force = opts.force === true || opts.force === "true";
  if (!info.present || (info.missing && info.missing.length)) {
    return blockedRecord(backend, info.missing && info.missing.length ? info.missing.join(",") : "device_absent", force);
  }
  const built = compileProbe(backend, info);
  if (!built.ok) return blockedRecord(backend, built.reason, force);
  const ran = spawnSync(built.exe, [], { encoding: "utf8" });
  const text = (ran.stdout || "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return blockedRecord(backend, "probe_output_not_json", force);
  }
  if (parsed.blocked || ran.status === 2) {
    return blockedRecord(backend, parsed.blocked || "probe_blocked", force);
  }
  const metrics = (parsed.metrics || []).map((metric) => {
    const stats = summarize(metric.samples);
    return {
      id: metric.id,
      kind: metric.kind,
      what: `${backend} ${metric.kind}`,
      input: `${metric.bytes} bytes`,
      unit: metric.unit,
      bytes: metric.bytes,
      ...stats,
    };
  });
  const summary = metrics.map((metric) => ({
    id: metric.id,
    kind: metric.kind,
    status: metric.status,
    median: metric.median,
    stdev_over_median: metric.stdev_over_median,
  }));
  const body = {
    perfbind: 1,
    backend,
    probe_set: parsed.probe_set || backend,
    device: parsed.device || null,
    hardware: { cpu: found.cpu, os: found.os, device: parsed.device || null },
    toolchain: { compiler: info.compiler, flags: "-std=c11 -O3 -DNDEBUG -static-libgcc" },
    command: built.command,
    protocol: { warmup: 3, samples: 11, target_ms: 150, variance_gate: "stdev/median > 0.08 => rejected_variance" },
    metrics,
  };
  if (!force) {
    const dup = findProbeDuplicate(body);
    if (dup) {
      return {
        ok: true,
        blocked: null,
        record: dup,
        duplicate_of: dup,
        dedup: "skipped_write",
        prices_written: false,
        metrics: summary,
        note: "an equivalent accepted record exists within 3% on every metric; rerun with --force true to keep a new sample",
      };
    }
  }
  const file = writeRecord(backend, body);
  return {
    ok: true,
    blocked: null,
    record: file.replace(/\\/g, "/"),
    prices_written: false,
    metrics: summary,
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function dramCandidate(metrics, kind) {
  const rows = metrics.filter((metric) => metric.kind === kind && metric.status === "accepted" && metric.unit === "GB/s");
  if (rows.length < 2) return { skipped: true, reason: "need_two_accepted_sizes", kind };
  rows.sort((a, b) => a.bytes - b.bytes);
  const small = rows[0];
  const large = rows[rows.length - 1];
  if (!(large.median < small.median)) {
    return { skipped: true, reason: "plateau_not_reached", kind, small: small.id, large: large.id };
  }
  return { metric: large, cache: small };
}

function priceSet(platformId, kind, priceId, value, metric, source, when) {
  const cli = path.join(__dirname, "cli.js");
  const args = [
    cli,
    "price-set",
    "--platform",
    platformId,
    "--kind",
    kind,
    "--id",
    priceId,
    "--value",
    String(value),
    "--metric",
    metric,
    "--source",
    source,
    "--when",
    when,
    "--label",
    platformId,
    "--threads",
    kind === "cpu" ? "1" : "0",
    "--scope",
    "probe",
  ];
  const ran = spawnSync(process.execPath, args, { encoding: "utf8", cwd: root });
  if (ran.status !== 0) {
    return { ok: false, price_id: priceId, stderr: (ran.stderr || ran.stdout || "").trim() };
  }
  return { ok: true, price_id: priceId, value, tool: JSON.parse(ran.stdout) };
}

function existingPrice(platformId, priceId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(__dirname, "perfexpert.sqlite"));
  return db.prepare("SELECT value FROM prices WHERE platform_id = ? AND price_id = ?").get(platformId, priceId);
}

function commitPrices(opts) {
  if (!opts.record) throw new Error("missing --record");
  if (!opts.platform) throw new Error("missing --platform");
  const doc = JSON.parse(fs.readFileSync(path.resolve(opts.record), "utf8"));
  const backend = doc.backend;
  if (!backend || !PRICE_MAP[backend]) throw new Error(`record has no priced backend: ${backend || "missing"}`);
  const map = PRICE_MAP[backend];
  const written = [];
  const skipped = [];
  for (const [kind, priceId] of Object.entries(map)) {
    if (existingPrice(opts.platform, priceId) && opts.replace !== true && opts.replace !== "true") {
      skipped.push({ price_id: priceId, reason: "price_exists" });
      continue;
    }
    const picked = dramCandidate(doc.metrics, kind);
    if (picked.skipped) {
      skipped.push({ price_id: priceId, ...picked });
      continue;
    }
    const value = round1(picked.metric.median);
    written.push(
      priceSet(
        opts.platform,
        BUILTINS[backend] ? BUILTINS[backend].kind : "custom",
        priceId,
        value,
        picked.metric.id,
        path.resolve(opts.record),
        "largest accepted size is slower than the smallest accepted size"
      )
    );
    if (kind === "read" && picked.cache && !existingPrice(opts.platform, "sequential_read_cache_GBps")) {
      written.push(
        priceSet(
          opts.platform,
          BUILTINS[backend].kind,
          "sequential_read_cache_GBps",
          round1(picked.cache.median),
          picked.cache.id,
          path.resolve(opts.record),
          "smallest accepted read, faster than the DRAM size"
        )
      );
    }
  }
  return {
    platform_id: opts.platform,
    backend,
    record: path.resolve(opts.record).replace(/\\/g, "/"),
    written,
    skipped,
    init_not_called: true,
  };
}

function planSplit(opts) {
  if (!opts.src) throw new Error("missing --src");
  if (!opts.out) throw new Error("missing --out");
  // Planned exam sizes default to desktop frames; phones and cameras pass
  // their native sizes, e.g. --sizes 1216x2688,4000x3000.
  const sizeSpecs = opts.sizes ? String(opts.sizes).split(",") : ["1920x1080", "2560x1440"];
  const sizes = sizeSpecs.map((spec, index) => {
    const match = /^\s*(\d+)x(\d+)\s*$/.exec(spec);
    if (!match) throw new Error(`bad --sizes entry: ${spec} (want WxH[,WxH])`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });
  const { scanIop } = require("./project_ledger");
  const scanned = scanIop(opts.src);
  const priceable = scanned.modules.filter((item) => item.decision === "module_wall");
  const needs = scanned.modules.filter((item) => item.decision === "needs_branch");
  const refused = scanned.modules.filter((item) => item.decision === "refuse");
  const want = [
    { column: "base", take: (item) => item.colorspace === "lab" && item.kernels === 1 && item.halo === 0 },
    { column: "rgb", take: (item) => item.colorspace === "rgb" && item.kernels === 1 && item.halo === 0 },
    { column: "extra_kernel", take: (item) => item.kernels > 1 && item.halo === 0 },
    { column: "halo", take: (item) => item.halo > 0 },
  ];
  const train = [];
  const used = new Set();
  const missing = [];
  for (const slot of want) {
    const found = priceable.find((item) => !used.has(item.id) && slot.take(item));
    if (!found) {
      if (slot.column !== "base") missing.push(slot.column);
      continue;
    }
    used.add(found.id);
    train.push(found);
  }
  if (!train.length) {
    const any = priceable.find((item) => !used.has(item.id));
    if (any) {
      used.add(any.id);
      train.push(any);
    }
  }
  // The exam is a sample, not the repo. Per shape cell, two test entries
  // with different planned sizes give breadth and depth. Everything else
  // priceable joins the claim from source classification alone; claimed
  // modules are not exam items and need no measurement.
  const rest = priceable.filter((item) => !used.has(item.id));
  const cells = new Map();
  for (const item of rest) {
    const key = `${item.colorspace}|k${item.kernels}|h${item.halo || 0}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(item);
  }
  const test = [];
  const claimed = [];
  for (const key of [...cells.keys()].sort()) {
    const members = cells.get(key).sort((a, b) => a.id.localeCompare(b.id));
    if (members[0]) test.push({ ...members[0], width: sizes[0].width, height: sizes[0].height });
    const second = sizes[1] || sizes[0];
    if (members[1]) test.push({ ...members[1], width: second.width, height: second.height });
    for (const extra of members.slice(2)) claimed.push(extra);
  }
  const catalog = {
    project: path.basename(path.resolve(opts.src)),
    iop_src: path.resolve(opts.src).replace(/\\/g, "/"),
    measured: false,
    modules: [
      ...train.map((item) => ({
        id: item.id,
        role: "train",
        colorspace: item.colorspace,
        kernels: item.kernels,
        halo: item.halo,
        branch_resolved: false,
      })),
      ...test.map((item) => ({
        id: item.id,
        role: "test",
        colorspace: item.colorspace,
        kernels: item.kernels,
        halo: item.halo,
        branch_resolved: false,
        width: item.width,
        height: item.height,
      })),
      ...claimed.map((item) => ({
        id: item.id,
        role: "claimed",
        colorspace: item.colorspace,
        kernels: item.kernels,
        halo: item.halo,
        branch_resolved: false,
      })),
      ...refused.map((item) => ({ id: item.id, role: "refuse" })),
    ],
  };
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2));
  return {
    catalog: out.replace(/\\/g, "/"),
    minimum_measurements: train.length,
    train: train.map((item) => item.id),
    test: test.map((item) => ({ id: item.id, planned_size: `${item.width}x${item.height}` })),
    claimed: claimed.map((item) => item.id),
    claimed_note: "claimed modules are in the claim from source classification; they are not exam items and need no measurement",
    needs_branch: needs.map((item) => ({ id: item.id, branch_digest: item.branch_digest || [] })),
    refused: refused.length,
    missing_columns: missing,
    exam_budget_runs: train.length + test.length,
    exam_budget_note: "one measure-module run per train and test entry; freeze-tests then judges breadth, depth, and coverage",
    records_written: false,
    prices_written: false,
  };
}

function cmdDiscover() {
  console.log(JSON.stringify(discoverBackends(), null, 2));
}

function cmdRunProbe(opts, deps) {
  if (!opts.backend) throw new Error("missing --backend");
  const out = audited({ backend: opts.backend, ...runProbe(opts.backend, opts) }, deps, "run_probe");
  console.log(JSON.stringify(out, null, 2));
}

function cmdCommitPrices(opts, deps) {
  console.log(JSON.stringify(audited(commitPrices(opts), deps, "commit_prices"), null, 2));
}

function cmdPlanSplit(opts, deps) {
  console.log(JSON.stringify(audited(planSplit(opts), deps, "plan_split"), null, 2));
}

function cmdMeasureModule(opts, deps) {
  if (!opts.module) throw new Error("missing --module");
  const defaultKernels = "D:/WorkStation/samples/libre-dt-lab/data/kernels";
  const kernels = opts.kernels || (exists(defaultKernels) ? defaultKernels : null);
  if (!kernels) throw new Error("missing --kernels (no default kernels directory on this machine)");
  const width = opts.width === undefined ? 1920 : Number(opts.width);
  const height = opts.height === undefined ? 1080 : Number(opts.height);
  if (!(Number.isInteger(width) && width > 0)) throw new Error("width must be a positive integer");
  if (!(Number.isInteger(height) && height > 0)) throw new Error("height must be a positive integer");
  const context = {
    module: opts.module,
    backend: opts.backend || "opencl",
    project: opts.project || "libre-dt-lab",
    width,
    height,
    catalog: opts.catalog ? path.resolve(opts.catalog).replace(/\\/g, "/") : null,
  };
  const exe = path.join(probeDir, "build", process.platform === "win32" ? "module_pipe.exe" : "module_pipe");
  if (!exists(exe)) throw new Error(`missing ${exe}`);
  const ran = spawnSync(exe, [opts.module, kernels, String(width), String(height)], { encoding: "utf8" });
  const text = (ran.stdout || "").trim();
  if (ran.status !== 0) {
    return audited({ ...blockedRecord(opts.module, text || "measure_failed", opts.force), ...context }, deps, "measure_module");
  }
  const parsed = JSON.parse(text);
  const stats = summarize(parsed.samples);
  const metric = { ...parsed, ...stats, clock: "process_cl" };
  const stampInfo = catalogStamp(opts.catalog);
  const body = {
    perfbind: 1,
    backend: context.backend,
    probe_set: "module_process_cl",
    project: context.project,
    protocol: {
      warmup_windows: 3,
      samples: 11,
      window: "at least 8 launches and 80 ms",
      variance_gate: "stdev/median > 0.08 => rejected_variance",
      clock: `one process_cl launch, clFinish, ${width}x${height}`,
    },
    metrics: [metric],
  };
  if (stampInfo.catalog) {
    body.catalog = stampInfo.catalog;
    body.catalog_sha = stampInfo.sha;
  }
  if (opts.force !== "true" && stats.status === "accepted") {
    const dup = findDuplicate(body, stats.median);
    if (dup) {
      return audited(
        {
          ok: true,
          record: dup.file,
          duplicate_of: dup.file,
          dedup: "skipped_write",
          prices_written: false,
          metric: {
            id: metric.id,
            status: metric.status,
            median: metric.median,
            stdev_over_median: metric.stdev_over_median,
          },
          note: "an equivalent accepted record exists within 3%; rerun with --force true to keep a new sample",
          ...context,
        },
        deps,
        "measure_module"
      );
    }
  }
  const file = writeRecord(opts.module, body);
  return audited(
    {
      ok: stats.status === "accepted",
      record: file.replace(/\\/g, "/"),
      prices_written: false,
      metric: {
        id: metric.id,
        status: metric.status,
        median: metric.median,
        stdev_over_median: metric.stdev_over_median,
      },
      ...context,
    },
    deps,
    "measure_module"
  );
}

function cmdRunTemplate(opts, deps) {
  if (!opts.shape) throw new Error("missing --shape");
  const n = opts.n === undefined ? NaN : Number(opts.n);
  if (!(Number.isInteger(n) && n >= 1)) throw new Error("n must be a positive integer");
  const width = opts.width === undefined ? 1920 : Number(opts.width);
  const height = opts.height === undefined ? 1080 : Number(opts.height);
  if (!(Number.isInteger(width) && width > 0)) throw new Error("width must be a positive integer");
  if (!(Number.isInteger(height) && height > 0)) throw new Error("height must be a positive integer");
  const context = {
    shape: opts.shape,
    n,
    backend: opts.backend || "opencl",
    project: opts.project || "template",
    width,
    height,
    catalog: opts.catalog ? path.resolve(opts.catalog).replace(/\\/g, "/") : null,
  };
  const exe = path.join(probeDir, "build", process.platform === "win32" ? "template_pipe.exe" : "template_pipe");
  if (!exists(exe)) throw new Error(`missing ${exe}`);
  const ran = spawnSync(exe, [opts.shape, String(n), String(width), String(height)], { encoding: "utf8" });
  const text = (ran.stdout || "").trim();
  if (ran.status !== 0) {
    return audited({ ...blockedRecord(`${opts.shape}_${n}`, text || "measure_failed", opts.force), ...context }, deps, "run_template");
  }
  const parsed = JSON.parse(text);
  const stats = summarize(parsed.samples);
  const metric = { ...parsed, ...stats, clock: "template" };
  const stampInfo = catalogStamp(opts.catalog);
  const body = {
    perfbind: 1,
    backend: context.backend,
    probe_set: "shape_template",
    project: context.project,
    protocol: {
      warmup_windows: 3,
      samples: 11,
      window: "at least 8 launches and 80 ms",
      variance_gate: "stdev/median > 0.08 => rejected_variance",
      clock: `template ${opts.shape} n=${n}, clFinish, ${width}x${height}`,
    },
    metrics: [metric],
  };
  if (stampInfo.catalog) {
    body.catalog = stampInfo.catalog;
    body.catalog_sha = stampInfo.sha;
  }
  if (opts.force !== "true" && stats.status === "accepted") {
    const dup = findDuplicate(body, stats.median);
    if (dup) {
      return audited(
        {
          ok: true,
          record: dup.file,
          duplicate_of: dup.file,
          dedup: "skipped_write",
          prices_written: false,
          metric: {
            id: metric.id,
            status: metric.status,
            median: metric.median,
            stdev_over_median: metric.stdev_over_median,
          },
          note: "an equivalent accepted record exists within 3%; rerun with --force true to keep a new sample",
          ...context,
        },
        deps,
        "run_template"
      );
    }
  }
  const file = writeRecord(`${opts.shape}_${n}`, body);
  return audited(
    {
      ok: stats.status === "accepted",
      record: file.replace(/\\/g, "/"),
      prices_written: false,
      metric: {
        id: metric.id,
        status: metric.status,
        median: metric.median,
        stdev_over_median: metric.stdev_over_median,
      },
      ...context,
    },
    deps,
    "run_template"
  );
}

module.exports = {
  cmdDiscover,
  cmdRunProbe,
  cmdCommitPrices,
  cmdPlanSplit,
  cmdMeasureModule,
  cmdRunTemplate,
  discoverBackends,
  commitPrices,
  planSplit,
};
