import { expect, mock, test } from "bun:test";
import type { Meter as ApiMeter } from "@opentelemetry/api";
import { OpenTelemetryMeter } from "../../../src/infrastructure/observability/opentelemetry-meter";

function makeApiMeter(overrides: Record<string, unknown> = {}): ApiMeter {
  return {
    createCounter: () => ({ add: () => undefined }),
    createHistogram: () => ({ record: () => undefined }),
    createObservableUpDownCounter: () => ({
      addCallback: () => undefined,
      removeCallback: () => undefined,
    }),
    ...overrides,
  } as unknown as ApiMeter;
}

test("OpenTelemetryMeter rejects malformed instrument runtime wiring", () => {
  const nullCounter = new OpenTelemetryMeter(
    makeApiMeter({ createCounter: () => null }),
  );
  expect(() => nullCounter.increment("malformed.counter")).toThrow(
    "OpenTelemetry counter instrument must be an object",
  );

  const invalidCounterMethod = new OpenTelemetryMeter(
    makeApiMeter({ createCounter: () => ({ add: null }) }),
  );
  expect(() => invalidCounterMethod.increment("malformed.counter.method")).toThrow(
    "OpenTelemetry counter instrument add must be callable",
  );

  const nullHistogram = new OpenTelemetryMeter(
    makeApiMeter({ createHistogram: () => null }),
  );
  expect(() => nullHistogram.record("malformed.histogram", 1)).toThrow(
    "OpenTelemetry histogram instrument must be an object",
  );

  const invalidHistogramMethod = new OpenTelemetryMeter(
    makeApiMeter({ createHistogram: () => ({ record: null }) }),
  );
  expect(() => invalidHistogramMethod.record("malformed.histogram.method", 1)).toThrow(
    "OpenTelemetry histogram instrument record must be callable",
  );

  const nullObservable = new OpenTelemetryMeter(
    makeApiMeter({ createObservableUpDownCounter: () => null }),
  );
  expect(() => nullObservable.observeUpDownCounter("malformed.observable", () => [])).toThrow(
    "OpenTelemetry observable up/down counter instrument must be an object",
  );

  const invalidObservableAdd = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: null,
        removeCallback: () => undefined,
      }),
    }),
  );
  expect(() =>
    invalidObservableAdd.observeUpDownCounter("malformed.observable.add", () => []),
  ).toThrow("OpenTelemetry observable up/down counter instrument addCallback must be callable");

  const invalidObservableRemove = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: () => undefined,
        removeCallback: null,
      }),
    }),
  );
  expect(() =>
    invalidObservableRemove.observeUpDownCounter("malformed.observable.remove", () => []),
  ).toThrow(
    "OpenTelemetry observable up/down counter instrument removeCallback must be callable",
  );
});

test("OpenTelemetryMeter normalizes throwing instrument method getters", () => {
  const counterInstrument = Object.defineProperty({}, "add", {
    get() {
      throw new Error("provider counter failure");
    },
  });
  const counterMeter = new OpenTelemetryMeter(
    makeApiMeter({ createCounter: () => counterInstrument }),
  );
  expect(() => counterMeter.increment("throwing.counter")).toThrow(
    "OpenTelemetry counter instrument add could not be read",
  );

  const histogramInstrument = Object.defineProperty({}, "record", {
    get() {
      throw new Error("provider histogram failure");
    },
  });
  const histogramMeter = new OpenTelemetryMeter(
    makeApiMeter({ createHistogram: () => histogramInstrument }),
  );
  expect(() => histogramMeter.record("throwing.histogram", 1)).toThrow(
    "OpenTelemetry histogram instrument record could not be read",
  );

  const observableAddInstrument = Object.defineProperties(
    {},
    {
      addCallback: {
        get() {
          throw new Error("provider observable add failure");
        },
      },
      removeCallback: {
        value: () => undefined,
      },
    },
  );
  const observableAddMeter = new OpenTelemetryMeter(
    makeApiMeter({ createObservableUpDownCounter: () => observableAddInstrument }),
  );
  expect(() =>
    observableAddMeter.observeUpDownCounter("throwing.observable.add", () => []),
  ).toThrow(
    "OpenTelemetry observable up/down counter instrument addCallback could not be read",
  );

  const observableRemoveInstrument = Object.defineProperties(
    {},
    {
      addCallback: {
        value: () => undefined,
      },
      removeCallback: {
        get() {
          throw new Error("provider observable remove failure");
        },
      },
    },
  );
  const observableRemoveMeter = new OpenTelemetryMeter(
    makeApiMeter({ createObservableUpDownCounter: () => observableRemoveInstrument }),
  );
  expect(() =>
    observableRemoveMeter.observeUpDownCounter("throwing.observable.remove", () => []),
  ).toThrow(
    "OpenTelemetry observable up/down counter instrument removeCallback could not be read",
  );
});

test("OpenTelemetryMeter snapshots instrument methods once and preserves receivers", () => {
  let counterReads = 0;
  let counterReceiverPreserved = false;
  const counterAdd = mock((_value: number) => undefined);
  let currentCounterAdd = function (this: unknown, value: number) {
    counterReceiverPreserved = this === counterInstrument;
    counterAdd(value);
  };
  const counterInstrument = {
    get add() {
      counterReads += 1;
      return currentCounterAdd;
    },
  };

  let histogramReads = 0;
  let histogramReceiverPreserved = false;
  const histogramRecord = mock((_value: number) => undefined);
  let currentHistogramRecord = function (this: unknown, value: number) {
    histogramReceiverPreserved = this === histogramInstrument;
    histogramRecord(value);
  };
  const histogramInstrument = {
    get record() {
      histogramReads += 1;
      return currentHistogramRecord;
    },
  };

  let addCallbackReads = 0;
  let removeCallbackReads = 0;
  let addCallbackReceiverPreserved = false;
  let removeCallbackReceiverPreserved = false;
  const addCallback = mock((_callback: unknown) => undefined);
  const removeCallback = mock((_callback: unknown) => undefined);
  let currentAddCallback = function (this: unknown, callback: unknown) {
    addCallbackReceiverPreserved = this === observableInstrument;
    addCallback(callback);
  };
  let currentRemoveCallback = function (this: unknown, callback: unknown) {
    removeCallbackReceiverPreserved = this === observableInstrument;
    removeCallback(callback);
  };
  const observableInstrument = {
    get addCallback() {
      addCallbackReads += 1;
      return currentAddCallback;
    },
    get removeCallback() {
      removeCallbackReads += 1;
      return currentRemoveCallback;
    },
  };

  const meter = new OpenTelemetryMeter(
    makeApiMeter({
      createCounter: () => counterInstrument,
      createHistogram: () => histogramInstrument,
      createObservableUpDownCounter: () => observableInstrument,
    }),
  );

  meter.increment("snapshot.counter", 1);
  meter.record("snapshot.histogram", 2);
  const stop = meter.observeUpDownCounter("snapshot.observable", () => []);

  expect(counterReads).toBe(1);
  expect(histogramReads).toBe(1);
  expect(addCallbackReads).toBe(1);
  expect(removeCallbackReads).toBe(1);

  currentCounterAdd = () => {
    throw new Error("replacement counter add must not run");
  };
  currentHistogramRecord = () => {
    throw new Error("replacement histogram record must not run");
  };
  currentAddCallback = () => {
    throw new Error("replacement observable addCallback must not run");
  };
  currentRemoveCallback = () => {
    throw new Error("replacement observable removeCallback must not run");
  };

  meter.increment("snapshot.counter", 3);
  meter.record("snapshot.histogram", 4);
  stop();
  stop();

  expect(counterReads).toBe(1);
  expect(histogramReads).toBe(1);
  expect(addCallbackReads).toBe(1);
  expect(removeCallbackReads).toBe(1);
  expect(counterReceiverPreserved).toBe(true);
  expect(histogramReceiverPreserved).toBe(true);
  expect(addCallbackReceiverPreserved).toBe(true);
  expect(removeCallbackReceiverPreserved).toBe(true);
  expect(counterAdd).toHaveBeenCalledTimes(2);
  expect(histogramRecord).toHaveBeenCalledTimes(2);
  expect(addCallback).toHaveBeenCalledTimes(1);
  expect(removeCallback).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryMeter isolates counter and histogram provider invocation failures", () => {
  const meter = new OpenTelemetryMeter(
    makeApiMeter({
      createCounter: () => ({
        add: () => {
          throw new Error("provider counter invocation failure");
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error("provider histogram invocation failure");
        },
      }),
    }),
  );

  expect(() => meter.increment("runtime.counter", 2)).not.toThrow();
  expect(() => meter.record("runtime.histogram", 0.25)).not.toThrow();
});

test("OpenTelemetryMeter isolates observable registration and removal failures", () => {
  const registrationMeter = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: () => {
          throw new Error("provider registration failure");
        },
        removeCallback: () => {
          throw new Error("removeCallback must not run after failed registration");
        },
      }),
    }),
  );

  let failedRegistrationStop: (() => void) | undefined;
  expect(() => {
    failedRegistrationStop = registrationMeter.observeUpDownCounter(
      "runtime.observable.registration",
      () => [],
    );
  }).not.toThrow();
  expect(() => failedRegistrationStop?.()).not.toThrow();

  let removeCalls = 0;
  const removalMeter = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: () => undefined,
        removeCallback: () => {
          removeCalls += 1;
          throw new Error("provider removal failure");
        },
      }),
    }),
  );

  const stop = removalMeter.observeUpDownCounter("runtime.observable.removal", () => []);
  expect(() => stop()).not.toThrow();
  expect(() => stop()).not.toThrow();
  expect(removeCalls).toBe(1);
});

test("OpenTelemetryMeter snapshots observable result methods per callback invocation", () => {
  let registeredCallback: ((result: unknown) => void) | undefined;
  const meter = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: (callback: unknown) => {
          registeredCallback = callback as (result: unknown) => void;
        },
        removeCallback: () => undefined,
      }),
    }),
  );

  meter.observeUpDownCounter("runtime.observable.result", () => [
    { value: 1, attributes: { state: "busy" } },
    { value: 2, attributes: { state: "idle" } },
  ]);

  expect(registeredCallback).toBeDefined();
  const callback = registeredCallback as (result: unknown) => void;
  let observeReads = 0;
  let receiverPreserved = true;
  const observedValues: number[] = [];
  let currentObserve = function (this: unknown, value: number) {
    receiverPreserved = receiverPreserved && this === result;
    observedValues.push(value);
    if (value === 1) {
      currentObserve = () => {
        throw new Error("replacement observe failure");
      };
      throw new Error("provider observe failure");
    }
  };
  const result = {
    get observe() {
      observeReads += 1;
      return currentObserve;
    },
  };

  expect(() => callback(result)).not.toThrow();
  expect(observeReads).toBe(1);
  expect(receiverPreserved).toBe(true);
  expect(observedValues).toEqual([1, 2]);

  expect(() => callback(result)).not.toThrow();
  expect(observeReads).toBe(2);
  expect(observedValues).toEqual([1, 2]);

  const throwingGetterResult = Object.defineProperty({}, "observe", {
    get() {
      throw new Error("provider result getter failure");
    },
  });
  expect(() => callback(throwingGetterResult)).not.toThrow();
});

test("OpenTelemetryMeter keeps application observable callback failures strict", () => {
  let registeredCallback: ((result: unknown) => void) | undefined;
  const applicationFailure = new Error("application observation failure");
  const meter = new OpenTelemetryMeter(
    makeApiMeter({
      createObservableUpDownCounter: () => ({
        addCallback: (callback: unknown) => {
          registeredCallback = callback as (result: unknown) => void;
        },
        removeCallback: () => undefined,
      }),
    }),
  );

  meter.observeUpDownCounter("runtime.observable.application", () => {
    throw applicationFailure;
  });

  expect(registeredCallback).toBeDefined();
  const callback = registeredCallback as (result: unknown) => void;
  expect(() => callback({ observe: () => undefined })).toThrow(applicationFailure);
});
