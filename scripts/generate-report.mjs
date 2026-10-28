// Generates a Markdown evidence report from all three signals:
//   traces  <- Jaeger      metrics <- Prometheus      logs <- Loki
// Any backend that is not reachable shows up as a gap in the report; it does not stop the report.
//
// Usage:   npm run report
//          npm run report -- --minutes 30 --out reports/my-report.md
// Env:     JAEGER_URL (default http://localhost:16686), PROM_URL (http://localhost:9090), LOKI_URL (http://localhost:3100),
//          LOOKBACK_MINUTES (60), TRACE_LIMIT (200), SERVICES (default "browser-poc,backend-poc")
//
// No dependencies: uses Node's built-in fetch (Node 18+).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------- config ----------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const JAEGER = (process.env.JAEGER_URL || 'http://localhost:16686').replace(/\/$/, '');
const PROM = (process.env.PROM_URL || 'http://localhost:9090').replace(/\/$/, '');
const LOKI = (process.env.LOKI_URL || 'http://localhost:3100').replace(/\/$/, '');
const MINUTES = Number(argVal('--minutes') || process.env.LOOKBACK_MINUTES || 60);
const LIMIT = Number(process.env.TRACE_LIMIT || 200);
const SERVICES = (process.env.SERVICES || 'browser-poc,backend-poc').split(',').map((s) => s.trim());
const BROWSER = SERVICES[0];
const BACKEND = SERVICES[1];

// ---------- helpers ---------------------------------------------------------
async function getJson(url, who = `Jaeger at ${JAEGER}`) {
  let res;
  try { res = await fetch(url); }
  catch (e) {
    throw new Error(`Cannot reach ${who} (${e.message}). Is "docker compose up" running?`);
  }
  if (!res.ok) throw new Error(`${who} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Prometheus instant query -> [{ metric: {labels}, value: number }]
async function promQuery(q) {
  const j = await getJson(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`, `Prometheus at ${PROM}`);
  if (j.status !== 'success') throw new Error(`Prometheus query failed: ${q}`);
  return j.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}
// Loki instant metric query -> [{ metric: {labels}, value: number }]
async function lokiQuery(q) {
  const j = await getJson(`${LOKI}/loki/api/v1/query?query=${encodeURIComponent(q)}`, `Loki at ${LOKI}`);
  return (j.data?.result || []).map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}
// Loki log lines -> [{ ts(ms), line, labels }], newest first
async function lokiLines(q, startNs, endNs, limit) {
  const u = `${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&limit=${limit}&direction=backward&start=${startNs}&end=${endNs}`;
  const j = await getJson(u, `Loki at ${LOKI}`);
  const out = [];
  for (const st of j.data?.result || []) for (const [ns, line] of st.values) out.push({ ts: Number(BigInt(ns) / 1000000n), line, labels: st.stream });
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

const tag = (span, key) => span.tags?.find((t) => t.key === key)?.value;
const ms = (us) => (us / 1000).toFixed(us >= 100000 ? 0 : 1);
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const isError = (span) => tag(span, 'error') === true || tag(span, 'error') === 'true' || tag(span, 'otel.status_code') === 'ERROR';
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) =>
  rows.length
    ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n')
    : '_No data._';

// ---------- run (clean error output) ----------------------------------------
try {
await main();
} catch (e) {
  console.error(`\nReport failed: ${e.message}`);
  process.exit(1);
}

async function main() {
// ---------- fetch traces ----------------------------------------------------
const endUs = Date.now() * 1000;
const startUs = endUs - MINUTES * 60 * 1000 * 1000;

let availableServices = [];
let jaegerError = null;
const byId = new Map();
try {
  availableServices = (await getJson(`${JAEGER}/api/services`)).data || [];
  for (const svc of SERVICES) {
    if (!availableServices.includes(svc)) continue;
    const url = `${JAEGER}/api/traces?service=${encodeURIComponent(svc)}&limit=${LIMIT}&start=${startUs}&end=${endUs}`;
    const { data = [] } = await getJson(url);
    for (const t of data) byId.set(t.traceID, t);
  }
} catch (e) { jaegerError = e.message; }
const traces = [...byId.values()];

// Flatten spans, attach service name
const spans = [];
for (const t of traces) {
  for (const s of t.spans) {
    spans.push({ ...s, service: t.processes[s.processID]?.serviceName ?? 'unknown', _trace: t });
  }
}

// ---------- analysis --------------------------------------------------------
const spansBy = (svc) => spans.filter((s) => s.service === svc);

// per service / operation stats
function opStats(svc) {
  const m = new Map();
  for (const s of spansBy(svc)) {
    const e = m.get(s.operationName) || { n: 0, d: [], err: 0 };
    e.n++; e.d.push(s.duration); if (isError(s)) e.err++;
    m.set(s.operationName, e);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([op, e]) => [op, e.n, ms(avg(e.d)), ms(pct(e.d, 0.95)), ms(Math.max(...e.d)), e.err]);
}

// cross-service traces (more than one service in the same trace)
const servicesInTrace = (t) => new Set(t.spans.map((x) => t.processes[x.processID]?.serviceName));
const crossTraces = traces
  .filter((t) => servicesInTrace(t).size > 1)
  .sort((a, b) => Math.max(...b.spans.map((s) => s.startTime)) - Math.max(...a.spans.map((s) => s.startTime)));

// is the backend's root span really a child of a browser span?
function linkedAcrossServices(t) {
  const ids = new Map(t.spans.map((s) => [s.spanID, s]));
  return t.spans.some((s) => {
    const parent = ids.get(s.references?.find((r) => r.refType === 'CHILD_OF')?.spanID);
    const svc = (x) => t.processes[x.processID]?.serviceName;
    return parent && svc(parent) !== svc(s);
  });
}

// tree rendering
function renderTree(t) {
  const byParent = new Map();
  const ids = new Set(t.spans.map((s) => s.spanID));
  for (const s of t.spans) {
    const p = s.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
    const key = p && ids.has(p) ? p : 'ROOT';
    (byParent.get(key) || byParent.set(key, []).get(key)).push(s);
  }
  const lines = [];
  const walk = (key, depth) => {
    for (const s of (byParent.get(key) || []).sort((a, b) => a.startTime - b.startTime)) {
      const svc = t.processes[s.processID]?.serviceName;
      lines.push(`${'  '.repeat(depth)}- **${svc}** \`${s.operationName}\` (${ms(s.duration)} ms)${isError(s) ? ' ❌ error' : ''}`);
      walk(s.spanID, depth + 1);
    }
  };
  walk('ROOT', 0);
  return lines.join('\n');
}

// errors
const errorSpans = spans.filter(isError).sort((a, b) => b.startTime - a.startTime);

// web vitals
const vitals = new Map();
for (const s of spans.filter((x) => x.operationName.startsWith('web-vital.')).sort((a, b) => a.startTime - b.startTime)) {
  const name = tag(s, 'web_vital.name') || s.operationName.replace('web-vital.', '');
  const v = vitals.get(name) || { n: 0, last: null, rating: null, ratings: {} };
  v.n++; v.last = tag(s, 'web_vital.value'); v.rating = tag(s, 'web_vital.rating');
  v.ratings[v.rating] = (v.ratings[v.rating] || 0) + 1;
  vitals.set(name, v);
}
const fmtVital = (name, v) => (name === 'CLS' ? Number(v).toFixed(3) : `${Math.round(v)} ms`);

// sessions
const sessions = new Set(spans.map((s) => tag(s, 'session.id')).filter(Boolean));
const spansWithSession = spans.filter((s) => s.service === BROWSER && tag(s, 'session.id')).length;
const browserSpans = spansBy(BROWSER);

// ---------- metrics (Prometheus) ---------------------------------------------
const total = (rows) => rows.reduce((a, r) => a + r.value, 0);
// Counters are cumulative, so "max value seen in the window" per series is the total for that window.
const W = `${MINUTES}m`;
const mx = (sel) => `max_over_time(${sel}[${W}])`;
const M = { up: [], clicks: [], errors: [], orders: [], httpCount: [], httpSum: [], vitals: new Map() };
let metricsError = null;
try {
  M.up = await promQuery('up{job="otel-collector"}');
  M.clicks = await promQuery(`sum by (button) (${mx('app_ui_clicks_total')})`);
  M.errors = await promQuery(`sum by (error_kind) (${mx('browser_errors_total')})`);
  M.orders = await promQuery(`sum by (tier) (${mx('app_orders_completed_total')})`);
  const httpBy = 'sum by (server_address, http_response_status_code)';
  M.httpCount = await promQuery(`${httpBy} (${mx('browser_http_client_duration_milliseconds_count')})`);
  M.httpSum = await promQuery(`${httpBy} (${mx('browser_http_client_duration_milliseconds_sum')})`);
  // one query per vital (range functions drop the metric name, so a single regex query would collide)
  for (const [name, base] of [['LCP', 'web_vital_lcp_milliseconds'], ['FCP', 'web_vital_fcp_milliseconds'], ['TTFB', 'web_vital_ttfb_milliseconds'], ['INP', 'web_vital_inp_milliseconds'], ['CLS', 'web_vital_cls']]) {
    const count = total(await promQuery(`sum (${mx(`${base}_count`)})`));
    if (!count) continue;
    M.vitals.set(name, { count, sum: total(await promQuery(`sum (${mx(`${base}_sum`)})`)) });
  }
} catch (e) { metricsError = e.message; }

// ---------- logs (Loki) ------------------------------------------------------
const nowNs = BigInt(Date.now()) * 1000000n;
const startNs = nowNs - BigInt(MINUTES) * 60n * 1000000000n;
const SEL = `{service_name="${BROWSER}"}`;
const LG = { levels: [], withTrace: 0, emailHits: [], recent: [] };
let logsError = null;
try {
  LG.levels = await lokiQuery(`sum by (detected_level) (count_over_time(${SEL}[${W}]))`);
  LG.withTrace = total(await lokiQuery(`sum (count_over_time(${SEL} | trace_id != "" [${W}]))`));
  LG.emailHits = await lokiLines(`${SEL} |~ "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}"`, startNs, nowNs, 5);
  LG.recent = await lokiLines(SEL, startNs, nowNs, 12);
} catch (e) { logsError = e.message; }
const logTotal = total(LG.levels);
const levelCount = (lv) => total(LG.levels.filter((r) => String(r.metric.detected_level).toLowerCase() === lv));

// ---------- verification checks ----------------------------------------------
const hasOp = (svc, name) => spansBy(svc).some((s) => s.operationName === name || s.operationName.startsWith(name));
const checks = [
  ['Browser service sends spans', browserSpans.length > 0, `${browserSpans.length} spans from \`${BROWSER}\``],
  ['Backend service sends spans', spansBy(BACKEND).length > 0, `${spansBy(BACKEND).length} spans from \`${BACKEND}\``],
  ['Page load captured (documentLoad)', hasOp(BROWSER, 'documentLoad'), ''],
  ['User clicks captured', hasOp(BROWSER, 'click'), ''],
  ['Fetch / XHR calls captured', hasOp(BROWSER, 'HTTP '), ''],
  ['Custom spans captured (checkout.submit)', hasOp(BROWSER, 'checkout.submit'), 'press button 4'],
  ['Error spans captured', errorSpans.length > 0, `${errorSpans.length} error span(s)`],
  ['Core Web Vitals captured', vitals.size > 0, vitals.size ? `${[...vitals.keys()].join(', ')}` : 'switch tabs / reload to trigger'],
  ['session.id present on browser spans', browserSpans.length > 0 && spansWithSession === browserSpans.length, `${spansWithSession}/${browserSpans.length} spans`],
  ['One trace spans browser AND backend', crossTraces.length > 0, `${crossTraces.length} cross-service trace(s)`],
  ['Backend span is a child of a browser span (context propagation)', crossTraces.some(linkedAcrossServices), 'proves traceparent worked'],
  // metrics
  ['Prometheus is scraping the collector', M.up.length > 0 && M.up.every((r) => r.value === 1), metricsError ? 'Prometheus not reachable' : `${M.up.length} target(s) up`],
  ['Click counter per button', M.clicks.length > 0, `${M.clicks.length} button(s), ${total(M.clicks)} clicks`],
  ['Custom business metric (app.orders.completed)', total(M.orders) > 0, total(M.orders) > 0 ? `${total(M.orders)} order(s) recorded` : 'press button 8'],
  ['HTTP client duration histogram (from fetch/XHR spans)', total(M.httpCount) > 0, `${total(M.httpCount)} call(s) across ${M.httpCount.length} series`],
  ['Core Web Vitals as histograms', M.vitals.size > 0, M.vitals.size ? [...M.vitals.keys()].join(', ') : 'switch tabs / reload to trigger'],
  // logs
  ['Loki has browser logs', logTotal > 0, logsError ? 'Loki not reachable' : `${logTotal} log record(s)`],
  ['Error-level log captured', levelCount('error') > 0, levelCount('error') > 0 ? `${levelCount('error')} error log(s)` : 'press button 6 or 7'],
  ['Logs correlated to traces (trace_id present)', LG.withTrace > 0, `${LG.withTrace} log(s) carry a trace id`],
  ['No e-mail addresses stored in logs (redaction)', logTotal > 0 && LG.emailHits.length === 0, logTotal ? `${LG.emailHits.length} match(es)` : 'no logs to check'],
];
const passed = checks.filter((c) => c[1]).length;

// ---------- build report -----------------------------------------------------
const now = new Date();
const stamp = now.toISOString();
const L = [];
L.push(`# OpenTelemetry POC: Evidence Report (traces, metrics, logs)`);
L.push('');
L.push(`Generated: ${stamp}  `);
L.push(`Sources: Jaeger \`${JAEGER}\` (traces), Prometheus \`${PROM}\` (metrics), Loki \`${LOKI}\` (logs)  `);
L.push(`Window: last ${MINUTES} minute(s) (up to ${LIMIT} traces per service)`);
L.push('');

for (const [name, err] of [['Jaeger (traces)', jaegerError], ['Prometheus (metrics)', metricsError], ['Loki (logs)', logsError]]) {
  if (err) { L.push(`> ⚠️ **${name} unavailable:** ${err}`); L.push(''); }
}
if (!traces.length && !jaegerError) {
  L.push('> **No traces found.** Open the app (http://localhost:5173), click the buttons, wait ~5 seconds, then run the report again.');
  L.push(`> Services Jaeger knows about: ${availableServices.length ? availableServices.map((s) => `\`${s}\``).join(', ') : '_none_'}.`);
  L.push('');
}

L.push(`## 1. Verification checklist (${passed}/${checks.length} passed)`);
L.push('');
L.push(table(['Check', 'Result', 'Detail'], checks.map(([n, ok, d]) => [n, ok ? '✅ pass' : '❌ not seen', d])));
L.push('');

L.push('## 2. Summary');
L.push('');
L.push(table(['Metric', 'Value'], [
  ['Traces', traces.length],
  ['Spans (total)', spans.length],
  [`Spans from ${BROWSER}`, browserSpans.length],
  [`Spans from ${BACKEND}`, spansBy(BACKEND).length],
  ['Cross-service traces', crossTraces.length],
  ['Error spans', errorSpans.length],
  ['Distinct browser sessions', sessions.size],
  ['Log records in window', logTotal],
  ['Metric series: HTTP duration', M.httpCount.length],
]));
L.push('');

for (const svc of SERVICES) {
  L.push(`## 3. Operations: ${svc}`);
  L.push('');
  L.push(table(['Operation', 'Count', 'Avg ms', 'p95 ms', 'Max ms', 'Errors'], opStats(svc)));
  L.push('');
}

L.push('## 4. Distributed trace example (browser → backend)');
L.push('');
if (crossTraces.length) {
  const t = crossTraces[0];
  L.push(`Most recent cross-service trace: \`${t.traceID}\` ([open in Jaeger](${JAEGER}/trace/${t.traceID}))`);
  L.push('');
  L.push(renderTree(t));
  L.push('');
  L.push(`Context propagation: ${linkedAcrossServices(t) ? '✅ the backend span is a child of a browser span (same trace ID).' : '❌ the services share a trace but no parent link was found.'}`);
} else {
  L.push('_None yet. Click **button 2** in the app (with the backend running), then rerun the report._');
}
L.push('');

L.push('## 5. Errors');
L.push('');
L.push(table(['Time (UTC)', 'Service', 'Operation', 'Message'],
  errorSpans.slice(0, 15).map((s) => [
    new Date(s.startTime / 1000).toISOString().replace('T', ' ').slice(0, 19),
    s.service, s.operationName, tag(s, 'otel.status_description') || '',
  ])));
L.push('');

L.push('## 6. Core Web Vitals');
L.push('');
L.push(table(['Metric', 'Samples', 'Latest', 'Rating (latest)', 'Rating counts'],
  [...vitals.entries()].map(([n, v]) => [n, v.n, fmtVital(n, v.last), v.rating, Object.entries(v.ratings).map(([k, c]) => `${k}: ${c}`).join(', ')])));
L.push('');

L.push('## 7. Sessions');
L.push('');
L.push(`${sessions.size} distinct \`session.id\` value(s) seen. Each browser tab session gets one random ID, so spans from one visit can be grouped together.`);
L.push('');

L.push('## 8. Metrics (Prometheus)');
L.push('');
L.push('Values are the highest cumulative value seen per series in the window.');
L.push('');
L.push('**Clicks per button**');
L.push('');
L.push(table(['Button', 'Clicks'], M.clicks.sort((a, b) => b.value - a.value).map((r) => [r.metric.button, r.value])));
L.push('');
L.push('**Errors and business metrics**');
L.push('');
L.push(table(['Metric', 'Label', 'Value'], [
  ...M.errors.map((r) => ['browser.errors', r.metric.error_kind, r.value]),
  ...M.orders.map((r) => ['app.orders.completed', `tier=${r.metric.tier}`, r.value]),
]));
L.push('');
L.push('**HTTP client calls (fetch/XHR)**');
L.push('');
const httpSumByKey = new Map(M.httpSum.map((r) => [`${r.metric.server_address}|${r.metric.http_response_status_code}`, r.value]));
L.push(table(['Host', 'Status', 'Calls', 'Avg ms'], M.httpCount.sort((a, b) => b.value - a.value).map((r) => {
  const sum = httpSumByKey.get(`${r.metric.server_address}|${r.metric.http_response_status_code}`);
  return [r.metric.server_address, r.metric.http_response_status_code, r.value, sum !== undefined && r.value ? (sum / r.value).toFixed(1) : ''];
})));
L.push('');
L.push('**Core Web Vitals (histograms)**');
L.push('');
L.push(table(['Vital', 'Samples', 'Mean'], [...M.vitals.entries()].map(([n, v]) => [n, v.count, v.count ? fmtVital(n, v.sum / v.count) : ''])));
L.push('');

L.push('## 9. Logs (Loki)');
L.push('');
L.push(table(['Level', 'Records'], LG.levels.sort((a, b) => b.value - a.value).map((r) => [r.metric.detected_level || 'unknown', r.value])));
L.push('');
L.push(`Trace correlation: ${LG.withTrace} of ${logTotal} log record(s) carry a \`trace_id\`. Redaction check: ${LG.emailHits.length} stored line(s) contain an e-mail address.`);
L.push('');
L.push('**Most recent log records**');
L.push('');
L.push(table(['Time (UTC)', 'Level', 'Message'], LG.recent.map((x) => [new Date(x.ts).toISOString().replace('T', ' ').slice(0, 19), x.labels.detected_level || '', x.line.slice(0, 120)])));
L.push('');

L.push('## 10. Notes');
L.push('');
L.push('- Durations come from span start/end times recorded in the browser and backend.');
L.push('- Jaeger in this POC keeps data in memory only: stopping Docker clears it. Run this report before shutting down.');
L.push('- Browser instrumentation in OpenTelemetry JS is still experimental upstream; see `docs/FINDINGS.md`.');
L.push('- Prometheus and Loki in this POC keep data only as long as the containers live (Loki and Prometheus here have no volumes).');
L.push('- Browser counters are cumulative per tab: a page reload restarts them, and several simultaneous browsers would share one series. See `docs/LOGS-AND-METRICS.md`.');
L.push('');

// ---------- write ----------------------------------------------------------
const outArg = argVal('--out');
const file = outArg || path.join('reports', `otel-report-${stamp.replace(/[:.]/g, '-').slice(0, 19)}.md`);
await mkdir(path.dirname(file), { recursive: true });
const body = L.join('\n');
await writeFile(file, body);
if (!outArg) await writeFile(path.join('reports', 'latest.md'), body);

console.log(`Report written: ${file}`);
console.log(`Checks passed: ${passed}/${checks.length} | traces: ${traces.length} | spans: ${spans.length} | cross-service traces: ${crossTraces.length} | log records: ${logTotal}`);
for (const [name, err] of [['Jaeger', jaegerError], ['Prometheus', metricsError], ['Loki', logsError]]) if (err) console.log(`WARNING: ${name} unavailable (${err.split('(')[0].trim()})`);
}
