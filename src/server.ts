import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { drive as makeDrive, type drive_v3 } from "@googleapis/drive";
import { z } from "zod";
import { getAuthorizedClient } from "./auth.js";
import { validateAlias } from "./paths.js";

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
    return `${msg}\nThe login for this account expired or was revoked. Run "npx multi-drive-mcp auth <alias>" again.`;
  }
  return status ? `Google Drive API error ${status}: ${msg}` : String(msg);
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

export async function startServer(aliasInput: string, opts: { readOnly: boolean }): Promise<void> {
  const alias = validateAlias(aliasInput);
  const { client, account } = await getAuthorizedClient(alias);
  const readOnly = opts.readOnly || account.readOnly;
  const drive: drive_v3.Drive = makeDrive({ version: "v3", auth: client as any });
  const who = account.email ? `${alias} (${account.email})` : alias;

  const server = new McpServer(
    { name: `google-drive-${alias}`, version: "0.1.0" },
    {
      instructions:
        `This server is connected to ONE Google Drive account: "${who}". ` +
        `Every tool here only sees that account's files. If the user means a different account ` +
        `(another multi-drive-mcp server), use that server's tools instead.` +
        (readOnly ? " This connection is read-only." : ""),
    },
  );

  const getMeta = async (fileId: string) =>
    (await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true })).data;

  // ---------------------------------------------------------------- read tools

  server.registerTool(
    "account_info",
    {
      title: "Account info",
      description: `Shows which Google account this Drive connection uses ("${alias}") and its storage usage.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      const { data } = await drive.about.get({ fields: "user(displayName,emailAddress),storageQuota" });
      return json({ alias, readOnly, user: data.user, storageQuota: data.storageQuota });
    }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description:
        `Search files in the "${alias}" Google Drive by name and content. ` +
        `Use "query" for plain words; use "raw_query" only for Drive query syntax (e.g. "modifiedTime > '2026-01-01'").`,
      inputSchema: {
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
    safe(async (a) => {
      const clauses: string[] = [];
      if (a.query) clauses.push(a.name_only ? `name contains '${q(a.query)}'` : `fullText contains '${q(a.query)}'`);
      if (a.mime_type) clauses.push(`mimeType = '${q(a.mime_type)}'`);
      if (a.folder_id) clauses.push(`'${q(a.folder_id)}' in parents`);
      if (!a.include_trashed) clauses.push("trashed = false");
      if (a.raw_query) clauses.push(`(${a.raw_query})`);
      const { data } = await drive.files.list({
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
      return json({ account: alias, files: data.files ?? [], nextPageToken: data.nextPageToken ?? null });
    }),
  );

  server.registerTool(
    "list_folder",
    {
      title: "List folder",
      description: `List the files and subfolders inside a folder of the "${alias}" Drive. Omit folder_id for the root of My Drive.`,
      inputSchema: {
        folder_id: z.string().optional().describe('Folder ID; default "root"'),
        page_size: z.number().int().min(1).max(200).optional().describe("Default 50"),
        page_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const { data } = await drive.files.list({
        q: `'${q(a.folder_id ?? "root")}' in parents and trashed = false`,
        pageSize: a.page_size ?? 50,
        pageToken: a.page_token,
        fields: LIST_FIELDS,
        orderBy: "folder,name",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      return json({ account: alias, folder: a.folder_id ?? "root", files: data.files ?? [], nextPageToken: data.nextPageToken ?? null });
    }),
  );

  server.registerTool(
    "get_file_metadata",
    {
      title: "Get file metadata",
      description: "Get name, type, size, dates, owners, parent folders and link of a file.",
      inputSchema: { file_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => json(await getMeta(a.file_id))),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file's contents. Google Docs come back as Markdown, Sheets as CSV (first sheet), Slides as plain text, " +
        "text files as-is and images as images. Other binary files (PDF, Office, zip...) return metadata and a link.",
      inputSchema: {
        file_id: z.string(),
        max_chars: z.number().int().min(1000).max(1_000_000).optional().describe("Default 100000"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from, for long files"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a) => {
      const meta = await getMeta(a.file_id);
      const mime = meta.mimeType ?? "";
      const max = a.max_chars ?? 100_000;
      const header = `# ${meta.name}\n(id: ${meta.id}, type: ${mime}, account: ${alias})\n\n`;

      const exportAs = async (target: string) => {
        const r = await drive.files.export({ fileId: a.file_id, mimeType: target }, { responseType: "text" });
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
          const r = await drive.files.get(
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
        const r = await drive.files.get(
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

  if (!readOnly) {
    server.registerTool(
      "create_file",
      {
        title: "Create file",
        description:
          `Create a new file in the "${alias}" Drive. With as_google_doc=true the content (Markdown) becomes a Google Doc; ` +
          `with as_google_sheet=true the content (CSV) becomes a Google Sheet; otherwise a plain file is created.`,
        inputSchema: {
          name: z.string().min(1),
          content: z.string().describe("File contents (text, Markdown or CSV)"),
          parent_folder_id: z.string().optional().describe("Folder to create it in; default My Drive root"),
          as_google_doc: z.boolean().optional(),
          as_google_sheet: z.boolean().optional(),
          mime_type: z.string().optional().describe('For plain files; default "text/plain"'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async (a) => {
        if (a.as_google_doc && a.as_google_sheet) throw new Error("Choose either as_google_doc or as_google_sheet, not both.");
        const target = a.as_google_doc ? GDOC : a.as_google_sheet ? GSHEET : a.mime_type ?? "text/plain";
        const uploadMime = a.as_google_doc ? "text/markdown" : a.as_google_sheet ? "text/csv" : target;
        const { data } = await drive.files.create({
          requestBody: { name: a.name, mimeType: target, parents: a.parent_folder_id ? [a.parent_folder_id] : undefined },
          media: { mimeType: uploadMime, body: Readable.from([a.content]) },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ created: data });
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
          file_id: z.string(),
          content: z.string().optional().describe("New full contents"),
          new_name: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a) => {
        if (a.content === undefined && !a.new_name) throw new Error("Nothing to update: pass content and/or new_name.");
        const meta = await getMeta(a.file_id);
        const mime = meta.mimeType ?? "text/plain";
        const uploadMime = mime === GDOC ? "text/markdown" : mime === GSHEET ? "text/csv" : mime;
        if (a.content !== undefined && mime.startsWith("application/vnd.google-apps.") && mime !== GDOC && mime !== GSHEET) {
          throw new Error(`Content of ${mime} files can't be replaced with text. You can still rename it.`);
        }
        const { data } = await drive.files.update({
          fileId: a.file_id,
          requestBody: a.new_name ? { name: a.new_name } : {},
          media: a.content !== undefined ? { mimeType: uploadMime, body: Readable.from([a.content]) } : undefined,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ updated: data });
      }),
    );

    server.registerTool(
      "create_folder",
      {
        title: "Create folder",
        description: `Create a folder in the "${alias}" Drive.`,
        inputSchema: { name: z.string().min(1), parent_folder_id: z.string().optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async (a) => {
        const { data } = await drive.files.create({
          requestBody: { name: a.name, mimeType: FOLDER, parents: a.parent_folder_id ? [a.parent_folder_id] : undefined },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ created: data });
      }),
    );

    server.registerTool(
      "move_file",
      {
        title: "Move file",
        description: "Move a file or folder into another folder (within this same account).",
        inputSchema: { file_id: z.string(), new_parent_folder_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a) => {
        const meta = await getMeta(a.file_id);
        const { data } = await drive.files.update({
          fileId: a.file_id,
          addParents: a.new_parent_folder_id,
          removeParents: (meta.parents ?? []).join(",") || undefined,
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ moved: data });
      }),
    );

    server.registerTool(
      "trash_file",
      {
        title: "Move to trash",
        description: "Move a file or folder to the trash (it can be restored from Drive for 30 days). Never deletes permanently.",
        inputSchema: { file_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      safe(async (a) => {
        const { data } = await drive.files.update({
          fileId: a.file_id,
          requestBody: { trashed: true },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        return json({ trashed: data });
      }),
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(`multi-drive-mcp: serving account "${who}"${readOnly ? " (read-only)" : ""}\n`);
}
