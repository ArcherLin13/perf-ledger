// ledger doctor: the periodic health check for the experience store.
// Read-only. It never fixes anything; it prints a prescription and the
// operator (human or agent) decides. Four checks:
//   drift      catalog.sha vs the source repository's HEAD
//   dangling   catalog entries pointing at record files that do not exist
//   stale      records stamped with a different catalog_sha than the catalog
//   orphans    module/template records no catalog references
//   duplicates equivalent accepted records the write-time dedup gate missed
//   probe_age  platform probe records older than --days (default 30)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const recordDir = path.join(root, "records", "hardware");
const catalogDir = path.join(root, "catalog");
const BACKENDS = ["cpu", "opencl", "ascend_npu", "ascend_aiv"];
const MODULE_PROBE_SETS = ["module_process_cl", "shape_template"];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function recordFiles() {
  try {
    return fs
      .readdirSync(recordDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(recordDir, name));
  } catch {
    return [];
  }
}

function gitHead(src) {
  const ran = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (ran.error || ran.status !== 0) return null;
  return ran.stdout.trim();
}

function cmdDoctor(opts) {
  const days = opts.days === undefined ? 30 : Number(opts.days);
  const catalogPaths = opts.catalog
    ? [path.resolve(opts.catalog)]
    : fs
        .readdirSync(catalogDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(catalogDir, name));

  const checks = { drift: [], dangling: [], stale: [], orphans: [], duplicates: [], probe_age: [] };
  const prescription = [];
  const referenced = new Set();

  for (const catalogPath of catalogPaths) {
    const catalog = readJson(catalogPath);
    if (!catalog) continue;
    const rel = path.relative(root, catalogPath).replace(/\\/g, "/");
    for (const entry of catalog.modules || []) {
      if (!entry.record) continue;
      referenced.add(path.resolve(entry.record));
      const recordAbs = path.resolve(entry.record);
      if (!fs.existsSync(recordAbs)) {
        checks.dangling.push({ catalog: rel, id: entry.id, record: entry.record });
        continue;
      }
      const doc = readJson(recordAbs);
      if (catalog.sha && doc && doc.catalog_sha && doc.catalog_sha !== catalog.sha) {
        checks.stale.push({ catalog: rel, id: entry.id, record_sha: doc.catalog_sha, catalog_sha: catalog.sha });
      }
    }
    if (catalog.sha && catalog.iop_src && fs.existsSync(catalog.iop_src)) {
      const head = gitHead(catalog.iop_src);
      if (head && head !== catalog.sha) {
        checks.drift.push({ catalog: rel, catalog_sha: catalog.sha, source_head: head });
      }
    }
  }

  const docs = recordFiles()
    .map((file) => ({ file, doc: readJson(file) }))
    .filter((item) => item.doc);

  for (const { file, doc } of docs) {
    if (!MODULE_PROBE_SETS.includes(doc.probe_set)) continue;
    if (!referenced.has(file)) {
      checks.orphans.push({ record: path.relative(root, file).replace(/\\/g, "/"), probe_set: doc.probe_set });
    }
  }

  const groups = new Map();
  for (const { file, doc } of docs) {
    for (const metric of doc.metrics || []) {
      if (metric.status !== "accepted" || !Number.isFinite(metric.median)) continue;
      const key = `${doc.probe_set}|${metric.id}|${doc.catalog_sha ?? ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file: path.relative(root, file).replace(/\\/g, "/"), median: metric.median });
    }
  }
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    const min = Math.min(...items.map((item) => item.median));
    const max = Math.max(...items.map((item) => item.median));
    if ((max - min) / min <= 0.03) {
      checks.duplicates.push({ key, n: items.length, records: items.map((item) => item.file) });
    }
  }

  const now = Date.now();
  for (const backend of BACKENDS) {
    const times = docs
      .filter((item) => item.doc.backend === backend)
      .map((item) => fs.statSync(item.file).mtimeMs);
    if (!times.length) continue;
    const ageDays = (now - Math.max(...times)) / 86400000;
    if (ageDays > days) {
      checks.probe_age.push({ backend, age_days: Math.round(ageDays), threshold_days: days });
    }
  }

  if (checks.drift.length) prescription.push("drift: run bump-sha --catalog <file> --sha auto, then re-measure what went stale and re-score");
  if (checks.stale.length) prescription.push("stale: re-measure the listed entries under the current sha; stale records stay queryable");
  if (checks.dangling.length) prescription.push("dangling: repoint the entry's record field at an existing record or re-measure");
  if (checks.orphans.length) prescription.push("orphans: attach them to a catalog entry or move them to records/archive/ (never delete)");
  if (checks.duplicates.length) prescription.push("duplicates: keep the record each catalog points at; archive the rest");
  if (checks.probe_age.length) prescription.push("probe_age: re-run run-probe for the listed backends; commit-prices will skip existing prices");
  if (!prescription.length) prescription.push("healthy: nothing to do");

  const ok = Object.values(checks).every((list) => list.length === 0);
  console.log(JSON.stringify({ ok, threshold_days: days, catalogs_checked: catalogPaths.length, checks, prescription }, null, 2));
}

module.exports = { cmdDoctor };
