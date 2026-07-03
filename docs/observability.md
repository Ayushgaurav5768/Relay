# Relay Observability Guide

## Architecture

```
Prometheus (5s scrapes)
  ├── ingest:3001/metrics
  ├── delivery-worker:3002/metrics
  └── dashboard-api:3003/metrics
        ↓
    Grafana (auto-provisioned dashboard, 5s refresh)
```

Prometheus retains 7 days of metrics. Grafana is preconfigured with the Prometheus datasource and the Relay Overview dashboard — no manual import needed.

---

## Metrics Reference

### `events_ingested_total`
| Field | Value |
|---|---|
| Type | Counter |
| Labels | `destination_id` |
| Source | Ingest service |
| Description | Total events received via `POST /events`. Incremented on successful validation + idempotency check, before outbox insert. |

**Alert**: _None directly._ A drop to zero for 5m may indicate an upstream producer issue — page on-call if the service-level agreement requires event flow.

---

### `events_delivered_total`
| Field | Value |
|---|---|
| Type | Counter |
| Labels | `destination_id` |
| Source | Delivery Worker |
| Description | Total events successfully delivered (HTTP 2xx to customer webhook). |

**Alert**: If `delivery_success_rate < 99%` over 5m → warning. If `< 90%` → page. Success rate uses the formula:

```
rate(events_delivered_total[5m])
---------------------------------------- × 100
rate(events_delivered_total[5m]) + rate(events_failed_total[5m])
```

---

### `events_failed_total`
| Field | Value |
|---|---|
| Type | Counter |
| Labels | `destination_id` |
| Source | Delivery Worker |
| Description | Total delivery attempts that returned a non-2xx HTTP status or timed out. A single event may increment this multiple times (retries). |

---

### `events_dlq_total`
| Field | Value |
|---|---|
| Type | Counter |
| Labels | `destination_id` |
| Source | Delivery Worker |
| Description | Total events moved to the Dead Letter Queue after exhausting all retries (MAX_ATTEMPTS = 8). Each DLQ'd event produced exactly one increment. |

**Alert**: `rate(events_dlq_total[5m]) > 0` or DLQ rate as a fraction of ingestion rate > 1% over 5m → page on-call. DLQ indicates a destination is permanently unreachable or rejecting valid payloads.

```
sum(rate(events_dlq_total[5m]))
-----------------------------  > 0.01  →  PAGE
sum(rate(events_ingested_total[5m]))
```

---

### `delivery_attempt_duration_seconds`
| Field | Value |
|---|---|
| Type | Histogram |
| Labels | `destination_id`, `status` (`success`/`failed`) |
| Buckets | 10ms, 50ms, 100ms, 500ms, 1s, 2s, 5s, 10s, 30s |
| Source | Delivery Worker |
| Description | Round-trip latency for each outbound HTTP POST to the customer webhook. Measured from just before `request()` to just after response headers received. |

**Alert**:
- p99 > 5s over 5m → warning (latency spike)
- p99 > 10s over 5m → page (destinations are timing out; investigate network/destination health)

These percentiles are computed as:

```
histogram_quantile(0.99, sum(rate(delivery_attempt_duration_seconds_bucket[5m])) by (le, destination_id))
```

---

### `circuit_breaker_state`
| Field | Value |
|---|---|
| Type | Gauge |
| Labels | `destination_id`, `state` (`closed`, `half_open`, `open`) |
| Source | Delivery Worker (collected every 10s via Redis KEYS) |
| Description | Current circuit breaker state per destination. At any moment, exactly one state-label per destination has value `1`; the other two are `0`. |

| Value | Meaning | Color |
|---|---|---|
| `closed` | Healthy — requests pass through | Green |
| `half_open` | Probing — one request allowed to test recovery | Orange |
| `open` | Failing — requests blocked, cooldown active | Red |

**Alert**: `circuit_breaker_state{state="open"} == 1` for any destination for > 30s → page. A circuit breaker should trip closed within seconds of the destination recovering; sustained OPEN state indicates ongoing failure.

---

### `queue_depth`
| Field | Value |
|---|---|
| Type | Gauge |
| Labels | `destination_id` |
| Source | Delivery Worker (collected every 15s via `channel.checkQueue()`) |
| Description | Number of messages pending in the per-destination RabbitMQ queue. |

**Alert**: `queue_depth > 1000` for > 5m → warning. The queue should drain faster than it fills under normal load. Sustained growth suggests the delivery worker cannot keep up (scale horizontally or investigate destination latency).

---

## Grafana Dashboard

The provisioned dashboard (`infra/grafana/dashboards/relay-overview.json`) is automatically loaded at Grafana startup. It contains:

| Panel | Metric(s) | Type |
|---|---|---|
| Ingestion Rate | `events_ingested_total` | Time series |
| Delivery Success Rate | `events_delivered_total`, `events_failed_total` | Stat (percentage) |
| DLQ Rate | `events_dlq_total` | Time series |
| Active Events by Status | All event counters | Pie chart |
| Delivery Latency p50/p95/p99 | `delivery_attempt_duration_seconds` | Time series |
| Delivery Latency by Destination (p99) | `delivery_attempt_duration_seconds` | Time series (per dest) |
| Circuit Breaker State | `circuit_breaker_state` | Table (instant) |
| CB State Timeline | `circuit_breaker_state` | Time series |
| Queue Depth | `queue_depth` | Time series |
| Cumulative Totals | All counters | Stat |

Dashboard refreshes every 5s, showing the last 5 minutes by default.

---

## Alert Thresholds (Summary)

| Condition | Severity | Action |
|---|---|---|
| Delivery success rate < 99% over 5m | Warning | Slack notification |
| Delivery success rate < 90% over 5m | Critical | Page on-call |
| DLQ rate > 1% of ingestion rate over 5m | Critical | Page on-call |
| p99 latency > 5s over 5m | Warning | Investigate destination |
| p99 latency > 10s over 5m | Critical | Page on-call |
| `circuit_breaker_state{state="open"}` for > 30s | Critical | Page on-call |
| `queue_depth` > 1000 for > 5m | Warning | Scale worker |
| `events_ingested_total` rate drops to 0 for 5m | Warning | Check upstream producer |

In production, these alerts would be configured in a tool like Alertmanager or Grafana Alerting.
