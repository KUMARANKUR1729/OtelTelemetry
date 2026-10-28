# OpenTelemetry POC: Evidence Report (traces, metrics, logs)

Generated: 2026-10-27T10:20:59.980Z  
Sources: Jaeger `http://localhost:16686` (traces), Prometheus `http://localhost:9090` (metrics), Loki `http://localhost:3100` (logs)  
Window: last 60 minute(s) (up to 200 traces per service)

## 1. Verification checklist (20/20 passed)

| Check | Result | Detail |
| --- | --- | --- |
| Browser service sends spans | ✅ pass | 160 spans from `browser-poc` |
| Backend service sends spans | ✅ pass | 3 spans from `backend-poc` |
| Page load captured (documentLoad) | ✅ pass |  |
| User clicks captured | ✅ pass |  |
| Fetch / XHR calls captured | ✅ pass |  |
| Custom spans captured (checkout.submit) | ✅ pass | press button 4 |
| Error spans captured | ✅ pass | 2 error span(s) |
| Core Web Vitals captured | ✅ pass | FCP, TTFB, CLS, LCP, INP |
| session.id present on browser spans | ✅ pass | 160/160 spans |
| One trace spans browser AND backend | ✅ pass | 1 cross-service trace(s) |
| Backend span is a child of a browser span (context propagation) | ✅ pass | proves traceparent worked |
| Prometheus is scraping the collector | ✅ pass | 1 target(s) up |
| Click counter per button | ✅ pass | 8 button(s), 11 clicks |
| Custom business metric (app.orders.completed) | ✅ pass | 4 order(s) recorded |
| HTTP client duration histogram (from fetch/XHR spans) | ✅ pass | 3 call(s) across 2 series |
| Core Web Vitals as histograms | ✅ pass | LCP, FCP, TTFB, INP, CLS |
| Loki has browser logs | ✅ pass | 9 log record(s) |
| Error-level log captured | ✅ pass | 2 error log(s) |
| Logs correlated to traces (trace_id present) | ✅ pass | 5 log(s) carry a trace id |
| No e-mail addresses stored in logs (redaction) | ✅ pass | 0 match(es) |

## 2. Summary

| Metric | Value |
| --- | --- |
| Traces | 37 |
| Spans (total) | 163 |
| Spans from browser-poc | 160 |
| Spans from backend-poc | 3 |
| Cross-service traces | 1 |
| Error spans | 2 |
| Distinct browser sessions | 1 |
| Log records in window | 9 |
| Metric series: HTTP duration | 2 |

## 3. Operations: browser-poc

| Operation | Count | Avg ms | p95 ms | Max ms | Errors |
| --- | --- | --- | --- | --- | --- |
| resourceFetch | 114 | 36.3 | 145 | 186 | 0 |
| click | 22 | 11.5 | 1.5 | 247 | 0 |
| documentLoad | 3 | 212 | 416 | 416 | 0 |
| documentFetch | 3 | 24.7 | 47.7 | 47.7 | 0 |
| web-vital.TTFB | 3 | 0.0 | 0.0 | 0.0 | 0 |
| web-vital.FCP | 2 | 0.2 | 0.4 | 0.4 | 0 |
| web-vital.CLS | 2 | 0.1 | 0.1 | 0.1 | 0 |
| web-vital.LCP | 2 | 0.1 | 0.2 | 0.2 | 0 |
| HTTP GET | 2 | 194 | 290 | 290 | 0 |
| browser.error | 1 | 0.2 | 0.2 | 0.2 | 1 |
| web-vital.INP | 1 | 0.1 | 0.1 | 0.1 | 0 |
| checkout.payment | 1 | 306 | 306 | 306 | 0 |
| checkout.submit | 1 | 509 | 509 | 509 | 0 |
| risky.operation | 1 | 0.6 | 0.6 | 0.6 | 1 |
| logs.demo | 1 | 0.5 | 0.5 | 0.5 | 0 |
| GET | 1 | 246 | 246 | 246 | 0 |

## 3. Operations: backend-poc

| Operation | Count | Avg ms | p95 ms | Max ms | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | 1 | 83.4 | 83.4 | 83.4 | 0 |
| db.query.simulated | 1 | 81.7 | 81.7 | 81.7 | 0 |
| OPTIONS | 1 | 4.8 | 4.8 | 4.8 | 0 |

## 4. Distributed trace example (browser → backend)

Most recent cross-service trace: `0fd7b105a1e62425b7f6c9e34df07dee` ([open in Jaeger](http://localhost:16686/trace/0fd7b105a1e62425b7f6c9e34df07dee))

- **browser-poc** `click` (0.5 ms)
  - **browser-poc** `HTTP GET` (97.0 ms)
    - **backend-poc** `GET` (83.4 ms)
      - **backend-poc** `db.query.simulated` (81.7 ms)

Context propagation: ✅ the backend span is a child of a browser span (same trace ID).

## 5. Errors

| Time (UTC) | Service | Operation | Message |
| --- | --- | --- | --- |
| 2026-10-27 10:04:49 | browser-poc | browser.error | Unhandled demo error |
| 2026-10-27 10:04:48 | browser-poc | risky.operation | Simulated failure |

## 6. Core Web Vitals

| Metric | Samples | Latest | Rating (latest) | Rating counts |
| --- | --- | --- | --- | --- |
| FCP | 2 | 72 ms | good | good: 2 |
| TTFB | 3 | 25 ms | good | good: 3 |
| CLS | 2 | 0.000 | good | good: 2 |
| LCP | 2 | 72 ms | good | good: 2 |
| INP | 1 | 0 ms | good | good: 1 |

## 7. Sessions

1 distinct `session.id` value(s) seen. Each browser tab session gets one random ID, so spans from one visit can be grouped together.

## 8. Metrics (Prometheus)

Values are the highest cumulative value seen per series in the window.

**Clicks per button**

| Button | Clicks |
| --- | --- |
| btn-metrics | 4 |
| btn-backend | 1 |
| btn-custom | 1 |
| btn-error | 1 |
| btn-logs | 1 |
| btn-public | 1 |
| btn-unhandled | 1 |
| btn-xhr | 1 |

**Errors and business metrics**

| Metric | Label | Value |
| --- | --- | --- |
| browser.errors | browser.error | 1 |
| app.orders.completed | tier=large | 4 |

**HTTP client calls (fetch/XHR)**

| Host | Status | Calls | Avg ms |
| --- | --- | --- | --- |
| jsonplaceholder.typicode.com | 200 | 2 | 268.0 |
| localhost:3000 | 200 | 1 | 103.0 |

**Core Web Vitals (histograms)**

| Vital | Samples | Mean |
| --- | --- | --- |
| LCP | 1 | 72 ms |
| FCP | 1 | 72 ms |
| TTFB | 1 | 25 ms |
| INP | 1 | 8 ms |
| CLS | 1 | 0.000 |

## 9. Logs (Loki)

| Level | Records |
| --- | --- |
| info | 5 |
| error | 2 |
| warn | 2 |

Trace correlation: 5 of 9 log record(s) carry a `trace_id`. Redaction check: 0 stored line(s) contain an e-mail address.

**Most recent log records**

| Time (UTC) | Level | Message |
| --- | --- | --- |
| 2026-10-27 10:18:38 | info | telemetry initialised |
| 2026-10-27 10:04:50 | warn | payment provider slow, retrying |
| 2026-10-27 10:04:50 | error | payment failed for user [email] |
| 2026-10-27 10:04:50 | info | log outside any span (no trace id) |
| 2026-10-27 10:04:50 | warn | console.warn is captured as a log record too |
| 2026-10-27 10:04:50 | info | user opened the logs demo |
| 2026-10-27 10:04:49 | error | Unhandled: Unhandled demo error |
| 2026-10-27 10:04:13 | info | telemetry initialised |
| 2026-10-27 10:04:12 | info | telemetry initialised |

## 10. Notes

- Durations come from span start/end times recorded in the browser and backend.
- Jaeger in this POC keeps data in memory only: stopping Docker clears it. Run this report before shutting down.
- Browser instrumentation in OpenTelemetry JS is still experimental upstream; see `docs/FINDINGS.md`.
- Prometheus and Loki in this POC keep data only as long as the containers live (Loki and Prometheus here have no volumes).
- Browser counters are cumulative per tab: a page reload restarts them, and several simultaneous browsers would share one series. See `docs/LOGS-AND-METRICS.md`.
