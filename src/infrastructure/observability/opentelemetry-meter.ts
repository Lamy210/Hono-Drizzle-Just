import type {
  Counter,
  Histogram,
  Meter as ApiMeter,
  ObservableCallback as ApiObservableCallback,
  ObservableUpDownCounter,
} from "@opentelemetry/api";
import type {
  ObservableMeter,
  ObservableMetricCallback,
  ObservableMetricOptions,
} from "../../core/observability/meter";
import type { TelemetryAttributes } from "../../core/observability/tracer";

export class OpenTelemetryMeter implements ObservableMeter {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly observableUpDownCounters = new Map<string, ObservableUpDownCounter>();

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

  observeUpDownCounter(
    name: string,
    observe: ObservableMetricCallback,
    options?: ObservableMetricOptions,
  ): () => void {
    let instrument = this.observableUpDownCounters.get(name);
    if (!instrument) {
      instrument = this.meter.createObservableUpDownCounter(name, options);
      this.observableUpDownCounters.set(name, instrument);
    }

    const callback: ApiObservableCallback = (result) => {
      for (const measurement of observe()) {
        result.observe(measurement.value, measurement.attributes);
      }
    };
    instrument.addCallback(callback);

    let removed = false;
    return () => {
      if (removed) {
        return;
      }
      removed = true;
      instrument?.removeCallback(callback);
    };
  }
}
