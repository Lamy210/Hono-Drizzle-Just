import { describe, expect, test } from "bun:test";
import { PersistentTestFactory, TestFactory } from "../../factories/factory";

type RecordFixture = {
  id: string;
  label: string;
  sequence: number;
};

function buildFactory() {
  return new TestFactory<RecordFixture>(({ sequence }) => ({
    id: `id-${sequence}`,
    label: `record-${sequence}`,
    sequence,
  }));
}

describe("TestFactory", () => {
  test("build merges explicit overrides over defaults", () => {
    const factory = buildFactory();

    const value = factory.build({ label: "override" });

    expect(value).toEqual({ id: "id-1", label: "override", sequence: 1 });
  });

  test("callback overrides receive the per-factory sequence", () => {
    const factory = buildFactory();

    const first = factory.build(({ sequence }) => ({ label: `custom-${sequence}` }));
    const second = factory.build(({ sequence }) => ({ label: `custom-${sequence}` }));

    expect(first.label).toBe("custom-1");
    expect(second.label).toBe("custom-2");
  });

  test("sequences are isolated between factory instances", () => {
    expect(buildFactory().build().sequence).toBe(1);
    expect(buildFactory().build().sequence).toBe(1);
  });

  test("buildMany builds the requested number in sequence order", () => {
    const values = buildFactory().buildMany(3, ({ sequence }) => ({
      label: `bulk-${sequence}`,
    }));

    expect(values.map((value) => value.sequence)).toEqual([1, 2, 3]);
    expect(values.map((value) => value.label)).toEqual(["bulk-1", "bulk-2", "bulk-3"]);
  });

  test("buildMany accepts zero and rejects invalid counts", () => {
    const factory = buildFactory();

    expect(factory.buildMany(0)).toEqual([]);
    expect(() => factory.buildMany(-1)).toThrow(RangeError);
    expect(() => factory.buildMany(1.5)).toThrow(RangeError);
  });
});

describe("PersistentTestFactory", () => {
  test("create and createMany persist in sequence order and return persisted values", async () => {
    const persisted: string[] = [];
    const factory = new PersistentTestFactory<RecordFixture, { stored: string }>(
      ({ sequence }) => ({ id: `id-${sequence}`, label: `record-${sequence}`, sequence }),
      async (value) => {
        persisted.push(value.id);
        return { stored: value.id };
      },
    );

    const first = await factory.create({ label: "first" });
    const many = await factory.createMany(2);

    expect(first).toEqual({ stored: "id-1" });
    expect(many).toEqual([{ stored: "id-2" }, { stored: "id-3" }]);
    expect(persisted).toEqual(["id-1", "id-2", "id-3"]);
  });
});
