import { renderOpenApiDocument } from "./document";

const snapshot = Bun.file(new URL("../../openapi/openapi.json", import.meta.url));
if (!(await snapshot.exists())) {
  throw new Error("openapi/openapi.json is missing. Run `bun run openapi:generate` and commit it.");
}

const committed = await snapshot.text();
const generated = await renderOpenApiDocument();
if (committed !== generated) {
  throw new Error(
    "openapi/openapi.json is out of date. Run `bun run openapi:generate`, review the contract change, and commit it.",
  );
}

console.log("OpenAPI snapshot matches the runtime document");
