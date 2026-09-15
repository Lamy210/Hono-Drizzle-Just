import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOpenApiDocument } from "./document";

const outputUrl = new URL("../../openapi/openapi.json", import.meta.url);
const outputPath = fileURLToPath(outputUrl);

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, await renderOpenApiDocument());
console.log("Wrote openapi/openapi.json");
