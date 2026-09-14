import type { Counter, Histogram, Meter as ApiMeter } from "@opentelemetry/api";
import type { Meter } from "../../core/observability/meter";
import type { TelemetryAttributes } from "../../core/observability/tracer";

export class OpenTelemetryMeter implements Meter {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(private readonly meter: ApiMeter) {}

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, attributes);
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    histogram.record(value, attributes);
  }
}
