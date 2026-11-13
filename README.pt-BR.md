# multi-drive-mcp

**Conecte várias contas do Google Drive ao Claude (trabalho, pessoal, jogos) sem misturar nada.**

[Read in English](README.md)

A maioria dos conectores do Google Drive só aceita uma conta Google por vez. O `multi-drive-mcp` é um servidor [MCP](https://modelcontextprotocol.io) pequeno que você roda **uma vez para cada conta**. Cada conta aparece como um conector separado (`drive-trabalho`, `drive-pessoal`, `drive-jogos`...). Assim você escolhe qual Drive cada conversa pode ver, e o assistente sempre sabe em qual conta está mexendo.

```
Claude ──┬── drive-trabalho → eu@empresa.com
         ├── drive-pessoal  → eu@gmail.com       (somente leitura)
         └── drive-jogos    → gamer@gmail.com
```

- 🔒 **Separação de verdade:** um processo e um login para cada conta. As ferramentas nunca cruzam contas.
- 🔑 **Credenciais do Google suas:** você cria o próprio cliente OAuth, e os logins ficam no seu computador. Nenhum servidor de terceiros participa.
- 👀 **Modo somente leitura** opcional, por conta.
- 🗑️ **Nada é apagado de vez:** "apagar" só move o arquivo para a lixeira.

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `account_info` | Qual conta Google este conector usa, e o espaço ocupado |
| `search_files` | Busca por nome/conteúdo, tipo ou pasta |
| `list_folder` | Lista uma pasta (padrão: raiz do Meu Drive) |
| `get_file_metadata` | Nome, tipo, tamanho, datas, donos, link |
| `read_file` | Docs → Markdown, Planilhas → CSV, Apresentações → texto, arquivos de texto, imagens |
| `create_file` | Arquivo comum, ou um Google Doc (a partir de Markdown) / Planilha (a partir de CSV) |
| `update_file` | Substitui o conteúdo e/ou renomeia |
| `create_folder` | Cria pasta |
| `move_file` | Move para outra pasta |
| `trash_file` | Manda para a lixeira (dá pra recuperar por 30 dias) |

As ferramentas de escrita ficam escondidas quando a conta é somente leitura.

## Instalação

Você precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

### 1. Configuração no Google Cloud (uma vez só, uns 5 minutos)

Você cria seu próprio cliente OAuth, então os logins são só seus. É gratuito.

1. Abra o [console.cloud.google.com](https://console.cloud.google.com) e **crie um projeto** (qualquer nome, ex.: `meu-drive-mcp`).
2. Vá em **APIs e serviços → Biblioteca**, procure **Google Drive API** e clique em **Ativar**.
3. Vá em **Google Auth Platform** (tela de consentimento OAuth) → **Começar**:
   - Nome do app: qualquer um. E-mail de suporte: o seu.
   - Público: **Externo**.
4. Em **Público**, escolha uma das opções:
   - **Publicar app** (recomendado): os logins não expiram. Na hora de entrar, o Google avisa que o app não é verificado. Como o app é seu, clique em **Avançado → Acessar … (não seguro)**. Ou:
   - deixe em **Teste** e adicione cada conta Google como **usuário de teste**. Nesse modo, **os logins expiram a cada 7 dias**, e você vai precisar rodar o `auth` de novo.
5. Em **Clientes**, clique em **Criar cliente → Tipo de aplicativo: App para computador** e depois em **Baixar JSON**.
6. Salve esse arquivo como `credentials.json` na pasta de configuração:
   - macOS / Linux: `~/.config/multi-drive-mcp/credentials.json`
   - Windows: `%APPDATA%\multi-drive-mcp\credentials.json`

   (Rode `npx -y multi-drive-mcp paths` para ver o caminho exato.)

Todas as suas contas Google podem usar esse mesmo `credentials.json`.

### 2. Faça login em cada conta

Escolha um apelido curto para cada conta e faça login. Vai abrir o navegador, e você escolhe a conta Google correspondente:

```bash
npx -y multi-drive-mcp auth trabalho
npx -y multi-drive-mcp auth pessoal --read-only
npx -y multi-drive-mcp auth jogos

npx -y multi-drive-mcp accounts   # conferir
```

Dica: se o navegador estiver logado em várias contas Google, use `--email voce@gmail.com` para já deixar a conta certa selecionada.

### 3. Adicione ao seu cliente MCP

**Claude Desktop:** vá em *Configurações → Desenvolvedor → Editar configuração* e edite o `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "drive-trabalho": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "trabalho"]
    },
    "drive-pessoal": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "pessoal"]
    },
    "drive-jogos": {
      "command": "npx",
      "args": ["-y", "multi-drive-mcp", "--account", "jogos"]
    }
  }
}
```

Reinicie o Claude Desktop. Cada Drive aparece separado no menu de conectores, e você liga só os que a conversa precisa.

> No Windows, se o `npx` não for encontrado, use `"command": "cmd"` e `"args": ["/c", "npx", "-y", "multi-drive-mcp", "--account", "trabalho"]`.

**Claude Code:**

```bash
claude mcp add drive-trabalho -- npx -y multi-drive-mcp --account trabalho
claude mcp add drive-pessoal -- npx -y multi-drive-mcp --account pessoal
```

**Outros clientes MCP:** rode `npx -y multi-drive-mcp --account <apelido>` como servidor stdio.

## Comandos

```
multi-drive-mcp auth <apelido> [--read-only] [--email voce@x.com]   faz login e salva a conta
multi-drive-mcp accounts                                            lista as contas salvas
multi-drive-mcp logout <apelido>                                    revoga o acesso e apaga o login
multi-drive-mcp --account <apelido> [--read-only]                   roda o servidor MCP
multi-drive-mcp paths                                               mostra onde ficam os arquivos
```

Variáveis de ambiente:
- `MULTI_DRIVE_MCP_HOME`: pasta de configuração (padrão `~/.config/multi-drive-mcp`)
- `MULTI_DRIVE_MCP_CREDENTIALS`: caminho do JSON do cliente OAuth

## Segurança e privacidade

- Os logins (refresh tokens) ficam **só no seu computador**, em `accounts/<apelido>.json`, com leitura permitida apenas para o seu usuário (modo 600). Trate essa pasta como uma senha.
- Cada conta roda num processo próprio, só com o token dela. Por isso, um conector não consegue ler arquivos de outra conta.
- Por padrão o acesso ao Drive é completo, para o assistente poder editar e organizar arquivos. Use `--read-only` no login das contas que só devem ser lidas.
- O `trash_file` nunca apaga de vez.
- Para desconectar, rode `multi-drive-mcp logout <apelido>`, ou remova o acesso em [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Problemas comuns

| Problema | Solução |
|---|---|
| `OAuth client file not found` | Salve o JSON do "App para computador" como `credentials.json` (passo 1.6) |
| `invalid_grant` / login expirou | Rode `auth <apelido>` de novo; publique o app para acabar com a expiração de 7 dias |
| `Acesso bloqueado: app não verificado / access_denied` | Adicione a conta como usuário de teste, ou publique o app |
| `Google Drive API has not been used in project…` | Ative a Drive API (passo 1.2) |
| Conectou a conta errada | `logout <apelido>` e depois `auth <apelido> --email a-certa@gmail.com` |

## Desenvolvimento

```bash
git clone <este repositório> && cd multi-drive-mcp
npm install && npm run build
node dist/cli.js --help
```

## Licença

MIT
