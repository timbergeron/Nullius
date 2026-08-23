# Nullius

Nullius is a quiet, mention-only AI bot for Discord. Reply to a message with `@Nullius explain this` and it answers from that reply chain in a few sentences.

The entire V1 is one Node process:

- a phone-first installation page;
- Discord OAuth and the bot Gateway connection;
- a small encrypted file for per-server configuration;
- OpenRouter OAuth and chat completions.

There is no conversation database. Nullius reads the explicit Discord reply chain when invoked and does not store message content.

The live [HTML setup guide](https://timbergeron.com/nullius/setup.html) documents the complete Discord, VPS, OpenRouter, testing, and troubleshooting flow.

## Run it

Requirements: Node.js 22+ and a Discord application.

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot.
2. On the bot page, enable **Message Content Intent** and **Requires OAuth2 Code Grant**.
3. Add `http://localhost:3000/auth/discord/callback` as an OAuth2 redirect during local development. Use your public callback URL in production.
4. Copy `.env.example` to `.env` and fill in the Discord client ID, client secret, bot token, and an `APP_SECRET` of at least 32 random characters.
5. Install and start:

```bash
npm install
npm start
```

Open <http://localhost:3000>. The generated Discord authorization asks only for viewing channels, reading reply history, sending messages, sending in threads, and changing the bot's own server nickname.

## OpenRouter

Set `OPENROUTER_API_KEY` to fund the optional free trial. A successful answer consumes one of the server's `TRIAL_ANSWER_LIMIT` answers; errors do not.

After the trial, the server owner clicks **Connect OpenRouter**. Nullius uses OpenRouter's PKCE authorization flow to receive a dedicated key, validates it, and stores it encrypted with `APP_SECRET`. Users never paste a credential into Nullius.

`OPENROUTER_MODEL` defaults to `openrouter/auto`. The system prompt asks for two or three sentences by default. Nullius normally allows up to 1,600 completion tokens because reasoning models count hidden reasoning against that budget. If OpenRouter returns an empty or length-limited result, Nullius retries once with a 4,096-token ceiling. These are ceilings, not requested answer lengths.

Each connected server starts with a $5 monthly safety limit. Nullius tracks the cost returned with each OpenRouter response and stops before starting another request once the limit has been reached.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_URL` | No | `http://localhost:3000` | Exact public base URL, including a path such as `/nullius` |
| `PORT` | No | `3000` | Local HTTP port |
| `APP_SECRET` | Yes | — | Cookie signing and API-key encryption |
| `DISCORD_CLIENT_ID` | Yes | — | Discord application ID |
| `DISCORD_CLIENT_SECRET` | Yes | — | Discord OAuth secret |
| `DISCORD_BOT_TOKEN` | Yes | — | Shared Nullius bot token |
| `OPENROUTER_API_KEY` | No | — | Operator-funded trial key |
| `OPENROUTER_MODEL` | No | `openrouter/auto` | One server-controlled model/router |
| `MAX_OUTPUT_TOKENS` | No | `1600` | Normal OpenRouter completion-token ceiling |
| `MAX_RETRY_OUTPUT_TOKENS` | No | `4096` | One-time retry ceiling for an empty or length-limited result |
| `TRIAL_ANSWER_LIMIT` | No | `20` | Free successful answers per server |
| `DEFAULT_MONTHLY_LIMIT_USD` | No | `5` | Safety cutoff for connected servers |
| `DATA_FILE` | No | `./data/store.json` | Encrypted configuration file location |
| `KNOWLEDGE_ENABLED` | No | `true` | Set to `false` to switch knowledge packs off |
| `KNOWLEDGE_PACKS_DIR` | No | `./knowledge-packs` | Installed pack definitions |
| `KNOWLEDGE_INDEX_DIR` | No | `./data/knowledge` | Generated search indexes |
| `KNOWLEDGE_MAX_RESULTS` | No | `12` | Global result limit across all selected packs |
| `KNOWLEDGE_MAX_CHARACTERS` | No | `16000` | Global evidence limit across all selected packs |
| `KNOWLEDGE_SOURCE_<MOUNT>` | Per pack | — | Operator-approved local source root for a named mount |

The data file needs a persistent disk in production. Storage is isolated in `src/store.js`, so it can later be replaced by Google Sheets or another service without changing the bot.

## Knowledge packs

A knowledge pack teaches Nullius one subject. It is a directory of declarative JSON and
documentation—not executable code—that names the sources to index, when the subject
applies, how much evidence to retrieve, and how retrieval is tested. The complete
[HTML knowledge-pack authoring guide](public/knowledge-packs.html) contains a copyable
manifest, every source type and evaluation field, the security model, and the exact QSS-M
reproduction procedure.

```
knowledge-packs/qssm/
├── manifest.json      sources, activation, retrieval budget
├── evaluations.json   questions with the evidence each answer needs
└── README.md
```

Four source types are built in: `git-worktree` (files from a local checkout), `git-history`
(commit messages and touched files), `files` (a contained plain directory), and `csv`
(a contained file or public HTTPS CSV). Each source declares an `authority` between 0 and
1, which is what makes current source code outrank a document that describes what the code
used to do.

Local checkouts use named mounts rather than arbitrary environment-variable names. A pack
that declares `"mount": "qssm"` reads only from the operator-approved
`KNOWLEDGE_SOURCE_QSSM` root. Relative paths and symlinks cannot escape a pack or mount.
Remote CSVs are limited to public HTTPS destinations and eight streamed MiB.

Indexing is offline. `scripts/knowledge.js` chunks each source — C source by function,
Markdown and HTML by heading, catalogs by row — extracts console variables, commands,
functions, and filenames as searchable symbols, and writes a SQLite FTS5 index to
`data/knowledge/<pack>.sqlite`. The index is generated data and stays out of Git.

```bash
npm run knowledge:list
npm run knowledge:validate -- qssm
npm run knowledge:build -- qssm
npm run knowledge:test -- qssm
npm run knowledge:query -- qssm "what does r_skywind do?"
```

Builds are atomic: a new index is written beside the old one and swapped into place only
after it succeeds, so a failed rebuild never takes the running bot down with it. A running
bot reloads a successfully replaced index on its next lookup. New packs and manifest
changes require a service restart; stale manifest/index pairs are rejected with a rebuild
instruction.

Searching needs `node:sqlite`, available without a startup flag on Node 22.13 and newer.
Where it is missing, Nullius logs one warning, disables knowledge packs, and keeps answering
normally.

At answer time Nullius looks up exact symbols first, then runs full-text search, then
reranks by source authority, exact evidence, how many chunks of one document matched, and by what the
question is asking for — a question about *when* something changed retrieves commits, and
a question about *where* something lives retrieves code. Evidence is quoted into the
prompt as escaped JSON reference material with a file, row, or commit citation on every
passage. Free-form pack instructions are prohibited; a small validated `answerPolicy`
controls source ordering, provenance, and default-value behavior.

Each server chooses which installed packs apply, on the same setup page as the nickname.
A pack with `activation.mode` of `auto` only joins an answer when the question mentions
one of its bounded domain keywords, an identifier-shaped symbol it knows, or a plain symbol
the pack explicitly marks safe. Global limits apply after results from every selected pack
are merged and reranked.

### The QSS-M pack

[`knowledge-packs/qssm`](knowledge-packs/qssm) indexes the QSS-M engine: 196 source files,
1,052 catalog entries from the published commands and variables sheet, project
documentation, and 3,000 commits—about 11,500 chunks, built in a few seconds. Point
`KNOWLEDGE_SOURCE_QSSM` at a local checkout and run `npm run knowledge:build -- qssm`. Its
rank-aware evaluation suite covers 35 domain questions plus 9 adversarial activation checks
across console variables, commands, source ownership, provenance, history, build instructions,
and ordinary words that overlap the Quake domain.

## Deploy on timbergeron.com

The checked-in deployment files target `https://timbergeron.com/nullius` on local port `3011`.

1. Set these production values in `.env`:

```dotenv
PUBLIC_URL=https://timbergeron.com/nullius
PORT=3011
```

2. In the Discord Developer Portal, register this production OAuth callback:

```
https://timbergeron.com/nullius/auth/discord/callback
```

Nullius supplies `https://timbergeron.com/nullius/auth/openrouter/callback` directly to OpenRouter's PKCE flow; it does not need to be registered in Discord.

3. Install and start the service:

```bash
sudo cp deploy/nullius.service /etc/systemd/system/nullius.service
sudo systemctl daemon-reload
sudo systemctl enable --now nullius
```

4. Copy `deploy/nginx-location.conf` to `/etc/nginx/snippets/nullius.conf`, then add this inside the existing HTTPS `server` block for `timbergeron.com`:

```nginx
include /etc/nginx/snippets/nullius.conf;
```

Validate and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

The `^~` location is intentional: it keeps the site's existing global JavaScript and CSS cache rule from intercepting Nullius assets.

## What V1 intentionally omits

- slash commands and model selection;
- ambient channel-history collection;
- attachments, image understanding, tools, and web search;
- autonomous messages and long-term memory;
- a general-purpose dashboard.

Nullius is summoned, never intrusive.
