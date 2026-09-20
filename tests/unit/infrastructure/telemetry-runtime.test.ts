import { expect, test } from "bun:test";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { NoopMeter } from "../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../src/core/observability/noop-tracer";
import { createTelemetry } from "../../../src/infrastructure/observability/telemetry";

function metricExporter(exportedMetrics: ResourceMetrics[] = []): PushMetricExporter {
  return {
    export(metrics: ResourceMetrics, callback: (result: { code: number }) => void) {
      exportedMetrics.push(metrics);
      callback({ code: 0 });
    },
    async forceFlush() {},
    async shutdown() {},
  } as unknown as PushMetricExporter;
}

const enabledOptions = {
  enabled: true,
  serviceName: "test-service",
  environment: "test",
  endpoint: "http://127.0.0.1:4318",
  metricExportIntervalMs: 60_000,
} as const;

test("disabled telemetry uses Noop adapters and has no exporter side effects", async () => {
  const telemetry = createTelemetry({ ...enabledOptions, enabled: false });

  expect(telemetry.tracer).toBeInstanceOf(NoopTracer);
  expect(telemetry.meter).toBeInstanceOf(NoopMeter);
  await telemetry.forceFlush();
  await telemetry.shutdown();
});

test("enabled telemetry exports nested spans and metrics with service resource attributes under Bun", async () => {
  const traceExporter = new InMemorySpanExporter();
  const exportedMetrics: ResourceMetrics[] = [];
  const telemetry = createTelemetry(enabledOptions, {
    traceExporter,
    metricExporter: metricExporter(exportedMetrics),
  });

  let parentSpanId: string | undefined;
  await telemetry.tracer.withSpan("parent", {}, async (parent) => {
    parentSpanId = parent.traceContext()?.spanId;
    await telemetry.tracer.withSpan("child", {}, async () => undefined);
  });
  telemetry.meter.increment("example.requests", 1, { method: "GET" });
  telemetry.meter.record("example.duration", 0.25, { method: "GET" });
  const stopObservable = telemetry.meter.observeUpDownCounter(
    "example.current",
    () => [{ value: 3, attributes: { state: "active" } }],
    { unit: "{item}" },
  );

  await telemetry.forceFlush();

  const spans = traceExporter.getFinishedSpans() as ReadableSpan[];
  expect(spans).toHaveLength(2);
  const parent = spans.find((span) => span.name === "parent");
  const child = spans.find((span) => span.name === "child");
  expect(parent?.resource.attributes["service.name"]).toBe("test-service");
  expect(parent?.resource.attributes["deployment.environment.name"]).toBe("test");
  expect(child?.parentSpanContext?.spanId).toBe(parentSpanId);

  expect(exportedMetrics.length).toBeGreaterThan(0);
  const metricResource = exportedMetrics.at(-1);
  expect(metricResource?.resource.attributes["service.name"]).toBe("test-service");
  const metricNames = metricResource?.scopeMetrics.flatMap((scope) =>
    scope.metrics.map((metric) => metric.descriptor.name),
  );
  expect(metricNames).toContain("example.requests");
  expect(metricNames).toContain("example.duration");
  expect(metricNames).toContain("example.current");

  stopObservable();
  await telemetry.shutdown();
});

test("shutdown releases the global context manager so telemetry can be initialized again", async () => {
  const first = createTelemetry(enabledOptions, {
    traceExporter: new InMemorySpanExporter(),
    metricExporter: metricExporter(),
  });
  await first.shutdown();

  const second = createTelemetry(enabledOptions, {
    traceExporter: new InMemorySpanExporter(),
    metricExporter: metricExporter(),
  });
  await second.shutdown();
});
