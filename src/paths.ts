import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where everything lives on disk.
 *
 *   <home>/credentials.json        OAuth client downloaded from Google Cloud (shared by all accounts)
 *   <home>/accounts/<alias>.json   tokens for one Google account
 *
 * <home> defaults to ~/.config/multi-drive-mcp (or %APPDATA%\multi-drive-mcp on Windows)
 * and can be overridden with the MULTI_DRIVE_MCP_HOME environment variable.
 */
export function configHome(): string {
  if (process.env.MULTI_DRIVE_MCP_HOME) return process.env.MULTI_DRIVE_MCP_HOME;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "multi-drive-mcp");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "multi-drive-mcp");
}

export function credentialsPath(): string {
  return process.env.MULTI_DRIVE_MCP_CREDENTIALS || join(configHome(), "credentials.json");
}

export function accountsDir(): string {
  return join(configHome(), "accounts");
}

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateAlias(alias: string | undefined): string {
  const a = (alias ?? "").trim().toLowerCase();
  if (!ALIAS_RE.test(a)) {
    throw new Error(
      `Invalid account alias "${alias ?? ""}". Use 1-32 characters: lowercase letters, digits, "-" or "_" (e.g. "work", "personal", "games").`,
    );
  }
  return a;
}

export function tokenPath(alias: string): string {
  return join(accountsDir(), `${validateAlias(alias)}.json`);
}
