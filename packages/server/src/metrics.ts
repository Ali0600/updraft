import type { Platform } from '@ota/core';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Values that may become label values.
 *
 * Everything here is drawn from a closed set the server controls. Nothing
 * derived from a request may be used as a label — see the note on
 * `platformLabel` for why this is a security property rather than tidiness.
 */
export type StorageOperation = 'get' | 'put' | 'stat';
export type StorageResult = 'ok' | 'missing' | 'error';
export type ManifestOutcome =
  | 'manifest'
  | 'up_to_date'
  | 'no_update'
  | 'rollback'
  | 'app_not_found'
  | 'channel_not_found'
  | 'client_error';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'route'>;
  manifestOutcomes: Counter<'platform' | 'outcome'>;
  assetBytesSent: Counter<string>;
  storageOperations: Counter<'operation' | 'result'>;
  storageDuration: Histogram<'operation'>;
  dependencyUp: Gauge<'dependency'>;
}

/**
 * Maps a request's platform to a bounded label.
 *
 * The raw header must never be used. `expo-platform` is attacker-controlled,
 * and a label taken from it lets anyone mint unbounded time series until the
 * process runs out of memory. The same reasoning excludes the app slug (it
 * comes straight out of the URL path), the channel, runtime versions, update
 * ids, asset hashes, client IPs and user agents.
 */
export function platformLabel(platform: string | undefined): Platform | 'unknown' {
  return platform === 'ios' || platform === 'android' ? platform : 'unknown';
}

export interface CreateMetricsOptions {
  version: string;
  storageDriver: string;
  assetDelivery: 'proxy' | 'direct';
}

/**
 * Builds a self-contained registry.
 *
 * Never the prom-client default registry: the test suite builds many apps in
 * one process, and registering a metric name twice on a shared registry
 * throws.
 */
export function createMetrics(options: CreateMetricsOptions): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  // One series per process. The standard place for values that are constant
  // for a process, so they never become labels on a hot metric.
  new Gauge({
    name: 'updraft_build_info',
    help: 'Build and configuration of this process; always 1.',
    labelNames: ['version', 'storage_driver', 'asset_delivery'],
    registers: [registry],
  }).set(
    {
      version: options.version,
      storage_driver: options.storageDriver,
      asset_delivery: options.assetDelivery,
    },
    1,
  );

  return {
    registry,
    httpRequests: new Counter({
      name: 'updraft_http_requests_total',
      help: 'HTTP requests by matched route pattern.',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'updraft_http_request_duration_seconds',
      help: 'Request duration by matched route pattern.',
      labelNames: ['route'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    manifestOutcomes: new Counter({
      name: 'updraft_manifest_outcomes_total',
      help: 'What the manifest endpoint decided, by platform.',
      labelNames: ['platform', 'outcome'],
      registers: [registry],
    }),
    assetBytesSent: new Counter({
      name: 'updraft_asset_bytes_sent_total',
      help: 'Asset payload bytes served by this process (not wire bytes).',
      registers: [registry],
    }),
    storageOperations: new Counter({
      name: 'updraft_storage_operations_total',
      help: 'Storage calls by outcome; "missing" is an absent key, "error" a failure.',
      labelNames: ['operation', 'result'],
      registers: [registry],
    }),
    storageDuration: new Histogram({
      name: 'updraft_storage_operation_duration_seconds',
      help: 'Storage call duration. Wider buckets than HTTP: these can be network calls.',
      labelNames: ['operation'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    dependencyUp: new Gauge({
      name: 'updraft_dependency_up',
      help: 'Whether a dependency answered its last readiness probe.',
      labelNames: ['dependency'],
      registers: [registry],
    }),
  };
}
