// Performance expert: prices in SQLite, estimates and audits appended.
// The agent quotes this tool. It does not recompute the arithmetic.

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "perfexpert.sqlite");

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  config.pricesPath = path.resolve(__dirname, config.prices);
  config.shapesPath = path.resolve(__dirname, config.shapes);
  return config;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function openDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY,
      cpu TEXT NOT NULL,
      threads INTEGER NOT NULL,
      scope TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prices (
      platform_id TEXT NOT NULL,
      price_id TEXT NOT NULL,
      value REAL NOT NULL,
      metric TEXT NOT NULL,
      valid_when TEXT NOT NULL,
      source_record TEXT NOT NULL,
      PRIMARY KEY (platform_id, price_id)
    );
    CREATE TABLE IF NOT EXISTS shapes (
      id TEXT PRIMARY KEY,
      can_price INTEGER NOT NULL,
      counting_rule TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      shape TEXT NOT NULL,
      access TEXT,
      width INTEGER,
      height INTEGER,
      bpp_in REAL,
      bpp_out REAL,
      radius INTEGER,
      levels INTEGER,
      bytes_read REAL,
      bytes_written REAL,
      lower_bound_ms REAL,
      upper_bound_ms REAL,
      report_ms REAL,
      report TEXT NOT NULL,
      refused INTEGER NOT NULL,
      refuse_reason TEXT,
      formula TEXT NOT NULL,
      prices_used TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      estimate_id INTEGER NOT NULL,
      measured_ms REAL NOT NULL,
      report_ms REAL NOT NULL,
      residual_ratio REAL NOT NULL,
      verdict TEXT NOT NULL,
      source_record TEXT,
      FOREIGN KEY (estimate_id) REFERENCES estimates(id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      estimate_id INTEGER,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS module_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      module_id TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      shape TEXT NOT NULL,
      unit TEXT NOT NULL,
      value REAL NOT NULL,
      measured_ms REAL NOT NULL,
      pixels REAL NOT NULL,
      passes REAL NOT NULL,
      source_record TEXT,
      active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenario_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      predicted_ms REAL NOT NULL,
      measured_ms REAL NOT NULL,
      residual_ratio REAL NOT NULL,
      verdict TEXT NOT NULL,
      source_record TEXT
    );
  `);
  ensureColumn(db, "platforms", "kind", "TEXT NOT NULL DEFAULT 'cpu'");
}

function nowIso() {
  return new Date().toISOString();
}

function audit(db, action, estimateId, detail) {
  const row = db
    .prepare(
      "INSERT INTO audit (created_at, action, estimate_id, detail) VALUES (?, ?, ?, ?)"
    )
    .run(nowIso(), action, estimateId, JSON.stringify(detail));
  return Number(row.lastInsertRowid);
}

function seed(db) {
  const config = loadConfig();
  const doc = JSON.parse(fs.readFileSync(config.pricesPath, "utf8"));
  const shapes = JSON.parse(fs.readFileSync(config.shapesPath, "utf8"));
  const platformId = config.platform_id;
  const extras = [
    { id: "gpu", kind: "gpu", label: "unfitted" },
    { id: "npu", kind: "npu", label: "unfitted" },
    { id: "aiv", kind: "aiv", label: "unfitted" },
    { id: "isp", kind: "isp", label: "unfitted" },
  ];
  const upsertPlatform = db.prepare(
    `INSERT INTO platforms (id, cpu, threads, scope, kind)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cpu = excluded.cpu, threads = excluded.threads, scope = excluded.scope, kind = excluded.kind`
  );
  upsertPlatform.run(platformId, doc.platform, config.threads, doc.unfitted.join("; "), "cpu");
  for (const extra of extras) {
    upsertPlatform.run(extra.id, extra.label, 0, "no prices yet", extra.kind);
  }
  const upsert = db.prepare(
    `INSERT INTO prices (platform_id, price_id, value, metric, valid_when, source_record)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_id, price_id) DO UPDATE SET
       value = excluded.value, metric = excluded.metric,
       valid_when = excluded.valid_when, source_record = excluded.source_record`
  );
  for (const [priceId, price] of Object.entries(doc.prices)) {
    upsert.run(
      platformId,
      priceId,
      price.value,
      price.metric,
      price.when,
      doc.fitted_from
    );
  }
  const shapeStmt = db.prepare(
    `INSERT INTO shapes (id, can_price, counting_rule) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET can_price = excluded.can_price, counting_rule = excluded.counting_rule`
  );
  for (const row of shapes) shapeStmt.run(row.id, row.can_price, row.counting_rule);
  return platformId;
}

function priceMap(db, platformId) {
  const rows = db
    .prepare("SELECT price_id, value, metric FROM prices WHERE platform_id = ?")
    .all(platformId);
  const map = {};
  for (const row of rows) map[row.price_id] = row;
  return map;
}

function num(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function frameBytes(width, height, bpp) {
  return width * height * bpp;
}

function levelSize(width, height, level) {
  return {
    width: Math.max(1, Math.floor(width / 2 ** level)),
    height: Math.max(1, Math.floor(height / 2 ** level)),
  };
}

function boundMs(bytesRead, bytesWritten, prices) {
  const copy = prices.sequential_copy_dram_GBps.value;
  const read = prices.sequential_read_dram_GBps.value;
  const write = prices.sequential_write_dram_GBps.value;
  if (bytesWritten === 0) {
    return {
      ms: bytesRead / (read * 1e6),
      formula: `${bytesRead} / (${read} GB/s * 1e6) using ${prices.sequential_read_dram_GBps.metric}`,
    };
  }
  return {
    ms: (bytesRead + bytesWritten) / (copy * 1e6),
    formula: `(${bytesRead} + ${bytesWritten}) / (${copy} GB/s * 1e6) using ${prices.sequential_copy_dram_GBps.metric}`,
  };
}

function naiveMs(bytesInOnce, taps, bytesOut, prices) {
  const read = prices.sequential_read_dram_GBps.value;
  const write = prices.sequential_write_dram_GBps.value;
  const bytesRead = bytesInOnce * taps;
  const ms = bytesRead / (read * 1e6) + (bytesOut === 0 ? 0 : bytesOut / (write * 1e6));
  return {
    ms,
    bytesRead,
    formula: `${bytesRead} / (${read} GB/s * 1e6) + ${bytesOut} / (${write} GB/s * 1e6)`,
  };
}

function estimate(db, platformId, opts) {
  const shape = opts.shape;
  const known = db.prepare("SELECT id, can_price FROM shapes WHERE id = ?").get(shape);
  if (!known) throw new Error(`unknown shape: ${shape}`);
  const prices = priceMap(db, platformId);
  const base = {
    platform_id: platformId,
    shape,
    access: opts.access || null,
    width: opts.width ?? null,
    height: opts.height ?? null,
    bpp_in: opts.bppIn ?? null,
    bpp_out: opts.bppOut ?? null,
    radius: opts.radius ?? null,
    levels: opts.levels ?? null,
    prices_used: Object.fromEntries(
      Object.entries(prices).map(([id, row]) => [id, { value: row.value, metric: row.metric }])
    ),
  };
  const requiredPrices = [
    "sequential_read_dram_GBps",
    "sequential_write_dram_GBps",
    "sequential_copy_dram_GBps",
  ];
  const missingPrices = requiredPrices.filter((id) => !prices[id]);
  if (!known.can_price || missingPrices.length) {
    return finish(db, base, {
      refused: true,
      refuse_reason: !known.can_price
        ? `${shape} has no unit price on this platform`
        : `missing prices on ${platformId}: ${missingPrices.join(", ")}`,
      bytes_read: null,
      bytes_written: null,
      lower_bound_ms: null,
      upper_bound_ms: null,
      report_ms: null,
      report: "refused",
      formula: "refused",
    });
  }

  const width = num(opts.width, "width");
  const height = num(opts.height, "height");
  const bppIn = num(opts.bppIn ?? 1, "bpp-in");
  const bppOut = num(opts.bppOut ?? bppIn, "bpp-out");
  const readPasses = num(opts.readPasses ?? 1, "read-passes");
  const writePasses = num(opts.writePasses ?? 1, "write-passes");
  if (readPasses === 0 || writePasses === 0) throw new Error("passes must be > 0");
  const inputBytes = frameBytes(width, height, bppIn);
  const outputBytes = frameBytes(width, height, bppOut);
  const passNote = `${readPasses} input passes, ${writePasses} output passes`;

  if (shape === "sequential" || shape === "reduction") {
    const bytesRead = inputBytes * readPasses;
    const bytesWritten = shape === "reduction" ? 0 : outputBytes * writePasses;
    const bound = boundMs(bytesRead, bytesWritten, prices);
    return finish(db, base, {
      refused: false,
      refuse_reason: null,
      bytes_read: bytesRead,
      bytes_written: bytesWritten,
      lower_bound_ms: bound.ms,
      upper_bound_ms: null,
      report_ms: bound.ms,
      report: "lower",
      formula: `${passNote}; ${bound.formula}`,
    });
  }

  if (shape === "pyramid") {
    const levels = num(opts.levels ?? 1, "levels");
    let bytesRead = 0;
    let bytesWritten = 0;
    for (let level = 0; level < levels; level++) {
      const size = levelSize(width, height, level);
      bytesRead += frameBytes(size.width, size.height, bppIn);
      bytesWritten += frameBytes(size.width, size.height, bppOut);
    }
    const bound = boundMs(bytesRead, bytesWritten, prices);
    return finish(db, base, {
      refused: false,
      refuse_reason: null,
      bytes_read: bytesRead,
      bytes_written: bytesWritten,
      lower_bound_ms: bound.ms,
      upper_bound_ms: null,
      report_ms: bound.ms,
      report: "lower",
      formula: `${levels} levels; ${bound.formula}`,
    });
  }

  const radius = num(opts.radius ?? 0, "radius");
  const taps = (2 * radius + 1) ** 2;
  const access = opts.access || "unknown";
  if (!["streaming", "naive", "unknown"].includes(access)) {
    throw new Error("access must be streaming, naive, or unknown");
  }
  const lower = boundMs(inputBytes * readPasses, outputBytes * writePasses, prices);
  const upper = naiveMs(
    inputBytes * (access === "naive" ? readPasses : 1),
    taps,
    outputBytes * (access === "naive" ? writePasses : 1),
    prices
  );
  const report =
    access === "streaming" ? "lower" : access === "naive" ? "upper" : "range";
  const reportMs = report === "upper" ? upper.ms : report === "lower" ? lower.ms : null;
  return finish(db, base, {
    refused: false,
    refuse_reason: null,
    bytes_read: access === "naive" ? upper.bytesRead : inputBytes * readPasses,
    bytes_written: outputBytes * writePasses,
    lower_bound_ms: lower.ms,
    upper_bound_ms: upper.ms,
    report_ms: reportMs,
    report,
    formula:
      report === "range"
        ? `${passNote}; lower: ${lower.formula}; upper: ${upper.formula}`
        : report === "upper"
          ? `${passNote}; ${upper.formula}`
          : `${passNote}; ${lower.formula}`,
  });
}

function finish(db, base, result) {
  const createdAt = nowIso();
  const estimateRow = db
    .prepare(
      `INSERT INTO estimates (
        created_at, platform_id, shape, access, width, height, bpp_in, bpp_out,
        radius, levels, bytes_read, bytes_written, lower_bound_ms, upper_bound_ms,
        report_ms, report, refused, refuse_reason, formula, prices_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      createdAt,
      base.platform_id,
      base.shape,
      base.access,
      base.width,
      base.height,
      base.bpp_in,
      base.bpp_out,
      base.radius,
      base.levels,
      result.bytes_read,
      result.bytes_written,
      result.lower_bound_ms,
      result.upper_bound_ms,
      result.report_ms,
      result.report,
      result.refused ? 1 : 0,
      result.refuse_reason,
      result.formula,
      JSON.stringify(base.prices_used)
    );
  const estimateId = Number(estimateRow.lastInsertRowid);
  const body = {
    estimate_id: estimateId,
    created_at: createdAt,
    ...base,
    ...result,
    refused: Boolean(result.refused),
  };
  body.audit_id = audit(db, "estimate", estimateId, body);
  return body;
}

function roundMs(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 1000) / 1000;
}

function present(body) {
  return {
    estimate_id: body.estimate_id,
    audit_id: body.audit_id,
    platform_id: body.platform_id,
    shape: body.shape,
    access: body.access,
    refused: body.refused,
    refuse_reason: body.refuse_reason,
    bytes_read: body.bytes_read,
    bytes_written: body.bytes_written,
    lower_bound_ms: roundMs(body.lower_bound_ms),
    upper_bound_ms: roundMs(body.upper_bound_ms),
    report: body.report,
    report_ms: roundMs(body.report_ms),
    formula: body.formula,
  };
}

function cmdInit() {
  const db = openDb();
  migrate(db);
  const platformId = seed(db);
  const auditId = audit(db, "init", null, { platform_id: platformId, prices: loadConfig().pricesPath });
  console.log(JSON.stringify({ ok: true, db: dbPath, platform_id: platformId, audit_id: auditId }, null, 2));
}

function cmdPrices() {
  const db = openDb();
  console.log(JSON.stringify(db.prepare("SELECT * FROM prices").all(), null, 2));
}

function cmdShapes() {
  const db = openDb();
  console.log(JSON.stringify(db.prepare("SELECT * FROM shapes").all(), null, 2));
}

function cmdEstimate(opts) {
  const db = openDb();
  migrate(db);
  const body = estimate(db, opts.platform || loadConfig().platform_id, {
    shape: opts.shape,
    access: opts.access,
    width: opts.width === undefined ? undefined : Number(opts.width),
    height: opts.height === undefined ? undefined : Number(opts.height),
    bppIn: opts["bpp-in"] === undefined ? undefined : Number(opts["bpp-in"]),
    bppOut: opts["bpp-out"] === undefined ? undefined : Number(opts["bpp-out"]),
    radius: opts.radius === undefined ? undefined : Number(opts.radius),
    levels: opts.levels === undefined ? undefined : Number(opts.levels),
    readPasses: opts["read-passes"] === undefined ? undefined : Number(opts["read-passes"]),
    writePasses: opts["write-passes"] === undefined ? undefined : Number(opts["write-passes"]),
  });
  console.log(JSON.stringify(present(body), null, 2));
}

function cmdAudit(opts) {
  const db = openDb();
  const limit = Number(opts.limit || 20);
  const rows = db
    .prepare("SELECT id, created_at, action, estimate_id, detail FROM audit ORDER BY id DESC LIMIT ?")
    .all(limit);
  console.log(
    JSON.stringify(
      rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) })),
      null,
      2
    )
  );
}

function cmdAnchor(opts) {
  const db = openDb();
  const estimateId = Number(opts.estimate);
  const measured = num(opts["measured-ms"], "measured-ms");
  const estimateRow = db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimateId);
  if (!estimateRow) throw new Error(`no estimate ${estimateId}`);
  if (estimateRow.refused || estimateRow.report_ms === null) {
    throw new Error("refused or range estimates have no single report_ms to check");
  }
  const residual = (measured - estimateRow.report_ms) / estimateRow.report_ms;
  const verdict = Math.abs(residual) > 0.5 ? "rule_needs_review" : "within_50_percent";
  const createdAt = nowIso();
  const anchor = db
    .prepare(
      `INSERT INTO anchors (
        created_at, estimate_id, measured_ms, report_ms, residual_ratio, verdict, source_record
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      createdAt,
      estimateId,
      measured,
      estimateRow.report_ms,
      residual,
      verdict,
      opts.record || null
    );
  const anchorId = Number(anchor.lastInsertRowid);
  const detail = {
    anchor_id: anchorId,
    estimate_id: estimateId,
    measured_ms: measured,
    report_ms: estimateRow.report_ms,
    residual_ratio: residual,
    verdict,
    source_record: opts.record || null,
  };
  detail.audit_id = audit(db, "anchor", estimateId, detail);
  console.log(JSON.stringify(detail, null, 2));
}

function cmdAnchors() {
  const db = openDb();
  console.log(JSON.stringify(db.prepare("SELECT * FROM anchors ORDER BY id").all(), null, 2));
}

function ensurePlatform(db, opts, platformId) {
  let platform = db.prepare("SELECT id, kind FROM platforms WHERE id = ?").get(platformId);
  if (platform) return platform;
  if (!opts.kind) throw new Error(`unknown platform: ${platformId}`);
  db.prepare(
    `INSERT INTO platforms (id, cpu, threads, scope, kind) VALUES (?, ?, ?, ?, ?)`
  ).run(
    platformId,
    opts.label || platformId,
    Number(opts.threads || 0),
    opts.scope || "",
    opts.kind
  );
  return db.prepare("SELECT id, kind FROM platforms WHERE id = ?").get(platformId);
}

function cmdPriceSet(opts) {
  const db = openDb();
  migrate(db);
  const platformId = opts.platform || loadConfig().platform_id;
  const platform = ensurePlatform(db, opts, platformId);
  const priceId = opts.id;
  const value = num(opts.value, "value");
  if (!priceId) throw new Error("missing --id");
  db.prepare(
    `INSERT INTO prices (platform_id, price_id, value, metric, valid_when, source_record)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_id, price_id) DO UPDATE SET
       value = excluded.value, metric = excluded.metric,
       valid_when = excluded.valid_when, source_record = excluded.source_record`
  ).run(
    platformId,
    priceId,
    value,
    opts.metric || "manual",
    opts.when || "",
    opts.source || "price-set"
  );
  const detail = {
    layer: "platform",
    platform_id: platformId,
    kind: platform.kind,
    price_id: priceId,
    value,
    module_prices_unchanged: true,
    scenario_checks_unchanged: true,
  };
  detail.audit_id = audit(db, "platform_price", null, detail);
  console.log(JSON.stringify(detail, null, 2));
}

function cmdModuleSet(opts) {
  const db = openDb();
  const platformId = opts.platform || loadConfig().platform_id;
  const moduleId = opts.module;
  if (!moduleId) throw new Error("missing --module");
  const measured = num(opts["measured-ms"], "measured-ms");
  const pixels = num(opts.pixels, "pixels");
  const passes = num(opts.passes || 1, "passes");
  if (pixels === 0 || passes === 0) throw new Error("pixels and passes must be > 0");
  const value = measured / (pixels / 1e6) / passes;
  const createdAt = nowIso();
  db.prepare(
    "UPDATE module_prices SET active = 0 WHERE module_id = ? AND platform_id = ? AND active = 1"
  ).run(moduleId, platformId);
  const row = db
    .prepare(
      `INSERT INTO module_prices (
        created_at, module_id, platform_id, shape, unit, value, measured_ms, pixels, passes, source_record, active
      ) VALUES (?, ?, ?, ?, 'ms_per_mpix', ?, ?, ?, ?, ?, 1)`
    )
    .run(createdAt, moduleId, platformId, opts.shape || "sequential", value, measured, pixels, passes, opts.record || null);
  const detail = {
    layer: "module",
    module_price_id: Number(row.lastInsertRowid),
    module_id: moduleId,
    platform_id: platformId,
    shape: opts.shape || "sequential",
    unit: "ms_per_mpix",
    value,
    measured_ms: measured,
    pixels,
    passes,
    platform_prices_unchanged: true,
  };
  detail.audit_id = audit(db, "module_price", null, detail);
  console.log(JSON.stringify(detail, null, 2));
}

function cmdCheck(opts) {
  const db = openDb();
  const scenarioId = opts.scenario;
  if (!scenarioId) throw new Error("missing --scenario");
  const platformId = opts.platform || loadConfig().platform_id;
  const predicted = num(opts["predicted-ms"], "predicted-ms");
  const measured = num(opts["measured-ms"], "measured-ms");
  if (predicted === 0) throw new Error("predicted-ms must be > 0");
  const residual = (measured - predicted) / predicted;
  const verdict = Math.abs(residual) > 0.5 ? "rule_needs_review" : "within_50_percent";
  const row = db
    .prepare(
      `INSERT INTO scenario_checks (
        created_at, scenario_id, platform_id, predicted_ms, measured_ms, residual_ratio, verdict, source_record
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nowIso(), scenarioId, platformId, predicted, measured, residual, verdict, opts.record || null);
  const detail = {
    layer: "scenario",
    scenario_check_id: Number(row.lastInsertRowid),
    scenario_id: scenarioId,
    platform_id: platformId,
    predicted_ms: predicted,
    measured_ms: measured,
    residual_ratio: residual,
    verdict,
    platform_prices_unchanged: true,
    module_prices_unchanged: true,
  };
  detail.audit_id = audit(db, "scenario_check", null, detail);
  console.log(JSON.stringify(detail, null, 2));
}

function cmdLedger() {
  const db = openDb();
  console.log(
    JSON.stringify(
      {
        platforms: db.prepare("SELECT id, kind, cpu, scope FROM platforms ORDER BY id").all(),
        platform_prices: db.prepare("SELECT platform_id, price_id, value, metric, source_record FROM prices ORDER BY platform_id, price_id").all(),
        module_prices: db.prepare("SELECT id, module_id, platform_id, shape, unit, value, measured_ms, pixels, passes, active FROM module_prices ORDER BY id").all(),
        scenario_checks: db.prepare("SELECT id, scenario_id, platform_id, predicted_ms, measured_ms, residual_ratio, verdict FROM scenario_checks ORDER BY id").all(),
      },
      null,
      2
    )
  );
}

function olsFixedPlusRate(points) {
  const n = points.length;
  if (n < 3) throw new Error("need at least 3 accepted fit points");
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const point of points) {
    sumX += point.bytes;
    sumY += point.ms;
    sumXX += point.bytes * point.bytes;
    sumXY += point.bytes * point.ms;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) throw new Error("fit points have no size range");
  const slope = (n * sumXY - sumX * sumY) / denom;
  const fixed = (sumY - slope * sumX) / n;
  if (!(slope > 0)) throw new Error("fitted slope is not a positive bandwidth");
  return {
    points: n,
    fixed_ms: fixed,
    rate_GBps: 1 / (slope * 1e6),
  };
}

function cmdLaunchFit(opts) {
  const db = openDb();
  const platformId = opts.platform || loadConfig().platform_id;
  const price = db
    .prepare(
      "SELECT value, metric, source_record FROM prices WHERE platform_id = ? AND price_id = ?"
    )
    .get(platformId, "sequential_copy_dram_GBps");
  if (!price) throw new Error(`no copy price on ${platformId}`);
  if (!opts.record) throw new Error("missing --record");
  const doc = JSON.parse(fs.readFileSync(path.resolve(opts.record), "utf8"));
  const fit = doc.metrics.filter((metric) => metric.role === "fit" && metric.status === "accepted");
  const byKernel = {};
  for (const metric of fit) {
    (byKernel[metric.kernel] ||= []).push({ bytes: metric.bytes, ms: metric.median, id: metric.id });
  }
  const kernels = {};
  for (const [kernel, points] of Object.entries(byKernel)) {
    if (points.length < 3) {
      kernels[kernel] = { points: points.length, refused: true, reason: "fewer than 3 accepted sizes" };
      continue;
    }
    const line = olsFixedPlusRate(points);
    const fixedFromPrice = points.map((point) => ({
      id: point.id,
      fixed_ms: point.ms - point.bytes / (price.value * 1e6),
    }));
    kernels[kernel] = {
      ...line,
      rate_over_price: line.rate_GBps / price.value,
      fixed_from_price_ms: fixedFromPrice,
    };
  }
  const usable = Object.values(kernels).filter((row) => !row.refused);
  let shared = null;
  if (usable.length >= 2) {
    const fixed = usable.map((row) => row.fixed_ms);
    const mean = fixed.reduce((sum, value) => sum + value, 0) / fixed.length;
    const spread = Math.max(...fixed) - Math.min(...fixed);
    shared = {
      fixed_ms: mean,
      spread_ms: spread,
      same_fixed: spread <= Math.max(0.05, Math.abs(mean) * 0.5),
    };
  }
  const body = {
    platform_id: platformId,
    copy_price_GBps: price.value,
    copy_metric: price.metric,
    record: opts.record,
    accepted_fit_points: fit.length,
    kernels,
    shared_fixed: shared,
  };
  body.audit_id = audit(db, "launch_fit", null, body);
  console.log(JSON.stringify(body, null, 2));
}

function cmdAccuracy() {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT a.id AS anchor_id, a.estimate_id, a.measured_ms, a.report_ms, a.residual_ratio, a.verdict,
              a.source_record, e.platform_id, e.shape, e.width, e.height, e.bytes_read, e.bytes_written, e.formula
       FROM anchors a JOIN estimates e ON e.id = a.estimate_id
       ORDER BY a.id`
    )
    .all();
  const items = rows.map((row) => {
    const accuracy = 1 - Math.abs(row.measured_ms - row.report_ms) / row.measured_ms;
    const source = row.source_record || "";
    const clock = source.includes("darktable") ? "module_wall" : "device_event";
    return {
      anchor_id: row.anchor_id,
      estimate_id: row.estimate_id,
      clock,
      platform_id: row.platform_id,
      shape: row.shape,
      width: row.width,
      height: row.height,
      measured_ms: row.measured_ms,
      report_ms: row.report_ms,
      accuracy,
      passes_85: accuracy >= 0.85,
      verdict: row.verdict,
      source_record: row.source_record,
    };
  });
  const byClock = {};
  for (const item of items) {
    const bucket = (byClock[item.clock] ||= { n: 0, passed_85: 0 });
    bucket.n += 1;
    if (item.passes_85) bucket.passed_85 += 1;
  }
  for (const bucket of Object.values(byClock)) bucket.rate = bucket.n ? bucket.passed_85 / bucket.n : null;
  console.log(JSON.stringify({ line: "accuracy = 1 - |measured_ms - report_ms| / measured_ms", pass: ">= 0.85", by_clock: byClock, anchors: items }, null, 2));
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("wall fit is singular");
    const tmp = a[col];
    a[col] = a[pivot];
    a[pivot] = tmp;
    const div = a[col][col];
    for (let k = col; k <= n; k++) a[col][k] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row) => row[n]);
}

function cmdWallFit(opts) {
  const db = openDb();
  const platformId = opts.platform || loadConfig().platform_id;
  if (!opts.record) throw new Error("missing --record");
  const doc = JSON.parse(fs.readFileSync(path.resolve(opts.record), "utf8"));
  const points = doc.metrics.filter((metric) => metric.role === "train" && metric.status === "accepted");
  if (points.length < 3) throw new Error("need at least 3 accepted training points");
  const useHalo = points.some((metric) => metric.halo);
  const width = useHalo ? 4 : 3;
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  const rows = points.map((metric) => ({
    id: metric.id,
    rgb: metric.colorspace === "rgb" ? 1 : 0,
    extra: metric.kernels - 1,
    halo: metric.halo || 0,
    ms: metric.median,
  }));
  for (const row of rows) {
    const x = useHalo ? [1, row.rgb, row.extra, row.halo] : [1, row.rgb, row.extra];
    for (let i = 0; i < width; i++) {
      rhs[i] += x[i] * row.ms;
      for (let j = 0; j < width; j++) gram[i][j] += x[i] * x[j];
    }
  }
  const solved = solveLinear(gram, rhs);
  const [base, rgb, extra, halo] = useHalo ? solved : [...solved, 0];
  const fitted = rows.map((row) => {
    const report = base + rgb * row.rgb + extra * row.extra + halo * row.halo;
    const accuracy = 1 - Math.abs(row.ms - report) / row.ms;
    return { id: row.id, measured_ms: row.ms, report_ms: report, accuracy, passes_85: accuracy >= 0.85 };
  });
  const copy = db
    .prepare("SELECT value FROM prices WHERE platform_id = ? AND price_id = ?")
    .get(platformId, "sequential_copy_dram_GBps");
  const body = {
    platform_id: platformId,
    record: opts.record,
    accepted_train_points: points.length,
    copy_price_unchanged_GBps: copy ? copy.value : null,
    formula: "base_ms + rgb_ms * (colorspace==rgb) + extra_kernel_ms * (kernels-1) + halo_ms * halo",
    base_ms: base,
    rgb_ms: rgb,
    extra_kernel_ms: extra,
    halo_ms: halo,
    training: fitted,
  };
  body.audit_id = audit(db, "wall_fit", null, body);
  console.log(JSON.stringify(body, null, 2));
}

function cmdEstimateWall(opts) {
  const db = openDb();
  migrate(db);
  const platformId = opts.platform || loadConfig().platform_id;
  const prices = priceMap(db, platformId);
  const needed = ["module_wall_base_ms", "module_wall_rgb_ms", "module_wall_extra_kernel_ms", "module_wall_halo_ms"];
  const missing = needed.filter((id) => !prices[id]);
  const colorspace = opts.colorspace;
  const kernels = num(opts.kernels, "kernels");
  const halo = num(opts.halo ?? 0, "halo");
  if (colorspace !== "lab" && colorspace !== "rgb") throw new Error("colorspace must be lab or rgb");
  if (kernels < 1) throw new Error("kernels must be >= 1");
  const base = {
    platform_id: platformId,
    shape: "module_wall",
    access: colorspace,
    width: opts.width === undefined ? null : Number(opts.width),
    height: opts.height === undefined ? null : Number(opts.height),
    bpp_in: null,
    bpp_out: null,
    radius: halo,
    levels: kernels,
    prices_used: Object.fromEntries(
      needed.filter((id) => prices[id]).map((id) => [id, { value: prices[id].value, metric: prices[id].metric }])
    ),
  };
  if (missing.length) {
    const body = finish(db, base, {
      refused: true,
      refuse_reason: `missing prices on ${platformId}: ${missing.join(", ")}`,
      bytes_read: null,
      bytes_written: null,
      lower_bound_ms: null,
      upper_bound_ms: null,
      report_ms: null,
      report: "refused",
      formula: "refused",
    });
    console.log(JSON.stringify(present(body), null, 2));
    return;
  }
  const rgb = colorspace === "rgb" ? 1 : 0;
  const report =
    prices.module_wall_base_ms.value +
    prices.module_wall_rgb_ms.value * rgb +
    prices.module_wall_extra_kernel_ms.value * (kernels - 1) +
    prices.module_wall_halo_ms.value * halo;
  const body = finish(db, base, {
    refused: false,
    refuse_reason: null,
    bytes_read: null,
    bytes_written: null,
    lower_bound_ms: report,
    upper_bound_ms: null,
    report_ms: report,
    report: "lower",
    formula: `${prices.module_wall_base_ms.value} + ${prices.module_wall_rgb_ms.value} * ${rgb} + ${prices.module_wall_extra_kernel_ms.value} * ${kernels - 1} + ${prices.module_wall_halo_ms.value} * ${halo}`,
  });
  console.log(JSON.stringify(present(body), null, 2));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  if (command === "init") return cmdInit();
  if (command === "prices") return cmdPrices();
  if (command === "shapes") return cmdShapes();
  if (command === "estimate") return cmdEstimate(opts);
  if (command === "audit") return cmdAudit(opts);
  if (command === "anchor") return cmdAnchor(opts);
  if (command === "anchors") return cmdAnchors();
  if (command === "price-set") return cmdPriceSet(opts);
  if (command === "module-set") return cmdModuleSet(opts);
  if (command === "check") return cmdCheck(opts);
  if (command === "ledger") return cmdLedger();
  if (command === "launch-fit") return cmdLaunchFit(opts);
  if (command === "accuracy") return cmdAccuracy();
  if (command === "wall-fit") return cmdWallFit(opts);
  if (command === "estimate-wall") return cmdEstimateWall(opts);
  if (command === "scan-iop") return require("./project_ledger").cmdScanIop(opts);
  if (command === "min-ledger") {
    return require("./project_ledger").cmdMinLedger(opts, { openDb, solveLinear, audit });
  }
  if (command === "discover") return require("./bringup.cjs").cmdDiscover();
  if (command === "run-probe") return require("./bringup.cjs").cmdRunProbe(opts);
  if (command === "commit-prices") return require("./bringup.cjs").cmdCommitPrices(opts);
  if (command === "plan-split") return require("./bringup.cjs").cmdPlanSplit(opts);
  if (command === "view") {
    require("./view").start(Number(opts.port || 8765));
    return;
  }
  throw new Error(
    "commands: init | prices | shapes | estimate | estimate-wall | audit | anchor | anchors | price-set | module-set | check | launch-fit | accuracy | wall-fit | ledger | scan-iop | min-ledger | discover | run-probe | commit-prices | plan-split | view"
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
