import type {
  Counter,
  Histogram,
  Meter as ApiMeter,
  ObservableCallback as ApiObservableCallback,
  ObservableUpDownCounter,
} from "@opentelemetry/api";
import type {
  MetricOptions,
  ObservableMeter,
  ObservableMetricCallback,
  ObservableMetricOptions,
} from "../../core/observability/meter";
import type { TelemetryAttributes } from "../../core/observability/tracer";

type RuntimeMeterFactory = (...args: unknown[]) => unknown;

type MeterFactoryName =
  | "createCounter"
  | "createHistogram"
  | "createObservableUpDownCounter";

function normalizeMeterFactory(meter: object, name: MeterFactoryName): RuntimeMeterFactory {
  let factory: unknown;
  try {
    factory = Reflect.get(meter, name);
  } catch {
    throw new TypeError(`OpenTelemetry meter ${name} could not be read`);
  }
  if (typeof factory !== "function") {
    throw new TypeError(`OpenTelemetry meter ${name} must be callable`);
  }

  return (...args: unknown[]) => Reflect.apply(factory, meter, args);
}

export class OpenTelemetryMeter implements ObservableMeter {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly observableUpDownCounters = new Map<string, ObservableUpDownCounter>();
  private readonly createCounter: ApiMeter["createCounter"];
  private readonly createHistogram: ApiMeter["createHistogram"];
  private readonly createObservableUpDownCounter: ApiMeter["createObservableUpDownCounter"];

  constructor(meter: ApiMeter) {
    if (typeof meter !== "object" || meter === null) {
      throw new TypeError("OpenTelemetry meter must be an object");
    }

    let isArray: boolean;
    try {
      isArray = Array.isArray(meter);
    } catch {
      throw new TypeError("OpenTelemetry meter factories could not be read");
    }
    if (isArray) {
      throw new TypeError("OpenTelemetry meter must be an object");
    }

    this.createCounter = normalizeMeterFactory(
      meter,
      "createCounter",
    ) as ApiMeter["createCounter"];
    this.createHistogram = normalizeMeterFactory(
      meter,
      "createHistogram",
    ) as ApiMeter["createHistogram"];
    this.createObservableUpDownCounter = normalizeMeterFactory(
      meter,
      "createObservableUpDownCounter",
    ) as ApiMeter["createObservableUpDownCounter"];
  }

  increment(
    name: string,
    value = 1,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.createCounter(name, options);
      this.counters.set(name, counter);
    }
    counter.add(value, attributes);
  }

  record(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.createHistogram(name, options);
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
      instrument = this.createObservableUpDownCounter(name, options);
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
