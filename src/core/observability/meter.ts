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
