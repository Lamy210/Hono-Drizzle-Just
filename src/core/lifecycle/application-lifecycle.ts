export type CloseResource = () => void | Promise<void>;

interface LifecycleResource {
  readonly name: string;
  readonly close: CloseResource;
}

export class ApplicationLifecycle {
  private readonly resources: LifecycleResource[] = [];
  private closePromise: Promise<void> | undefined;

  register(name: string, close: CloseResource): void {
    if (this.closePromise) {
      throw new Error(`Cannot register lifecycle resource '${name}' after shutdown has started`);
    }
    this.resources.push({ name, close });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const errors: Error[] = [];

    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        errors.push(
          new Error(`Failed to close lifecycle resource '${resource.name}'`, {
            cause: error,
          }),
        );
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more application resources failed to close");
    }
  }
}
