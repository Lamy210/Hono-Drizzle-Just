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
type RuntimeInstrumentMethod = (...args: unknown[]) => unknown;

type MeterFactoryName =
  | "createCounter"
  | "createHistogram"
  | "createObservableUpDownCounter";

interface NormalizedCounter {
  readonly add: Counter["add"];
}

interface NormalizedHistogram {
  readonly record: Histogram["record"];
}

interface NormalizedObservableUpDownCounter {
  readonly addCallback: ObservableUpDownCounter["addCallback"];
  readonly removeCallback: ObservableUpDownCounter["removeCallback"];
}

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

function requireInstrumentObject(instrument: unknown, label: string): object {
  if (typeof instrument !== "object" || instrument === null) {
    throw new TypeError(`${label} must be an object`);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(instrument);
  } catch {
    throw new TypeError(`${label} could not be read`);
  }
  if (isArray) {
    throw new TypeError(`${label} must be an object`);
  }

  return instrument;
}

function normalizeInstrumentMethod(
  instrument: object,
  label: string,
  name: string,
): RuntimeInstrumentMethod {
  let method: unknown;
  try {
    method = Reflect.get(instrument, name);
  } catch {
    throw new TypeError(`${label} ${name} could not be read`);
  }
  if (typeof method !== "function") {
    throw new TypeError(`${label} ${name} must be callable`);
  }

  return (...args: unknown[]) => Reflect.apply(method, instrument, args);
}

function normalizeCounterInstrument(instrument: unknown): NormalizedCounter {
  const label = "OpenTelemetry counter instrument";
  const value = requireInstrumentObject(instrument, label);
  return {
    add: normalizeInstrumentMethod(value, label, "add") as Counter["add"],
  };
}

function normalizeHistogramInstrument(instrument: unknown): NormalizedHistogram {
  const label = "OpenTelemetry histogram instrument";
  const value = requireInstrumentObject(instrument, label);
  return {
    record: normalizeInstrumentMethod(value, label, "record") as Histogram["record"],
  };
}

function normalizeObservableUpDownCounterInstrument(
  instrument: unknown,
): NormalizedObservableUpDownCounter {
  const label = "OpenTelemetry observable up/down counter instrument";
  const value = requireInstrumentObject(instrument, label);
  return {
    addCallback: normalizeInstrumentMethod(
      value,
      label,
      "addCallback",
    ) as ObservableUpDownCounter["addCallback"],
    removeCallback: normalizeInstrumentMethod(
      value,
      label,
      "removeCallback",
    ) as ObservableUpDownCounter["removeCallback"],
  };
}

export class OpenTelemetryMeter implements ObservableMeter {
  private readonly counters = new Map<string, NormalizedCounter>();
  private readonly histograms = new Map<string, NormalizedHistogram>();
  private readonly observableUpDownCounters = new Map<
    string,
    NormalizedObservableUpDownCounter
  >();
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
      counter = normalizeCounterInstrument(this.createCounter(name, options));
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
      histogram = normalizeHistogramInstrument(this.createHistogram(name, options));
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
      instrument = normalizeObservableUpDownCounterInstrument(
        this.createObservableUpDownCounter(name, options),
      );
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
      instrument.removeCallback(callback);
    };
  }
}
