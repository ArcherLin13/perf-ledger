const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = path.join(__dirname, "perfexpert.sqlite");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ms(value) {
  if (value === null || value === undefined || value === "") return "";
  return (Math.round(Number(value) * 1000) / 1000).toString();
}

function table(headers, rows) {
  const head = headers.map((header) => `<th>${esc(header.label)}</th>`).join("");
  const body = rows.length
    ? rows
        .map(
          (row) =>
            `<tr>${headers
              .map((header) => `<td>${esc(header.value(row))}</td>`)
              .join("")}</tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="${headers.length}">还没有记录</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Group the flat audit log into campaigns: rows that carry detail.catalog
// belong to that catalog's campaign; the rest are platform-level events.
function timelineGroups(auditRowsAsc) {
  const groups = new Map();
  for (const row of auditRowsAsc) {
    let detail = {};
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = {};
    }
    const key = typeof detail.catalog === "string" && detail.catalog ? detail.catalog : "";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: key ? key.split("/").pop() : "平台层（无 catalog）",
        sha: null,
        rows: [],
        first: row.created_at,
        last: row.created_at,
      };
      groups.set(key, group);
    }
    if (detail.catalog_sha) group.sha = String(detail.catalog_sha).slice(0, 8);
    group.rows.push(row);
    group.last = row.created_at;
  }
  const list = [...groups.values()];
  const labelCount = new Map();
  for (const group of list) labelCount.set(group.label, (labelCount.get(group.label) || 0) + 1);
  for (const group of list) {
    if (group.key && labelCount.get(group.label) > 1) {
      group.label = group.key.split("/").slice(-2).join("/");
    }
  }
  return list;
}

function timelineTable(groups) {
  if (!groups.length) {
    return `<table><tbody><tr class="empty-row"><td colspan="3">还没有记录</td></tr></tbody></table>`;
  }
  const rows = [];
  for (const group of groups) {
    const sha = group.sha ? ` @${group.sha}` : "";
    const firstDay = group.first.slice(0, 10);
    const lastDay = group.last.slice(0, 10);
    const span = firstDay === lastDay ? firstDay : `${firstDay} → ${lastDay}`;
    rows.push(
      `<tr class="group-row"><td colspan="3">${esc(group.label)}${esc(sha)} · ${group.rows.length} 条 · ${esc(span)}</td></tr>`
    );
    for (const row of group.rows) {
      rows.push(
        `<tr><td>${esc(row.created_at)}</td><td>${esc(row.action)}</td><td>${esc(summarize(row, false))}</td></tr>`
      );
    }
  }
  return `<table><thead><tr><th>时间</th><th>动作</th><th>摘要</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function page() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const prices = db.prepare("SELECT * FROM prices ORDER BY platform_id, price_id").all();
  const modules = db.prepare("SELECT * FROM module_prices ORDER BY id DESC").all();
  const checks = db.prepare("SELECT * FROM scenario_checks ORDER BY id DESC").all();
  const shapes = db.prepare("SELECT * FROM shapes ORDER BY id").all();
  const estimates = db.prepare("SELECT * FROM estimates ORDER BY id DESC").all();
  const anchors = db.prepare("SELECT * FROM anchors ORDER BY id DESC").all();
  const audit = db.prepare("SELECT * FROM audit ORDER BY id DESC").all();
  db.close();

  const sections = [
    {
      id: "timeline",
      title: "战役时间线",
      count: audit.length,
      body: timelineTable(timelineGroups([...audit].reverse())),
    },
    {
      id: "prices",
      title: "平台单价",
      count: prices.length,
      body: table(
        [
          { label: "平台", value: (row) => row.platform_id },
          { label: "单价", value: (row) => row.price_id },
          { label: "数值", value: (row) => row.value },
          { label: "指标", value: (row) => row.metric },
          { label: "适用", value: (row) => row.valid_when },
          { label: "来源", value: (row) => row.source_record },
        ],
        prices
      ),
    },
    {
      id: "modules",
      title: "模块单价",
      count: modules.length,
      body: table(
        [
          { label: "id", value: (row) => row.id },
          { label: "模块", value: (row) => row.module_id },
          { label: "平台", value: (row) => row.platform_id },
          { label: "形状", value: (row) => row.shape },
          { label: "单位", value: (row) => row.unit },
          { label: "单价", value: (row) => ms(row.value) },
          { label: "实测 ms", value: (row) => ms(row.measured_ms) },
          { label: "像素", value: (row) => row.pixels },
          { label: "遍数", value: (row) => row.passes },
          { label: "当前有效", value: (row) => (row.active ? "是" : "否") },
        ],
        modules
      ),
    },
    {
      id: "checks",
      title: "场景核对",
      count: checks.length,
      body: table(
        [
          { label: "id", value: (row) => row.id },
          { label: "场景", value: (row) => row.scenario_id },
          { label: "平台", value: (row) => row.platform_id },
          { label: "预测 ms", value: (row) => ms(row.predicted_ms) },
          { label: "实测 ms", value: (row) => ms(row.measured_ms) },
          { label: "残差", value: (row) => Number(row.residual_ratio).toFixed(3) },
          { label: "结论", value: (row) => row.verdict },
        ],
        checks
      ),
    },
    {
      id: "shapes",
      title: "形状",
      count: shapes.length,
      body: table(
        [
          { label: "形状", value: (row) => row.id },
          { label: "可以计价", value: (row) => (row.can_price ? "是" : "否") },
          { label: "计数规则", value: (row) => row.counting_rule },
        ],
        shapes
      ),
    },
    {
      id: "estimates",
      title: "估算",
      count: estimates.length,
      body: table(
        [
          { label: "id", value: (row) => row.id },
          { label: "时间", value: (row) => row.created_at },
          { label: "形状", value: (row) => row.shape },
          { label: "写法", value: (row) => row.access },
          { label: "尺寸", value: (row) => (row.width ? `${row.width}×${row.height}` : "") },
          { label: "结论", value: (row) => row.report },
          { label: "报告 ms", value: (row) => ms(row.report_ms) },
          { label: "下限 ms", value: (row) => ms(row.lower_bound_ms) },
          { label: "上限 ms", value: (row) => ms(row.upper_bound_ms) },
          { label: "公式", value: (row) => row.formula },
        ],
        estimates
      ),
    },
    {
      id: "anchors",
      title: "锚点",
      count: anchors.length,
      body: table(
        [
          { label: "id", value: (row) => row.id },
          { label: "估算", value: (row) => row.estimate_id },
          { label: "实测 ms", value: (row) => ms(row.measured_ms) },
          { label: "报告 ms", value: (row) => ms(row.report_ms) },
          { label: "残差", value: (row) => Number(row.residual_ratio).toFixed(3) },
          { label: "结论", value: (row) => row.verdict },
          { label: "来源", value: (row) => row.source_record },
        ],
        anchors
      ),
    },
    {
      id: "audit",
      title: "审计",
      count: audit.length,
      body: table(
        [
          { label: "id", value: (row) => row.id },
          { label: "时间", value: (row) => row.created_at },
          { label: "动作", value: (row) => row.action },
          { label: "估算", value: (row) => row.estimate_id },
          { label: "摘要", value: (row) => summarize(row) },
        ],
        audit
      ),
    },
  ];

  const tabs = sections
    .map(
      (section, index) =>
        `<button data-tab="${section.id}"${index === 0 ? ' class="active"' : ""}>${esc(
          section.title
        )} <span class="count">${section.count}</span></button>`
    )
    .join("");
  const panels = sections
    .map(
      (section, index) =>
        `<section class="panel${index === 0 ? " active" : ""}" data-panel="${section.id}">${section.body}</section>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>老师傅数据库</title>
  <style>
    body { margin: 24px auto; max-width: 1100px; font: 15px/1.45 system-ui, sans-serif; color: #1c1c1c; padding: 0 16px; }
    header { position: sticky; top: 0; background: #fff; padding: 8px 0 0; border-bottom: 1px solid #eee; z-index: 1; }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 4px; }
    p { color: #555; margin: 0 0 12px; }
    #q { width: 100%; box-sizing: border-box; padding: 8px 12px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 10px; }
    #q:focus { outline: 2px solid #7aa7ff; outline-offset: -1px; }
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; }
    .tabs button { border: 1px solid #ddd; border-bottom: none; background: #f4f4f4; border-radius: 6px 6px 0 0; padding: 6px 12px; font-size: 13px; cursor: pointer; color: #444; }
    .tabs button:hover { background: #ececec; }
    .tabs button.active { background: #fff; color: #111; font-weight: 650; }
    .count { font-size: 11px; color: #777; margin-left: 4px; }
    .count.dim { color: #ccc; }
    .panel { display: none; padding: 12px 0 24px; }
    .panel.active { display: block; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #ddd; padding: 6px 8px; }
    th { font-size: 12px; color: #555; font-weight: 650; }
    td { font-variant-numeric: tabular-nums; }
    .empty-row td { color: #999; }
    .group-row td { background: #f0f0f0; font-weight: 650; font-size: 12px; color: #444; }
    code { font-family: ui-monospace, monospace; font-size: 12px; }
  </style>
  <noscript><style>.panel { display: block; }</style></noscript>
</head>
<body>
  <header>
    <h1>老师傅数据库</h1>
    <p>只读页面，数据来自 expert/perfexpert.sqlite。搜索框一次过滤所有 tab，按 / 聚焦。</p>
    <input id="q" type="search" placeholder="搜索全部表… 按 / 聚焦" autocomplete="off">
    <nav class="tabs">${tabs}</nav>
  </header>
${panels}
  <script>
    var buttons = Array.prototype.slice.call(document.querySelectorAll(".tabs button"));
    var panels = Array.prototype.slice.call(document.querySelectorAll(".panel"));
    var q = document.getElementById("q");

    function activate(name) {
      buttons.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });
      panels.forEach(function (p) { p.classList.toggle("active", p.dataset.panel === name); });
    }
    buttons.forEach(function (b) {
      b.addEventListener("click", function () { activate(b.dataset.tab); });
    });

    function applyFilter() {
      var needle = q.value.trim().toLowerCase();
      panels.forEach(function (p, index) {
        var rows = Array.prototype.slice.call(p.querySelectorAll("tbody tr"));
        var total = 0;
        var shown = 0;
        rows.forEach(function (r) {
          if (r.classList.contains("empty-row")) return;
          total += 1;
          var hit = !needle || r.textContent.toLowerCase().indexOf(needle) !== -1;
          r.style.display = hit ? "" : "none";
          if (hit) shown += 1;
        });
        var badge = buttons[index].querySelector(".count");
        badge.textContent = needle ? shown + "/" + total : String(total);
        badge.classList.toggle("dim", !!needle && shown === 0);
      });
    }
    q.addEventListener("input", applyFilter);

    document.addEventListener("keydown", function (event) {
      if (event.key === "/" && document.activeElement !== q) {
        event.preventDefault();
        q.focus();
      }
    });
  </script>
</body>
</html>`;
}

function shortRef(detail) {
  const base = detail.catalog ? String(detail.catalog).split("/").pop() : null;
  const sha = detail.catalog_sha ? String(detail.catalog_sha).slice(0, 8) : null;
  if (base && sha) return `${base}@${sha}`;
  if (base) return base;
  if (sha) return `@${sha}`;
  return "";
}

function summarize(row, includeRef = true) {
  const detail = JSON.parse(row.detail);
  const ref = shortRef(detail);
  const at = includeRef && ref ? `${ref} ` : "";
  if (row.action === "estimate") {
    const text = detail.refused
      ? `拒绝 ${detail.shape}：${detail.refuse_reason}`
      : `${detail.shape} ${detail.report} ${detail.report_ms ?? ""}`.trim();
    return at + text;
  }
  if (row.action === "anchor") return `${at}${detail.verdict} 残差 ${Number(detail.residual_ratio).toFixed(3)}`;
  if (row.action === "init") return detail.platform_id;
  if (row.action === "freeze_tests") {
    return detail.frozen
      ? `${at}冻结 ${detail.freeze.test_ids.length} 题`
      : `${at}拒冻（缺口未补齐）`;
  }
  if (row.action === "score") {
    return `${at}${detail.verdict} 实测 ${detail.measured_n}/${detail.test_n}`;
  }
  if (row.action === "exam_predict") {
    return detail.sealed
      ? `${at}封 ${detail.item} ${ms(detail.report_ms)}ms`
      : `${at}拒封 ${detail.item}（${detail.reason}）`;
  }
  if (row.action === "exam_score") {
    return `${at}${detail.item} ${detail.verdict} 准确率 ${Number(detail.accuracy).toFixed(3)}`;
  }
  if (row.action === "run_probe") {
    return detail.ok ? `探针 ${detail.backend} 成功` : `探针 ${detail.backend} 受阻 ${detail.blocked}`;
  }
  if (row.action === "commit_prices") {
    return `写价 ${detail.platform_id}：成功 ${detail.written.length} 跳过 ${detail.skipped.length}`;
  }
  if (row.action === "plan_split") {
    return `划分 训 ${detail.train.length} 考 ${detail.test.length} 认领 ${detail.claimed.length} 测量预算 ${detail.exam_budget_runs}`;
  }
  if (row.action === "scan_iop") {
    const by = detail.by_decision || {};
    return `扫描 ${detail.files} 文件：可计价 ${by.module_wall || 0} 分支 ${by.needs_branch || 0} 拒绝 ${by.refuse || 0}`;
  }
  if (row.action === "annotate_features") return `特征标注 ${detail.modules.length} 模块`;
  if (row.action === "measure_module") {
    if (!detail.metric) return `测量 ${detail.module} 受阻 ${detail.blocked}`;
    const dup = detail.dedup === "skipped_write" ? "（去重未写盘）" : "";
    return `测量 ${detail.module} ${detail.metric.status} ${ms(detail.metric.median)}ms${dup}`;
  }
  if (row.action === "run_template") {
    if (!detail.metric) return `模板 ${detail.shape}×${detail.n} 受阻 ${detail.blocked}`;
    const dup = detail.dedup === "skipped_write" ? "（去重未写盘）" : "";
    return `模板 ${detail.shape}×${detail.n} ${detail.metric.status} ${ms(detail.metric.median)}ms${dup}`;
  }
  if (row.action === "min_ledger") {
    const ambiguous = detail.model_ambiguous ? "（模型歧义）" : "";
    return `最小账本 ${detail.minimum_measurements} 条训练：${detail.formula}${ambiguous}`;
  }
  if (row.action === "bump_sha") {
    const prev = detail.previous_sha ? String(detail.previous_sha).slice(0, 8) : "（无）";
    const next = detail.sha ? String(detail.sha).slice(0, 8) : "（无）";
    return `sha ${prev} → ${next}，${(detail.stale_after_bump || []).length} 条转 stale`;
  }
  if (row.action === "launch_fit") {
    const file = detail.record ? String(detail.record).split("/").pop() : "";
    const shared = detail.shared_fixed ? `，共享固定开销 ${ms(detail.shared_fixed.fixed_ms)}ms` : "";
    return `发射拟合 ${file}：${Object.keys(detail.kernels || {}).length} 个 kernel${shared}`;
  }
  if (row.action === "wall_fit") {
    return `墙上拟合 base ${ms(detail.base_ms)} + rgb ${ms(detail.rgb_ms)} + 额外kernel ${ms(detail.extra_kernel_ms)} + halo ${ms(detail.halo_ms)}`;
  }
  if (row.action === "platform_price") {
    return `单价 ${detail.platform_id} ${detail.price_id} = ${detail.value}`;
  }
  if (row.action === "module_price") {
    return `模块价 ${detail.module_id} = ${ms(detail.value)} ${detail.unit}`;
  }
  if (row.action === "scenario_check") {
    return `核对 ${detail.scenario_id} ${detail.verdict} 残差 ${Number(detail.residual_ratio).toFixed(3)}`;
  }
  return at + row.action;
}

function start(port) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page());
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error.message);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}

if (require.main === module) start(Number(process.argv[2] || 8765));

module.exports = { start };
