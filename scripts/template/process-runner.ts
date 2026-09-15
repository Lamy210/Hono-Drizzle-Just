export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}

export function createBunCommandRunner(): CommandRunner {
  return {
    async run(argv, cwd) {
      if (argv.length === 0) {
        throw new Error("command argv must not be empty");
      }

      const process = Bun.spawn([...argv], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);

      return { exitCode, stdout, stderr };
    },
  };
}
