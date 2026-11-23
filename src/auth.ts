import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { OAuth2Client, CodeChallengeMethod, type Credentials } from "google-auth-library";
import { accountsDir, credentialsPath, tokenPath, validateAlias } from "./paths.js";

export const SCOPE_FULL = "https://www.googleapis.com/auth/drive";
export const SCOPE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

interface ClientSecrets {
  client_id: string;
  client_secret?: string;
}

export interface StoredAccount {
  alias: string;
  email?: string;
  readOnly: boolean;
  tokens: Credentials;
  createdAt: string;
}

/** Reads the OAuth client JSON ("Desktop app" type) downloaded from Google Cloud Console. */
export async function loadClientSecrets(): Promise<ClientSecrets> {
  const p = credentialsPath();
  if (!existsSync(p)) {
    throw new Error(
      `OAuth client file not found at ${p}.\n` +
        `Create a "Desktop app" OAuth client in Google Cloud Console, download the JSON and save it there\n` +
        `(or point MULTI_DRIVE_MCP_CREDENTIALS to it). See the README, section "Google Cloud setup".`,
    );
  }
  const raw = JSON.parse(await readFile(p, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c?.client_id) throw new Error(`${p} does not look like a Google OAuth client file (no client_id).`);
  if (raw.web) {
    process.stderr.write(
      `Warning: ${p} is a "Web application" client. Use a "Desktop app" client so the local login redirect works.\n`,
    );
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

async function saveAccount(acc: StoredAccount): Promise<void> {
  await mkdir(accountsDir(), { recursive: true, mode: 0o700 });
  const p = tokenPath(acc.alias);
  await writeFile(p, JSON.stringify(acc, null, 2), { mode: 0o600 });
  await chmod(p, 0o600).catch(() => {});
}

export async function loadAccount(alias: string): Promise<StoredAccount> {
  const p = tokenPath(alias);
  if (!existsSync(p)) {
    throw new Error(
      `Account "${alias}" is not logged in. Run:  npx multi-drive-mcp auth ${alias}`,
    );
  }
  return JSON.parse(await readFile(p, "utf8")) as StoredAccount;
}

/** OAuth client for a stored account. Refreshed tokens are written back to disk automatically. */
export async function getAuthorizedClient(alias: string): Promise<{ client: OAuth2Client; account: StoredAccount }> {
  const secrets = await loadClientSecrets();
  const account = await loadAccount(alias);
  const client = new OAuth2Client({ clientId: secrets.client_id, clientSecret: secrets.client_secret });
  client.setCredentials(account.tokens);
  client.on("tokens", (t) => {
    account.tokens = { ...account.tokens, ...t, refresh_token: t.refresh_token ?? account.tokens.refresh_token };
    saveAccount(account).catch((e) => process.stderr.write(`Could not persist refreshed token: ${e}\n`));
  });
  return { client, account };
}

function openBrowser(url: string): void {
  // On Windows, avoid `cmd /c start`: cmd treats "&" in the URL as a command separator
  // and truncates the OAuth URL. rundll32 passes the URL through untouched.
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

/**
 * Interactive login for one alias using the loopback redirect + PKCE flow
 * recommended by Google for desktop apps.
 */
export async function login(aliasInput: string, opts: { readOnly: boolean; loginHint?: string }): Promise<StoredAccount> {
  const alias = validateAlias(aliasInput);
  const secrets = await loadClientSecrets();
  const state = randomBytes(16).toString("hex");

  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = new OAuth2Client({
    clientId: secrets.client_id,
    clientSecret: secrets.client_secret,
    redirectUri,
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const scopes = [opts.readOnly ? SCOPE_READONLY : SCOPE_FULL, "openid", "email"];
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    login_hint: opts.loginHint,
  });

  const tokens = await new Promise<Credentials>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google login (5 minutes).")), 5 * 60_000);
    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (err || !got || url.searchParams.get("state") !== state) {
        res.end(page("Login failed", `Google returned: ${err ?? "invalid response"}. You can close this tab.`));
        clearTimeout(timer);
        reject(new Error(`Login failed: ${err ?? "invalid state or missing code"}`));
        return;
      }
      clearTimeout(timer);
      try {
        const { tokens } = await client.getToken({ code: got, codeVerifier, redirect_uri: redirectUri });
        res.end(page("Connected ✔", `Account <b>${alias}</b> is connected. You can close this tab and go back to the terminal.`));
        resolve(tokens);
      } catch (e: any) {
        res.end(page("Login failed", `Could not finish signing in (${e?.message ?? e}). Check the terminal.`));
        reject(e);
      }
    });

    process.stderr.write(`\nOpening your browser to sign in for account "${alias}".\n`);
    process.stderr.write(`Pick the Google account you want to use as "${alias}".\n`);
    process.stderr.write(`If the browser doesn't open, paste this URL:\n\n${authUrl}\n\n`);
    openBrowser(authUrl);
  }).finally(() => server.close());

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/permissions and try again.",
    );
  }
  let email: string | undefined;
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: secrets.client_id });
      email = ticket.getPayload()?.email;
    } catch {
      /* email is cosmetic */
    }
  }

  const acc: StoredAccount = { alias, email, readOnly: opts.readOnly, tokens, createdAt: new Date().toISOString() };
  await saveAccount(acc);
  return acc;
}

export async function listAccounts(): Promise<StoredAccount[]> {
  if (!existsSync(accountsDir())) return [];
  const files = (await readdir(accountsDir())).filter((f) => f.endsWith(".json"));
  const out: StoredAccount[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(`${accountsDir()}/${f}`, "utf8")));
    } catch {
      /* skip corrupt files */
    }
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Revokes the token at Google (best effort) and deletes the local file. */
export async function logout(aliasInput: string): Promise<boolean> {
  const alias = validateAlias(aliasInput);
  const p = tokenPath(alias);
  if (!existsSync(p)) return false;
  try {
    const acc = await loadAccount(alias);
    const token = acc.tokens.refresh_token ?? acc.tokens.access_token;
    if (token) await new OAuth2Client().revokeToken(token);
  } catch {
    /* still delete locally */
  }
  await rm(p);
  return true;
}
