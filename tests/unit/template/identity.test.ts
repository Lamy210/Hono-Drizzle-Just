import { describe, expect, test } from "bun:test";
import {
  SOURCE_TEMPLATE_IDENTITY,
  inferIdentityFromOrigin,
  parseGitHubRepository,
  resolveTemplateIdentity,
} from "../../../scripts/template/identity";
import type { CommandRunner } from "../../../scripts/template/process-runner";

function fakeRunner(result: { exitCode: number; stdout?: string; stderr?: string }): CommandRunner {
  return {
    run: async (argv, cwd) => {
      expect(argv).toEqual(["git", "remote", "get-url", "origin"]);
      expect(cwd).toBe("/repo");
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

describe("parseGitHubRepository", () => {
  test.each([
    ["https://github.com/acme/ExampleAPI.git", "acme/ExampleAPI"],
    ["https://github.com/acme/ExampleAPI", "acme/ExampleAPI"],
    ["git@github.com:acme/ExampleAPI.git", "acme/ExampleAPI"],
    ["ssh://git@github.com/acme/ExampleAPI.git", "acme/ExampleAPI"],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRepository(remote)).toBe(expected);
  });

  test.each([
    "https://gitlab.com/acme/example.git",
    "git@example.com:acme/example.git",
    "file:///tmp/example",
    "not-a-url",
  ])("rejects non-GitHub or malformed remote %s", (remote) => {
    expect(parseGitHubRepository(remote)).toBeUndefined();
  });
});

describe("resolveTemplateIdentity", () => {
  test("derives defaults from the repository name", () => {
    expect(resolveTemplateIdentity({ repository: "acme/ExampleAPI" })).toEqual({
      displayName: "ExampleAPI",
      packageName: "exampleapi",
      serviceName: "example-api",
      repositorySlug: "acme/ExampleAPI",
    });
  });

  test("preserves safe separators when deriving package and service names", () => {
    expect(resolveTemplateIdentity({ repository: "acme/example-api_server" })).toEqual({
      displayName: "example-api_server",
      packageName: "example-api_server",
      serviceName: "example-api-server",
      repositorySlug: "acme/example-api_server",
    });
  });

  test("explicit validated overrides win over derived names", () => {
    expect(
      resolveTemplateIdentity({
        repository: "https://github.com/acme/repo.git",
        displayName: "Example API",
        packageName: "example-api",
        serviceName: "example-api-service",
      }),
    ).toEqual({
      displayName: "Example API",
      packageName: "example-api",
      serviceName: "example-api-service",
      repositorySlug: "acme/repo",
    });
  });

  test.each([
    { repository: "acme/repo", displayName: "" },
    { repository: "acme/repo", displayName: "bad\nname" },
    { repository: "acme/repo", packageName: "BadName" },
    { repository: "acme/repo", packageName: "-bad" },
    { repository: "acme/repo", serviceName: "Bad-Service" },
    { repository: "acme/repo", serviceName: "bad_service" },
    { repository: "not-a-repository" },
  ])("rejects invalid explicit identity %#", (input) => {
    expect(() => resolveTemplateIdentity(input)).toThrow();
  });

  test("exports the immutable source template identity", () => {
    expect(SOURCE_TEMPLATE_IDENTITY).toEqual({
      displayName: "Hono-Drizzle-Just",
      packageName: "hono-drizzle-just-template",
      serviceName: "hono-drizzle-just",
      repositorySlug: "Lamy210/Hono-Drizzle-Just",
    });
  });
});

describe("inferIdentityFromOrigin", () => {
  test("uses an explicit repository override without invoking git", async () => {
    let called = false;
    const runner: CommandRunner = {
      run: async () => {
        called = true;
        return { exitCode: 0, stdout: "https://github.com/wrong/repo.git\n", stderr: "" };
      },
    };

    const identity = await inferIdentityFromOrigin(runner, "/repo", {
      repository: "acme/ExampleAPI",
      displayName: "Example API",
    });

    expect(called).toBe(false);
    expect(identity.repositorySlug).toBe("acme/ExampleAPI");
    expect(identity.displayName).toBe("Example API");
  });

  test("infers identity from the GitHub origin", async () => {
    const identity = await inferIdentityFromOrigin(
      fakeRunner({ exitCode: 0, stdout: "git@github.com:acme/ExampleAPI.git\n" }),
      "/repo",
      {},
    );

    expect(identity).toEqual({
      displayName: "ExampleAPI",
      packageName: "exampleapi",
      serviceName: "example-api",
      repositorySlug: "acme/ExampleAPI",
    });
  });

  test("requires --repository when origin is unavailable", async () => {
    await expect(
      inferIdentityFromOrigin(fakeRunner({ exitCode: 2, stderr: "origin missing" }), "/repo", {}),
    ).rejects.toThrow(/--repository/i);
  });

  test("requires --repository when origin is not GitHub", async () => {
    await expect(
      inferIdentityFromOrigin(
        fakeRunner({ exitCode: 0, stdout: "https://gitlab.com/acme/example.git\n" }),
        "/repo",
        {},
      ),
    ).rejects.toThrow(/--repository/i);
  });
});
