import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { drive as makeDrive, type drive_v3 } from "@googleapis/drive";
import { z } from "zod";
import {
  getAuthorizedClient,
  listAccounts,
  logout,
  startLogin,
  type PendingLogin,
  type StoredAccount,
} from "./auth.js";
import { credentialsPath, validateAlias } from "./paths.js";
import { existsSync } from "node:fs";
import { openAccountManager } from "./manager.js";

const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";
const GSHEET = "application/vnd.google-apps.spreadsheet";
const GSLIDES = "application/vnd.google-apps.presentation";

const FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed,starred,shared,owners(displayName,emailAddress),driveId";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

type ToolResult = { content: Array<any>; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

/** Escapes a value for use inside a single-quoted Drive query string. */
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function isTextLike(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    /^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml|x-ndjson)$/.test(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[... truncated: showing ${max} of ${s.length} characters. Call again with a larger max_chars or offset to read more.]`;
}

function errorMessage(e: any): string {
  const status = e?.response?.status ?? e?.code;
  const msg = e?.response?.data?.error?.message ?? e?.errors?.[0]?.message ?? e?.message ?? String(e);
  if (String(msg).includes("invalid_grant")) {
    return `${msg}\nThe login for this account expired or was revoked. Add the account again to sign in once more.`;
  }
  return status && typeof status === "number" ? `Google Drive API error ${status}: ${msg}` : String(msg);
}

/** Wraps a handler so API errors come back as tool errors instead of crashing the server. */
function safe<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: "text", text: errorMessage(e) }], isError: true };
    }
  };
}

interface Ctx {
  alias: string;
  drive: drive_v3.Drive;
  readOnly: boolean;
  account: StoredAccount;
}

/**
 * Starts the MCP server.
 *  - with `account`: serves exactly one Google account (one connector per account);
 *  - without it: serves every signed-in account; tools take an `account` argument and
 *    accounts can be added/removed from the conversation (used by the Claude Desktop extension).
 */
export async function startServer(opts: { account?: string; readOnly: boolean }): Promise<void> {
  const fixed = opts.account ? validateAlias(opts.account) : undefined;
  const multi = !fixed;

  const cache = new Map<string, Ctx>();
  const pending = new Map<string, PendingLogin>();

  async function ctx(aliasInput: string | undefined): Promise<Ctx> {
    let alias: string;
    if (fixed) {
      alias = fixed;
    } else if (aliasInput) {
      alias = validateAlias(aliasInput);
    } else {
      const accs = await listAccounts();
      if (accs.length === 1) alias = accs[0].alias;
      else if (!accs.length) throw new Error("No Google account is connected yet. Use add_account first.");
      else throw new Error(`Which account? Pass "account" as one of: ${accs.map((a) => a.alias).join(", ")}.`);
    }
    const hit = cache.get(alias);
    if (hit) return hit;
    const { client, account } = await getAuthorizedClient(alias);
    const c: Ctx = {
      alias,
      drive: makeDrive({ version: "v3", auth: client as any }),
      readOnly: opts.readOnly || account.readOnly,
      account,
    };
    cache.set(alias, c);
    return c;
  }

  const label = (c: Ctx) => (c.account.email ? `${c.alias} (${c.account.email})` : c.alias);

  // Fixed mode: resolve now so a bad alias fails at startup, and use it in descriptions.
  const fixedCtx = fixed ? await ctx(fixed) : undefined;
  const scopeText = fixedCtx ? `the "${fixedCtx.alias}" Google Drive` : "a connected Google Drive account";

  const server = new McpServer(
    { name: fixed ? `google-drive-${fixed}` : "google-drive-multi", version: "0.2.0" },
    {
      instructions: fixedCtx
        ? `This server is connected to ONE Google Drive account: "${label(fixedCtx)}". ` +
          `Every tool here only sees that account's files. If the user means a different account, ` +
          `use that account's own server instead.` +
          (fixedCtx.readOnly ? " This connection is read-only." : "")
        : `This server connects several Google Drive accounts, each saved under a short alias ` +
          `(e.g. "trabalho", "pessoal", "jogos"). Call list_accounts to see them. Every Drive tool takes ` +
          `an "account" argument: use the account the user means, and if it is unclear which one, ask ` +
          `instead of guessing. Never copy or move data between accounts unless the user explicitly asks. ` +
          `Always say which account you used. To see, add or remove accounts, call manage_accounts: it opens ` +
          `a screen in the user's browser. add_account also works directly from the chat.`,
    },
  );

  // `account` argument only exists in multi-account mode.
  const acct: Record<string, z.ZodTypeAny> = multi
    ? { account: z.string().describe('Account alias from list_accounts, e.g. "trabalho"') }
    : {};
  type A = { account?: string };

  async function writable(a: A): Promise<Ctx> {
    const c = await ctx(a.account);
    if (c.readOnly) throw new Error(`Account "${c.alias}" is connected read-only.`);
    return c;
  }

  // ------------------------------------------------------------ account management

  if (multi) {
    server.registerTool(
      "manage_accounts",
      {
        title: "Open account screen",
        description:
          "Open a page in the user's browser that shows the connected Google accounts and lets them add or remove accounts. " +
          "Use this whenever the user wants to see, add, connect or remove Google Drive accounts.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async () => {
        const url = await openAccountManager(() => cache.clear());
        return text(
          `Opened the account screen in the user's browser. If it didn't open, give them this link (it only works on this computer):\n${url}`,
        );
      }),
    );

    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        description: "List the Google accounts connected to this Drive connector, with their aliases and emails.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async () => {
        const accs = await listAccounts();
        return json({
          accounts: accs.map((a) => ({ alias: a.alias, email: a.email ?? null, readOnly: a.readOnly })),
          waitingForBrowserLogin: [...pending.keys()],
          ...(accs.length ? {} : { hint: "No accounts yet. Use add_account to connect one." }),
        });
      }),
    );

    server.registerTool(
      "add_account",
      {
        title: "Add Google account",
        description:
          "Connect a new Google account under a short alias. Opens the user's browser to sign in with Google; " +
          "the user picks the account there. Returns immediately — ask the user to finish signing in, then call list_accounts to confirm.",
        inputSchema: {
          alias: z.string().describe('Short lowercase name for the account, e.g. "trabalho", "pessoal", "jogos"'),
          email: z.string().optional().describe("Optional: preselect this Google account on the sign-in page"),
          read_only: z.boolean().optional().describe("Connect with read-only access (no editing)"),
          replace: z.boolean().optional().describe("Sign in again for an alias that already exists"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async (a) => {
        const alias = validateAlias(a.alias);
        if (!existsSync(credentialsPath())) {
          throw new Error(
            `Google OAuth client file not found at ${credentialsPath()}. ` +
              `Set it in the extension settings (Google OAuth client file) — see the README, "Google Cloud setup".`,
          );
        }
        const existing = (await listAccounts()).find((x) => x.alias === alias);
        if (existing && !a.replace) {
          throw new Error(
            `Account "${alias}" already exists (${existing.email ?? "email unknown"}). Pass replace=true to sign in again.`,
          );
        }
        const p = await startLogin(alias, { readOnly: !!a.read_only, loginHint: a.email, timeoutMs: 10 * 60_000 });
        pending.set(alias, p);
        p.done
          .then(() => cache.delete(alias))
          .catch(() => {})
          .finally(() => pending.delete(alias));
        return text(
          `Opened the browser to sign in for "${alias}". Ask the user to choose the Google account they want as "${alias}" ` +
            `and allow access. If Google shows "app not verified", that's their own app: Advanced → Go to multi-drive-mcp. ` +
            `If the browser didn't open, give them this link:\n${p.authUrl}\n\n` +
            `After they finish, call list_accounts to confirm. The sign-in link expires in 10 minutes.`,
        );
      }),
    );

    server.registerTool(
      "remove_account",
      {
        title: "Remove Google account",
        description: "Disconnect a Google account: revokes this app's access to it and deletes the saved login. Files in Drive are not touched.",
        inputSchema: { alias: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      safe(async (a) => {
        const alias = validateAlias(a.alias);
        cache.delete(alias);
        return text((await logout(alias)) ? `Account "${alias}" disconnected.` : `No account named "${alias}".`);
      }),
    );
  }

  // ---------------------------------------------------------------- read tools

  server.registerTool(
    "account_info",
    {
      title: "Account info",
      description: `Shows which Google account is used for ${scopeText} and its storage usage.`,
      inputSchema: { ...acct },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: A) => {
      const c = await ctx(a.account);
      const { data } = await c.drive.about.get({ fields: "user(displayName,emailAddress),storageQuota" });
      return json({ account: c.alias, readOnly: c.readOnly, user: data.user, storageQuota: data.storageQuota });
    }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description:
        `Search files in ${scopeText} by name and content. ` +
        `Use "query" for plain words; use "raw_query" only for Drive query syntax (e.g. "modifiedTime > '2026-01-01'").`,
      inputSchema: {
        ...acct,
        query: z.string().optional().describe("Words to look for in file names and contents"),
        name_only: z.boolean().optional().describe("Match only file names, not contents"),
        mime_type: z.string().optional().describe('Filter by MIME type, e.g. "application/pdf" or "application/vnd.google-apps.document"'),
        folder_id: z.string().optional().describe("Only files directly inside this folder"),
        raw_query: z.string().optional().describe("Extra Drive API query clause, ANDed with the rest"),
        include_trashed: z.boolean().optional(),
        page_size: z.number().int().min(1).max(100).optional().describe("Default 25"),
        page_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: any) => {
      const c = await ctx(a.account);
      const clauses: string[] = [];
      if (a.query) clauses.push(a.name_only ? `name contains '${q(a.query)}'` : `fullText contains '${q(a.query)}'`);
      if (a.mime_type) clauses.push(`mimeType = '${q(a.mime_type)}'`);
      if (a.folder_id) clauses.push(`'${q(a.folder_id)}' in parents`);
      if (!a.include_trashed) clauses.push("trashed = false");
      if (a.raw_query) clauses.push(`(${a.raw_query})`);
      const { data } = await c.drive.files.list({
        q: clauses.join(" and ") || undefined,
        pageSize: a.page_size ?? 25,
        pageToken: a.page_token,
        fields: LIST_FIELDS,
        corpora: "allDrives",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        // Drive rejects orderBy together with fullText search
        orderBy: a.query && !a.name_only ? undefined : "modifiedTime desc",
      });
      return json({ account: c.alias, files: data.files ?? [], nextPageToken: data.nextPageToken ?? null });
    }),
  );

  server.registerTool(
    "list_folder",
    {
      title: "List folder",
      description: `List the files and subfolders inside a folder of ${scopeText}. Omit folder_id for the root of My Drive.`,
      inputSchema: {
        ...acct,
        folder_id: z.string().optional().describe('Folder ID; default "root"'),
        page_size: z.number().int().min(1).max(200).optional().describe("Default 50"),
        page_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: any) => {
      const c = await ctx(a.account);
      const { data } = await c.drive.files.list({
        q: `'${q(a.folder_id ?? "root")}' in parents and trashed = false`,
        pageSize: a.page_size ?? 50,
        pageToken: a.page_token,
        fields: LIST_FIELDS,
        orderBy: "folder,name",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      return json({ account: c.alias, folder: a.folder_id ?? "root", files: data.files ?? [], nextPageToken: data.nextPageToken ?? null });
    }),
  );

  const getMeta = async (c: Ctx, fileId: string) =>
    (await c.drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true })).data;

  server.registerTool(
    "get_file_metadata",
    {
      title: "Get file metadata",
      description: "Get name, type, size, dates, owners, parent folders and link of a file.",
      inputSchema: { ...acct, file_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: any) => {
      const c = await ctx(a.account);
      return json({ account: c.alias, ...(await getMeta(c, a.file_id)) });
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file's contents. Google Docs come back as Markdown, Sheets as CSV (first sheet), Slides as plain text, " +
        "text files as-is and images as images. Other binary files (PDF, Office, zip...) return metadata and a link.",
      inputSchema: {
        ...acct,
        file_id: z.string(),
        max_chars: z.number().int().min(1000).max(1_000_000).optional().describe("Default 100000"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from, for long files"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: any) => {
      const c = await ctx(a.account);
      const meta = await getMeta(c, a.file_id);
      const mime = meta.mimeType ?? "";
      const max = a.max_chars ?? 100_000;
      const header = `# ${meta.name}\n(id: ${meta.id}, type: ${mime}, account: ${c.alias})\n\n`;

      const exportAs = async (target: string) => {
        const r = await c.drive.files.export({ fileId: a.file_id, mimeType: target }, { responseType: "text" });
        return String(r.data);
      };

      let body: string | undefined;
      if (mime === GDOC) {
        body = await exportAs("text/markdown").catch(() => exportAs("text/plain"));
      } else if (mime === GSHEET) {
        body = await exportAs("text/csv");
      } else if (mime === GSLIDES) {
        body = await exportAs("text/plain");
      } else if (mime === FOLDER) {
        return text(`${header}This is a folder. Use list_folder with folder_id "${meta.id}".`);
      } else if (mime.startsWith("application/vnd.google-apps.")) {
        return text(`${header}This Google file type can't be exported as text. Open it here: ${meta.webViewLink}`);
      } else {
        const size = Number(meta.size ?? 0);
        if (IMAGE_TYPES.has(mime) && size <= MAX_IMAGE_BYTES) {
          const r = await c.drive.files.get(
            { fileId: a.file_id, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" },
          );
          return {
            content: [
              { type: "text", text: header.trim() },
              { type: "image", data: Buffer.from(r.data as ArrayBuffer).toString("base64"), mimeType: mime },
            ],
          };
        }
        if (!isTextLike(mime)) {
          return text(
            `${header}Binary file (${mime}, ${size} bytes) — its contents can't be shown as text here.\n` +
              `Link: ${meta.webViewLink}`,
          );
        }
        if (size > MAX_DOWNLOAD_BYTES) {
          return text(`${header}File is too large to read (${size} bytes). Link: ${meta.webViewLink}`);
        }
        const r = await c.drive.files.get(
          { fileId: a.file_id, alt: "media", supportsAllDrives: true },
          { responseType: "text" },
        );
        body = String(r.data);
      }
      const sliced = a.offset ? body.slice(a.offset) : body;
      return text(header + truncate(sliced, max));
    }),
  );

  // ---------------------------------------------------------------- write tools
  // Hidden in single-account read-only mode; in multi mode they check per account.

  if (multi || !fixedCtx?.readOnly) {
    server.registerTool(
      "create_file",
      {
        title: "Create file",
        description:
          `Create a new file in ${scopeText}. With as_google_doc=true the content (Markdown) becomes a Google Doc; ` +
          `with as_google_sheet=true the content (CSV) becomes a Google Sheet; otherwise a plain file is created.`,
        inputSchema: {
          ...acct,
          name: z.string().min(1),
          content: z.string().describe("File contents (text, Markdown or CSV)"),
          parent_folder_id: z.string().optional().describe("Folder to create it in; default My Drive root"),
          as_google_doc: z.boolean().optional(),
          as_google_sheet: z.boolean().optional(),
          mime_type: z.string().optional().describe('For plain files; default "text/plain"'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async (a: any) => {
        const c = await writable(a);
        if (a.as_google_doc && a.as_google_sheet) throw new Error("Choose either as_google_doc or as_google_sheet, not both.");
        const target = a.as_google_doc ? GDOC : a.as_google_sheet ? GSHEET : a.mime_type ?? "text/plain";
        const uploadMime = a.as_google_doc ? "text/markdown" : a.as_google_sheet ? "text/csv" : target;
        const { data } = await c.drive.files.create({
          requestBody: { name: a.name, mimeType: target, parents: a.parent_folder_id ? [a.parent_folder_id] : undefined },
          media: { mimeType: uploadMime, body: Readable.from([a.content]) },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ account: c.alias, created: data });
      }),
    );

    server.registerTool(
      "update_file",
      {
        title: "Update file",
        description:
          "Replace a file's contents and/or rename it. For Google Docs the new content is Markdown and replaces the whole " +
          "document; for Google Sheets it is CSV and replaces the first sheet. Read the file first so nothing is lost.",
        inputSchema: {
          ...acct,
          file_id: z.string(),
          content: z.string().optional().describe("New full contents"),
          new_name: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a: any) => {
        const c = await writable(a);
        if (a.content === undefined && !a.new_name) throw new Error("Nothing to update: pass content and/or new_name.");
        const meta = await getMeta(c, a.file_id);
        const mime = meta.mimeType ?? "text/plain";
        const uploadMime = mime === GDOC ? "text/markdown" : mime === GSHEET ? "text/csv" : mime;
        if (a.content !== undefined && mime.startsWith("application/vnd.google-apps.") && mime !== GDOC && mime !== GSHEET) {
          throw new Error(`Content of ${mime} files can't be replaced with text. You can still rename it.`);
        }
        const { data } = await c.drive.files.update({
          fileId: a.file_id,
          requestBody: a.new_name ? { name: a.new_name } : {},
          media: a.content !== undefined ? { mimeType: uploadMime, body: Readable.from([a.content]) } : undefined,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ account: c.alias, updated: data });
      }),
    );

    server.registerTool(
      "create_folder",
      {
        title: "Create folder",
        description: `Create a folder in ${scopeText}.`,
        inputSchema: { ...acct, name: z.string().min(1), parent_folder_id: z.string().optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async (a: any) => {
        const c = await writable(a);
        const { data } = await c.drive.files.create({
          requestBody: { name: a.name, mimeType: FOLDER, parents: a.parent_folder_id ? [a.parent_folder_id] : undefined },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ account: c.alias, created: data });
      }),
    );

    server.registerTool(
      "move_file",
      {
        title: "Move file",
        description: "Move a file or folder into another folder of the same account.",
        inputSchema: { ...acct, file_id: z.string(), new_parent_folder_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a: any) => {
        const c = await writable(a);
        const meta = await getMeta(c, a.file_id);
        const { data } = await c.drive.files.update({
          fileId: a.file_id,
          addParents: a.new_parent_folder_id,
          removeParents: (meta.parents ?? []).join(",") || undefined,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ account: c.alias, moved: data });
      }),
    );

    server.registerTool(
      "trash_file",
      {
        title: "Move to trash",
        description: "Move a file or folder to the trash (it can be restored from Drive for 30 days). Never deletes permanently.",
        inputSchema: { ...acct, file_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a: any) => {
        const c = await writable(a);
        const { data } = await c.drive.files.update({
          fileId: a.file_id,
          requestBody: { trashed: true },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ account: c.alias, trashed: data });
      }),
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `multi-drive-mcp: ${fixedCtx ? `serving account "${label(fixedCtx)}"${fixedCtx.readOnly ? " (read-only)" : ""}` : "multi-account mode"}\n`,
  );
}
