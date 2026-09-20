import type { TelemetryAttributes } from "./tracer";

export interface MetricOptions {
  readonly description?: string;
  readonly unit?: string;
}

export interface Meter {
  increment(
    name: string,
    value?: number,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void;

  record(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void;
}

export interface ObservableMeasurement {
  readonly value: number;
  readonly attributes?: TelemetryAttributes;
}

export type ObservableMetricOptions = MetricOptions;

export type ObservableMetricCallback = () => readonly ObservableMeasurement[];

export interface ObservableMeter extends Meter {
  observeUpDownCounter(
    name: string,
    callback: ObservableMetricCallback,
    options?: ObservableMetricOptions,
  ): () => void;
}
