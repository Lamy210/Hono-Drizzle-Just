import { parseArgs } from "node:util";
import { inferIdentityFromOrigin, type IdentityInput } from "./identity";
import { initializeTemplate } from "./init-lib";
import { createBunCommandRunner, type CommandRunner } from "./process-runner";

export interface InitCliOptions {
  readonly argv: readonly string[];
  readonly root: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

function parseIdentityArgs(argv: readonly string[]): {
  readonly identity: IdentityInput;
  readonly dryRun: boolean;
} {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const parsed = parseArgs({
    args: [...normalizedArgv],
    options: {
      name: { type: "string" },
      "package-name": { type: "string" },
      "service-name": { type: "string" },
      repository: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    identity: {
      ...(parsed.values.repository === undefined ? {} : { repository: parsed.values.repository }),
      ...(parsed.values.name === undefined ? {} : { displayName: parsed.values.name }),
      ...(parsed.values["package-name"] === undefined
        ? {}
        : { packageName: parsed.values["package-name"] }),
      ...(parsed.values["service-name"] === undefined
        ? {}
        : { serviceName: parsed.values["service-name"] }),
    },
    dryRun: parsed.values["dry-run"] ?? false,
  };
}

function isArgumentParseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ((error as { code: string }).code.startsWith("ERR_PARSE_ARGS_") ||
      (error as { code: string }).code === "ERR_INVALID_ARG_VALUE")
  );
}

export async function runInitCli(options: InitCliOptions): Promise<number> {
  let parsed: ReturnType<typeof parseIdentityArgs>;
  try {
    parsed = parseIdentityArgs(options.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr(`Usage error: ${message}`);
    return isArgumentParseError(error) ? 2 : 1;
  }

  try {
    const target = await inferIdentityFromOrigin(options.runner, options.root, parsed.identity);
    const result = await initializeTemplate({
      root: options.root,
      target,
      dryRun: parsed.dryRun,
      runner: options.runner,
    });

    if (result.status === "unchanged") {
      options.stdout(`Template already initialized for ${target.displayName}.`);
      return 0;
    }

    if (result.status === "dry-run") {
      options.stdout(`Dry run for ${target.displayName}:`);
      for (const path of result.changedFiles) {
        options.stdout(`Would change: ${path}`);
      }
      return 0;
    }

    options.stdout(`Initialized ${target.displayName} (${target.repositorySlug}).`);
    for (const path of result.changedFiles) {
      options.stdout(`Changed: ${path}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr(`Initialization failed: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runInitCli({
    argv: Bun.argv.slice(2),
    root: process.cwd(),
    runner: createBunCommandRunner(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exitCode = exitCode;
}
