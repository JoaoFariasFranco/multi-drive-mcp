#!/usr/bin/env node
import { parseArgs } from "node:util";
import { listAccounts, login, logout } from "./auth.js";
import { configHome, credentialsPath } from "./paths.js";
import { startServer } from "./server.js";

const HELP = `multi-drive-mcp — connect several Google Drive accounts to Claude (or any MCP client), one server per account.

Usage:
  multi-drive-mcp auth <alias> [--read-only] [--email you@gmail.com]
        Sign in to a Google account and save it under <alias> (e.g. work, personal, games).
  multi-drive-mcp accounts
        List the accounts you have signed in.
  multi-drive-mcp logout <alias>
        Revoke access and delete the saved login for <alias>.
  multi-drive-mcp --account <alias> [--read-only]
        Run the MCP server for one account (this is what goes in your MCP client config).
  multi-drive-mcp paths
        Show where credentials and logins are stored.

Files are stored in: ${configHome()}
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      account: { type: "string", short: "a" },
      "read-only": { type: "boolean", default: false },
      email: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const readOnly = Boolean(values["read-only"]);

  if (values.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (values.account && (!cmd || cmd === "serve")) {
    await startServer(values.account, { readOnly });
    return;
  }

  switch (cmd) {
    case "auth":
    case "login": {
      if (!arg) throw new Error("Missing alias. Example: multi-drive-mcp auth work");
      const acc = await login(arg, { readOnly, loginHint: values.email });
      process.stdout.write(
        `\n✔ "${acc.alias}" connected${acc.email ? ` as ${acc.email}` : ""}${acc.readOnly ? " (read-only)" : ""}.\n` +
          `Add it to your MCP client with:  "args": ["-y", "multi-drive-mcp", "--account", "${acc.alias}"]\n`,
      );
      return;
    }
    case "accounts":
    case "list": {
      const accs = await listAccounts();
      if (!accs.length) {
        process.stdout.write("No accounts yet. Run: multi-drive-mcp auth <alias>\n");
        return;
      }
      for (const a of accs) {
        process.stdout.write(`${a.alias.padEnd(16)} ${a.email ?? "(email unknown)"}${a.readOnly ? "  [read-only]" : ""}\n`);
      }
      return;
    }
    case "logout": {
      if (!arg) throw new Error("Missing alias. Example: multi-drive-mcp logout games");
      process.stdout.write((await logout(arg)) ? `✔ "${arg}" removed.\n` : `No saved login for "${arg}".\n`);
      return;
    }
    case "paths":
      process.stdout.write(`config:      ${configHome()}\ncredentials: ${credentialsPath()}\n`);
      return;
    default:
      process.stdout.write(HELP);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e?.message ?? e}\n`);
  process.exit(1);
});
