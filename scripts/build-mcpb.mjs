// Builds multi-drive-mcp.mcpb (Claude Desktop extension).
// If MULTI_DRIVE_MCP_EMBED_CLIENT points to a Google "Desktop app" OAuth client JSON,
// it is baked into the package so users don't need their own. It is never committed.
import { build } from "esbuild";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const clientFile = process.env.MULTI_DRIVE_MCP_EMBED_CLIENT;
const define = {};
if (clientFile) {
  if (!existsSync(clientFile)) throw new Error(`OAuth client file not found: ${clientFile}`);
  const raw = JSON.parse(readFileSync(clientFile, "utf8"));
  define.__EMBEDDED_OAUTH_CLIENT__ = JSON.stringify(JSON.stringify(raw));
  console.log("Embedding OAuth client", (raw.installed ?? raw.web ?? raw).client_id);
} else {
  console.log("No MULTI_DRIVE_MCP_EMBED_CLIENT set: users will need their own credentials.json");
}

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "mcpb/server/index.js",
  define,
  logLevel: "warning",
});
copyFileSync("LICENSE", "mcpb/LICENSE");
execFileSync("npx", ["mcpb", "pack", "mcpb", "multi-drive-mcp.mcpb"], { stdio: "inherit", shell: process.platform === "win32" });
