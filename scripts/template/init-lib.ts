import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TemplateIdentity } from "./identity";
import type { CommandRunner } from "./process-runner";
import {
  MANAGED_IDENTITY_PATHS,
  classifyRepositoryState,
  planIdentityChanges,
  readLockfileRootName,
  readManagedRepository,
  type ManagedIdentityPath,
} from "./repository-files";

export interface InitOptions {
  readonly root: string;
  readonly target: TemplateIdentity;
  readonly dryRun: boolean;
  readonly runner: CommandRunner;
}

export interface InitResult {
  readonly status: "changed" | "unchanged" | "dry-run";
  readonly changedFiles: readonly ManagedIdentityPath[];
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1) ?? "template"}.template-init-${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreManagedFiles(
  root: string,
  originals: Readonly<Record<ManagedIdentityPath, string>>,
): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const path of MANAGED_IDENTITY_PATHS) {
    try {
      await atomicWrite(join(root, path), originals[path]);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return failures;
}

function lockfileFailure(message: string, stderr?: string): Error {
  const detail = stderr?.trim();
  return new Error(detail ? `${message}: ${detail}` : message);
}

export async function initializeTemplate(options: InitOptions): Promise<InitResult> {
  const snapshot = await readManagedRepository(options.root);
  const state = classifyRepositoryState(snapshot, options.target);

  if (state === "target") {
    return { status: "unchanged", changedFiles: [] };
  }
  if (state === "mixed") {
    throw new Error("repository identity is mixed or unsupported; refusing to initialize");
  }

  const changes = planIdentityChanges(snapshot, options.target);
  const changedFiles: ManagedIdentityPath[] = [...changes.map((change) => change.path), "bun.lock"];
  if (options.dryRun) {
    return { status: "dry-run", changedFiles };
  }

  try {
    for (const change of changes) {
      await atomicWrite(join(options.root, change.path), change.content);
    }

    const command = await options.runner.run(["bun", "install", "--lockfile-only"], options.root);
    if (command.exitCode !== 0) {
      throw lockfileFailure("lockfile regeneration failed", command.stderr);
    }

    const lockfile = await readFile(join(options.root, "bun.lock"), "utf8");
    const rootWorkspaceName = readLockfileRootName(lockfile);
    if (rootWorkspaceName !== options.target.packageName) {
      throw lockfileFailure(
        `lockfile verification failed: expected root workspace ${options.target.packageName}, got ${rootWorkspaceName ?? "missing"}`,
      );
    }

    return { status: "changed", changedFiles };
  } catch (error) {
    const rollbackFailures = await restoreManagedFiles(options.root, snapshot.files);
    const initializationError = error instanceof Error ? error : new Error(String(error));
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [initializationError, ...rollbackFailures],
        `template initialization failed and rollback encountered ${rollbackFailures.length} error(s): ${initializationError.message}`,
      );
    }
    throw initializationError;
  }
}
