import { describe, expect, mock, test } from "bun:test";
import { ApplicationLifecycle } from "../../../../src/core/lifecycle/application-lifecycle";

describe("ApplicationLifecycle", () => {
  test("closes resources once in reverse registration order", async () => {
    const order: string[] = [];
    const lifecycle = new ApplicationLifecycle();
    lifecycle.register("database", async () => void order.push("database"));
    lifecycle.register("telemetry", async () => void order.push("telemetry"));

    await lifecycle.close();
    await lifecycle.close();

    expect(order).toEqual(["telemetry", "database"]);
  });

  test("continues closing remaining resources when one close fails", async () => {
    const first = mock(async () => undefined);
    const failing = mock(async () => {
      throw new Error("flush failed");
    });
    const lifecycle = new ApplicationLifecycle();
    lifecycle.register("first", first);
    lifecycle.register("failing", failing);

    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  test("rejects registration from a close hook once shutdown has started", async () => {
    const lifecycle = new ApplicationLifecycle();
    const lateClose = mock(async () => undefined);
    let registrationError: unknown;

    lifecycle.register("first", () => {
      try {
        lifecycle.register("late", lateClose);
      } catch (error) {
        registrationError = error;
      }
    });

    await lifecycle.close();

    expect(registrationError).toBeInstanceOf(Error);
    expect((registrationError as Error).message).toBe(
      "Cannot register lifecycle resource 'late' after shutdown has started",
    );
    expect(lateClose).not.toHaveBeenCalled();
  });

  test("shares the in-flight close promise with reentrant close calls", async () => {
    const lifecycle = new ApplicationLifecycle();
    let closeCalls = 0;
    let reentered = false;
    let reentrantClose: Promise<void> | undefined;

    lifecycle.register("resource", () => {
      closeCalls += 1;
      if (!reentered) {
        reentered = true;
        reentrantClose = lifecycle.close();
      }
    });

    const close = lifecycle.close();

    expect(reentrantClose).toBe(close);
    await close;
    expect(closeCalls).toBe(1);
  });
});
