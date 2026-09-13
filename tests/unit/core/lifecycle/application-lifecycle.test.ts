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
});
