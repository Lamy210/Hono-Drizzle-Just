import type { Meter } from "./meter";
import type { TelemetryAttributes } from "./tracer";

export class NoopMeter implements Meter {
  increment(
    _name: string,
    _value = 1,
    _attributes?: TelemetryAttributes,
  ): void {}

  record(
    _name: string,
    _value: number,
    _attributes?: TelemetryAttributes,
  ): void {}
}
