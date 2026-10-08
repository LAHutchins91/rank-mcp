import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { SERVER_NAME, loadConfig } from "./config.js";
import { createRankServer } from "./mcp.js";

const app = createApp();
export default app;

const config = loadConfig();
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const stdio = process.stdin.isTTY !== true;
  app.listen(config.port, "0.0.0.0", () => {
    const line = `${SERVER_NAME} listening on ${config.port}`;
    if (stdio) console.error(line);
    else console.log(line);
  });
  if (stdio) {
    const server = createRankServer(null);
    await server.connect(new StdioServerTransport());
  }
}
