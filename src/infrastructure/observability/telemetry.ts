import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { NoopMeter } from "../../core/observability/noop-meter";
import { NoopTracer } from "../../core/observability/noop-tracer";
import type { Meter } from "../../core/observability/meter";
import type { Tracer } from "../../core/observability/tracer";
import { OpenTelemetryMeter } from "./opentelemetry-meter";
import { OpenTelemetryTracer } from "./opentelemetry-tracer";

export interface TelemetryOptions {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly environment: string;
  readonly endpoint: string;
  readonly metricExportIntervalMs: number;
}

export interface TelemetryExporters {
  readonly traceExporter?: SpanExporter;
  readonly metricExporter?: PushMetricExporter;
}

export interface TelemetryRuntime {
  readonly tracer: Tracer;
  readonly meter: Meter;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

function signalUrl(endpoint: string, signal: "traces" | "metrics"): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

export function createTelemetry(
  options: TelemetryOptions,
  exporters: TelemetryExporters = {},
): TelemetryRuntime {
  if (!options.enabled) {
    return {
      tracer: new NoopTracer(),
      meter: new NoopMeter(),
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
  }

  const resource = defaultResource().merge(
    resourceFromAttributes({
      "service.name": options.serviceName,
      "deployment.environment.name": options.environment,
    }),
  );
  const traceExporter =
    exporters.traceExporter ??
    new OTLPTraceExporter({ url: signalUrl(options.endpoint, "traces") });
  const metricExporter =
    exporters.metricExporter ??
    new OTLPMetricExporter({ url: signalUrl(options.endpoint, "metrics") });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: traceExporter })],
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
    throw new Error("OpenTelemetry context manager is already registered");
  }

  let shutdownPromise: Promise<void> | undefined;
  const forceFlush = async (): Promise<void> => {
    await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      try {
        await forceFlush();
        await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
      } finally {
        context.disable();
      }
    })();
    return shutdownPromise;
  };

  return {
    tracer: new OpenTelemetryTracer(tracerProvider.getTracer(options.serviceName)),
    meter: new OpenTelemetryMeter(meterProvider.getMeter(options.serviceName)),
    forceFlush,
    shutdown,
  };
}
