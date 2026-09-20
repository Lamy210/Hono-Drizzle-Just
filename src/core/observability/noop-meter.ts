import type {
  MetricOptions,
  ObservableMeter,
  ObservableMetricCallback,
  ObservableMetricOptions,
} from "./meter";
import type { TelemetryAttributes } from "./tracer";

export class NoopMeter implements ObservableMeter {
  increment(
    _name: string,
    _value = 1,
    _attributes?: TelemetryAttributes,
    _options?: MetricOptions,
  ): void {}

  record(
    _name: string,
    _value: number,
    _attributes?: TelemetryAttributes,
    _options?: MetricOptions,
  ): void {}

  observeUpDownCounter(
    _name: string,
    _callback: ObservableMetricCallback,
    _options?: ObservableMetricOptions,
  ): () => void {
    return () => undefined;
  }
}
