export interface FactoryContext {
  readonly sequence: number;
}

export type FactoryDefaults<T extends object> = (context: FactoryContext) => T;
export type FactoryOverrides<T extends object> =
  | Partial<T>
  | ((context: FactoryContext) => Partial<T>);

function assertFactoryCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Factory count must be a non-negative integer");
  }
}

export class TestFactory<T extends object> {
  private sequence = 0;

  constructor(private readonly defaults: FactoryDefaults<T>) {}

  build(overrides: FactoryOverrides<T> = {}): T {
    const context: FactoryContext = { sequence: ++this.sequence };
    const resolvedOverrides =
      typeof overrides === "function" ? overrides(context) : overrides;

    return { ...this.defaults(context), ...resolvedOverrides };
  }

  buildMany(count: number, overrides: FactoryOverrides<T> = {}): T[] {
    assertFactoryCount(count);
    return Array.from({ length: count }, () => this.build(overrides));
  }
}

export class PersistentTestFactory<T extends object, TCreated> extends TestFactory<T> {
  constructor(
    defaults: FactoryDefaults<T>,
    private readonly persist: (value: T) => Promise<TCreated>,
  ) {
    super(defaults);
  }

  async create(overrides: FactoryOverrides<T> = {}): Promise<TCreated> {
    return this.persist(this.build(overrides));
  }

  async createMany(count: number, overrides: FactoryOverrides<T> = {}): Promise<TCreated[]> {
    const values = this.buildMany(count, overrides);
    const created: TCreated[] = [];

    for (const value of values) {
      created.push(await this.persist(value));
    }

    return created;
  }
}
