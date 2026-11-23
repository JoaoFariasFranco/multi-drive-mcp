import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { listAccounts, logout, openBrowser, startLogin, type PendingLogin } from "./auth.js";
import { credentialsPath, validateAlias } from "./paths.js";

/**
 * A small local web page (127.0.0.1 only) to see connected accounts, add new ones
 * and remove them. Every URL carries a random token so other websites can't drive it.
 */

const T = {
  en: {
    title: "Google Drive accounts",
    subtitle: "Accounts Claude can use. Each one keeps its own separate login.",
    none: "No accounts connected yet.",
    alias: "Name",
    email: "Google account",
    access: "Access",
    full: "Read & edit",
    ro: "Read-only",
    remove: "Remove",
    confirmRemove: "Disconnect this account? Your files in Drive are not touched.",
    add: "Add account",
    aliasLabel: "Name for this account",
    aliasHelp: 'Short and lowercase, e.g. "work", "personal", "games".',
    emailLabel: "Google email (optional)",
    emailHelp: "Preselects the account on Google's page.",
    roLabel: "Read-only (Claude can read but not change files)",
    addBtn: "Continue to Google",
    tip: 'Google will warn that the app is unverified — it is your own app: click "Advanced" → "Go to multi-drive-mcp".',
    added: (a: string) => `Account "${a}" connected.`,
    removed: (a: string) => `Account "${a}" removed.`,
    exists: (a: string) => `There is already an account named "${a}". Remove it first to sign in again.`,
    noCreds: (p: string) =>
      `Google OAuth client file not found at <code>${p}</code>. Set it up first (README, "Google Cloud setup").`,
    stillWaiting: "Still finishing the sign-in… refresh in a few seconds.",
  },
  pt: {
    title: "Contas do Google Drive",
    subtitle: "Contas que o Claude pode usar. Cada uma tem seu próprio login, separado das outras.",
    none: "Nenhuma conta conectada ainda.",
    alias: "Nome",
    email: "Conta Google",
    access: "Acesso",
    full: "Ler e editar",
    ro: "Só leitura",
    remove: "Remover",
    confirmRemove: "Desconectar esta conta? Seus arquivos no Drive não são afetados.",
    add: "Adicionar conta",
    aliasLabel: "Nome para esta conta",
    aliasHelp: 'Curto e minúsculo, ex.: "trabalho", "pessoal", "jogos".',
    emailLabel: "E-mail do Google (opcional)",
    emailHelp: "Já deixa a conta certa selecionada na página do Google.",
    roLabel: "Só leitura (o Claude lê, mas não altera arquivos)",
    addBtn: "Continuar no Google",
    tip: 'O Google vai avisar que o app não é verificado. É o seu próprio app: clique em "Avançado" → "Acessar multi-drive-mcp".',
    added: (a: string) => `Conta "${a}" conectada.`,
    removed: (a: string) => `Conta "${a}" removida.`,
    exists: (a: string) => `Já existe uma conta chamada "${a}". Remova-a antes para entrar de novo.`,
    noCreds: (p: string) =>
      `Arquivo de credencial do Google não encontrado em <code>${p}</code>. Configure-o primeiro (README, "Configuração no Google Cloud").`,
    stillWaiting: "Ainda finalizando o login… atualize em alguns segundos.",
  },
};
type Lang = keyof typeof T;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function langOf(req: IncomingMessage): Lang {
  return /^pt/i.test(req.headers["accept-language"] ?? "") ? "pt" : "en";
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) break;
  }
  return new URLSearchParams(body);
}

let instance: Promise<{ url: string }> | undefined;

export function startAccountManager(onChange?: () => void): Promise<{ url: string }> {
  instance ??= create(onChange);
  return instance;
}

async function create(onChange?: () => void): Promise<{ url: string }> {
  const token = randomBytes(16).toString("hex");
  const pending = new Map<string, PendingLogin>();
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}/`;
  server.unref(); // never keep the process alive just for this page

  const redirect = (res: ServerResponse, query = "") => {
    res.writeHead(303, { Location: base + query }).end();
  };

  async function render(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = T[langOf(req)];
    const added = url.searchParams.get("added");
    if (added && pending.has(added)) {
      // the browser came back before the login finished saving; wait briefly
      await Promise.race([pending.get(added)!.done.catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
    }
    const accounts = await listAccounts();
    let notice = "";
    let kind = "ok";
    if (added) notice = accounts.some((a) => a.alias === added) ? t.added(added) : t.stillWaiting;
    const removed = url.searchParams.get("removed");
    if (removed) notice = t.removed(removed);
    const error = url.searchParams.get("error");
    if (error) {
      notice = error;
      kind = "err";
    }
    const exists = url.searchParams.get("exists");
    if (exists) {
      notice = t.exists(exists);
      kind = "err";
    }
    const hasCreds = existsSync(credentialsPath());

    const rows = accounts
      .map(
        (a) => `<tr>
          <td><b>${esc(a.alias)}</b></td>
          <td>${esc(a.email ?? "—")}</td>
          <td><span class="pill ${a.readOnly ? "ro" : ""}">${a.readOnly ? t.ro : t.full}</span></td>
          <td class="r"><form method="post" action="${base}remove" onsubmit="return confirm(${esc(JSON.stringify(t.confirmRemove))})">
            <input type="hidden" name="alias" value="${esc(a.alias)}"><button class="ghost">${t.remove}</button></form></td>
        </tr>`,
      )
      .join("");

    const html = `<!doctype html><html lang="${langOf(req)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>
  :root{--bg:#f6f5f1;--card:#fff;--ink:#1d1c1a;--mute:#6b6860;--line:#e4e1d9;--acc:#1a73e8;--ok:#e6f4ea;--okt:#137333;--err:#fce8e6;--errt:#b3261e}
  @media (prefers-color-scheme:dark){:root{--bg:#1b1b19;--card:#252523;--ink:#ecebe6;--mute:#a19e96;--line:#3a3935;--ok:#1e3a26;--okt:#8fd19e;--err:#45201d;--errt:#f2b8b5}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:720px;margin:48px auto;padding:0 20px}h1{font-size:26px;margin:0 0 4px}p.sub{color:var(--mute);margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse}td,th{padding:10px 6px;border-bottom:1px solid var(--line);text-align:left}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);font-weight:600}tr:last-child td{border-bottom:0}.r{text-align:right}
  .pill{font-size:12px;padding:2px 9px;border-radius:99px;background:var(--ok);color:var(--okt)}.pill.ro{background:var(--line);color:var(--mute)}
  h2{font-size:17px;margin:0 0 14px}label{display:block;font-weight:600;margin:12px 0 4px}small{color:var(--mute);display:block}
  input[type=text],input[type=email]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font:inherit}
  .check{display:flex;gap:8px;align-items:center;font-weight:400;margin-top:14px}
  button{font:inherit;cursor:pointer;border-radius:9px;padding:9px 16px;border:1px solid var(--acc);background:var(--acc);color:#fff;font-weight:600;margin-top:16px}
  button.ghost{background:transparent;color:var(--mute);border-color:var(--line);padding:5px 12px;margin:0;font-weight:500}
  .notice{padding:10px 14px;border-radius:10px;margin-bottom:18px;background:var(--ok);color:var(--okt)}.notice.err{background:var(--err);color:var(--errt)}
  .empty{color:var(--mute);margin:4px 0}.tip{color:var(--mute);font-size:13px;margin-top:12px}code{font-size:13px}
</style></head><body><main>
<h1>${t.title}</h1><p class="sub">${t.subtitle}</p>
${notice ? `<div class="notice ${kind}">${kind === "err" && !exists ? esc(notice) : notice}</div>` : ""}
${hasCreds ? "" : `<div class="notice err">${t.noCreds(esc(credentialsPath()))}</div>`}
<div class="card">${
      accounts.length
        ? `<table><tr><th>${t.alias}</th><th>${t.email}</th><th>${t.access}</th><th></th></tr>${rows}</table>`
        : `<p class="empty">${t.none}</p>`
    }</div>
<div class="card"><h2>${t.add}</h2>
<form method="post" action="${base}add">
  <label for="alias">${t.aliasLabel}</label><input id="alias" name="alias" type="text" required pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,31}" autocomplete="off"><small>${t.aliasHelp}</small>
  <label for="email">${t.emailLabel}</label><input id="email" name="email" type="email" autocomplete="off"><small>${t.emailHelp}</small>
  <label class="check"><input type="checkbox" name="readonly" value="1"> ${t.roLabel}</label>
  <button ${hasCreds ? "" : "disabled"}>${t.addBtn}</button>
  <p class="tip">${t.tip}</p>
</form></div>
</main></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
  }

  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", base);
      if (!url.pathname.startsWith(`/${token}/`)) {
        res.writeHead(404).end();
        return;
      }
      const route = url.pathname.slice(token.length + 2);
      if (req.method === "GET" && route === "") return await render(req, res, url);

      if (req.method === "POST" && route === "add") {
        const f = await readForm(req);
        let alias: string;
        try {
          alias = validateAlias(f.get("alias") ?? "");
        } catch (e: any) {
          return redirect(res, `?error=${encodeURIComponent(e.message)}`);
        }
        if ((await listAccounts()).some((a) => a.alias === alias)) {
          return redirect(res, `?exists=${encodeURIComponent(alias)}`);
        }
        const p = await startLogin(alias, {
          readOnly: f.get("readonly") === "1",
          loginHint: f.get("email") || undefined,
          openBrowser: false,
          timeoutMs: 10 * 60_000,
          returnUrl: `${base}?added=${encodeURIComponent(alias)}`,
        });
        pending.set(alias, p);
        p.done
          .then(() => onChange?.())
          .catch(() => {})
          .finally(() => setTimeout(() => pending.delete(alias), 30_000));
        res.writeHead(303, { Location: p.authUrl }).end();
        return;
      }

      if (req.method === "POST" && route === "remove") {
        const f = await readForm(req);
        const alias = validateAlias(f.get("alias") ?? "");
        await logout(alias);
        onChange?.();
        return redirect(res, `?removed=${encodeURIComponent(alias)}`);
      }
      res.writeHead(404).end();
    } catch (e: any) {
      if (!res.headersSent) redirect(res, `?error=${encodeURIComponent(e?.message ?? String(e))}`);
    }
  });

  return { url: base };
}

/** Starts the page and opens it in the browser. */
export async function openAccountManager(onChange?: () => void): Promise<string> {
  const { url } = await startAccountManager(onChange);
  openBrowser(url);
  return url;
}
