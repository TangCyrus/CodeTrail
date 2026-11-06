import { pathToFileURL } from "node:url";
import path from "node:path";
const [bundle, project, cache] = process.argv.slice(2);
const { createLocalServer } = await import(pathToFileURL(path.join(bundle, "apps/local/dist/server.js")).href);
const server = await createLocalServer({ rootDir: project, dataDirectory: cache, ai: { apiKey: "", model: "" } });
const url = await server.listen(0);
process.send({ url });
process.once("message", async () => { await server.app.close(); process.disconnect(); });
