# multi-drive-mcp

**Connect several Google Drive accounts to Claude — work, personal, games — without mixing them.**

[Leia em português](README.pt-BR.md)

Most Google Drive connectors only handle one Google account at a time. `multi-drive-mcp` is a small [MCP](https://modelcontextprotocol.io) server you run **once per account**. Each account shows up as its own connector (`drive-work`, `drive-personal`, `drive-games`...), so you choose which Drive a conversation can see, and the assistant always knows which account it's touching.

```
Claude ──┬── drive-work      → work@company.com
         ├── drive-personal  → me@gmail.com      (read-only)
         └── drive-games     → gamer@gmail.com
```

- 🔒 **Separated by design:** one process and one login per account. Tools never cross accounts.
- 🔑 **Your own Google credentials:** you create the OAuth client, and logins stay on your computer. No third-party server is involved.
- 👀 **Optional read-only mode** per account.
- 🗑️ **No permanent deletes:** "delete" only moves files to the trash.

## Tools

| Tool | What it does |
|---|---|
| `account_info` | Which Google account this connector uses, plus storage usage |
| `search_files` | Search by name/content, type or folder |
| `list_folder` | List a folder (default: My Drive root) |
| `get_file_metadata` | Name, type, size, dates, owners, link |
| `read_file` | Docs → Markdown, Sheets → CSV, Slides → text, text files, images |
| `create_file` | Plain file, or a new Google Doc (from Markdown) / Sheet (from CSV) |
| `update_file` | Replace contents and/or rename |
| `create_folder` | New folder |
| `move_file` | Move to another folder |
| `trash_file` | Move to trash (restorable for 30 days) |

Write tools are hidden when the account is read-only.

## Easiest: Claude Desktop extension (one connector, account screen)

1. Do the **Google Cloud setup** below (step 1) and save `credentials.json`.
2. Download `multi-drive-mcp.mcpb` from the [Releases](https://github.com/JoaoFariasFranco/multi-drive-mcp/releases) page (or build it with `npm run build:mcpb`).
3. In Claude Desktop: **Settings → Extensions → Advanced settings → Install extension…** and pick the file (or just double-click it).
4. In a chat, ask Claude to *"open the Google Drive account screen"*. A page opens in your browser listing the connected accounts, with an **Add account** button.

In this mode all accounts live in one connector, and every Drive tool takes an `account` argument, so Claude always says which account it is using. If you'd rather have one connector per account (so you can switch each on or off per chat), use the manual setup below.

## Manual setup (one connector per account)


You need [Node.js](https://nodejs.org) 18 or newer.

### 1. Google Cloud setup (one time, about 5 minutes)

You create your own OAuth client so the logins belong to you. It's free.

1. Open [console.cloud.google.com](https://console.cloud.google.com) and **create a project** (any name, e.g. `my-drive-mcp`).
2. Go to **APIs & Services → Library**, search **Google Drive API** and click **Enable**.
3. Go to **Google Auth Platform** (OAuth consent screen) → **Get started**:
   - App name: anything. Support email: yours.
   - Audience: **External**.
4. Under **Audience**, either:
   - **Publish app** (recommended): logins don't expire. When you sign in, Google warns that the app is unverified. It's your own app, so click **Advanced → Go to … (unsafe)**. Or:
   - keep it in **Testing** and add each of your Google accounts as a **test user**. Note that in Testing mode **logins expire every 7 days**, and you'll need to run `auth` again.
5. Under **Clients**, choose **Create client → Application type: Desktop app**, then **Download JSON**.
6. Save that file as `credentials.json` in the config folder:
   - macOS / Linux: `~/.config/multi-drive-mcp/credentials.json`
   - Windows: `%APPDATA%\multi-drive-mcp\credentials.json`

   (Run `npx -y multi-drive-mcp paths` to see the exact location.)

All your Google accounts can share this one `credentials.json`.

### 2. Sign in to each account

Pick a short alias for each account and sign in. A browser window opens, and you choose the matching Google account:

```bash
npx -y multi-drive-mcp auth work
npx -y multi-drive-mcp auth personal --read-only
npx -y multi-drive-mcp auth games

npx -y multi-drive-mcp accounts   # check
```

Tip: if your browser is signed in to several Google accounts, use `--email you@gmail.com` to preselect the right one.

### 3. Add them to your MCP client

**Claude Desktop:** go to *Settings → Developer → Edit Config* and edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "drive-work": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "work"]
    },
    "drive-personal": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "personal"]
    },
    "drive-games": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "games"]
    }
  }
}
```

Restart Claude Desktop. Each Drive appears separately in the connectors menu, so you can turn on only the ones a conversation needs.

> On Windows, if `npx` isn't found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "multi-drive-mcp", "--account", "work"]`.

**Claude Code:**

```bash
claude mcp add drive-work -- npx -y multi-drive-mcp --account work
claude mcp add drive-personal -- npx -y multi-drive-mcp --account personal
```

**Other MCP clients:** run `npx -y multi-drive-mcp --account <alias>` as a stdio server.

## Commands

```
multi-drive-mcp auth <alias> [--read-only] [--email you@x.com]   sign in and save an account
multi-drive-mcp accounts                                         list saved accounts
multi-drive-mcp logout <alias>                                   revoke access and delete the login
multi-drive-mcp --account <alias> [--read-only]                  run the MCP server
multi-drive-mcp paths                                            show config locations
```

Environment variables:
- `MULTI_DRIVE_MCP_HOME`: config folder (default `~/.config/multi-drive-mcp`)
- `MULTI_DRIVE_MCP_CREDENTIALS`: path to the OAuth client JSON

## Security & privacy

- Logins (refresh tokens) are stored **only on your computer**, in `accounts/<alias>.json`, readable only by your user (mode 600). Treat that folder like a password.
- Each account is served by its own process with only its own token, so one connector can't read another account's files.
- The default scope is full Drive access, so the assistant can edit and organize files. Use `--read-only` at login for accounts that should only be read.
- `trash_file` never deletes permanently.
- To disconnect, run `multi-drive-mcp logout <alias>`, or remove access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Troubleshooting

| Problem | Fix |
|---|---|
| `OAuth client file not found` | Save the Desktop-app JSON as `credentials.json` (step 1.6) |
| `invalid_grant` / login expired | Run `auth <alias>` again; publish the app to stop the 7-day expiry |
| `Access blocked: app not verified / access_denied` | Add the account as a test user, or publish the app |
| `Google Drive API has not been used in project…` | Enable the Drive API (step 1.2) |
| Wrong account got connected | `logout <alias>`, then `auth <alias> --email the-right@gmail.com` |

## Development

```bash
git clone <this repo> && cd multi-drive-mcp
npm install && npm run build
node dist/cli.js --help
```

## License

MIT
