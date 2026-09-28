import type { HealthCheck } from "./health-check";

export class ReadinessGate implements HealthCheck {
  readonly name = "lifecycle";
  private ready = true;

  markNotReady(): void {
    this.ready = false;
  }

  async check(): Promise<void> {
    if (!this.ready) {
      throw new Error("application is draining");
    }
  }
}
