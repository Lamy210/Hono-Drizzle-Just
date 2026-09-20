import type { TelemetryAttributes } from "./tracer";

export interface Meter {
  increment(
    name: string,
    value?: number,
    attributes?: TelemetryAttributes,
  ): void;

  record(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
  ): void;
}

export interface ObservableMeasurement {
  readonly value: number;
  readonly attributes?: TelemetryAttributes;
}

export interface ObservableMetricOptions {
  readonly description?: string;
  readonly unit?: string;
}

export type ObservableMetricCallback = () => readonly ObservableMeasurement[];

export interface ObservableMeter extends Meter {
  observeUpDownCounter(
    name: string,
    callback: ObservableMetricCallback,
    options?: ObservableMetricOptions,
  ): () => void;
}
