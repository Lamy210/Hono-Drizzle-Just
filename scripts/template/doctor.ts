import {
  formatDoctorResult,
  formatDoctorSummary,
  runDoctor,
} from "./doctor-lib";
import { createBunCommandRunner, type CommandRunner } from "./process-runner";

export interface DoctorCliOptions {
  readonly root: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export async function runDoctorCli(options: DoctorCliOptions): Promise<0 | 1 | 2> {
  try {
    const report = await runDoctor({ root: options.root, runner: options.runner });
    for (const item of report.results) {
      options.stdout(formatDoctorResult(item));
    }
    options.stdout(formatDoctorSummary(report.results));
    if (report.exitCode === 2) {
      const failure = report.results.find((item) => item.check === "doctor");
      if (failure) options.stderr(failure.message);
    }
    return report.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr(`Doctor failed: ${message}`);
    return 2;
  }
}

if (import.meta.main) {
  const exitCode = await runDoctorCli({
    root: process.cwd(),
    runner: createBunCommandRunner(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exitCode = exitCode;
}
