# Nullius

Nullius is a quiet, mention-only AI bot for Discord. Mention it in a channel and it answers from the ten preceding messages plus any explicit reply chain. When an enabled knowledge pack supplies evidence, Nullius checks the source and adversarially reviews its draft before replying.

The entire V1 is one Node process:

- a phone-first installation page;
- Discord OAuth and the bot Gateway connection;
- a small encrypted file for per-server configuration;
- OpenRouter OAuth and chat completions.

There is no conversation database. Only when invoked, Nullius reads a bounded recent-channel window and any explicit reply chain. It does not store message content.

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

`OPENROUTER_MODEL` defaults to `openrouter/auto`. The system prompt asks for two or three sentences by default. Nullius normally allows up to 4,096 completion tokens because reasoning models count hidden reasoning against that budget. If OpenRouter returns an empty or length-limited result, Nullius retries once with an 8,192-token ceiling. Each provider attempt has a configurable 90-second timeout. These are ceilings, not requested answer lengths.

`QSSM_OPENROUTER_MODEL` can route only QSS-M-backed answers through a different
operator-selected model. It is the default for both the draft and adversarial review when
QSS-M actually supplies evidence, and falls back to `OPENROUTER_MODEL` when unset. The
daily premium model below replaces the final review while that server's quota is available.

`QSSM_PREMIUM_OPENROUTER_MODEL` upgrades the final review for the first QSS-M-backed
answer each UTC day per server. The daily limit defaults to one and can be changed or
disabled with `QSSM_PREMIUM_DAILY_LIMIT`. A successful premium review consumes the quota;
a failed attempt falls back to the draft and leaves it available. Nullius stores only the
UTC date and count, not message content.

Each connected server starts with a $5 monthly safety limit. Nullius tracks the cost returned with each OpenRouter response and stops before starting another request once the limit has been reached.

Requests are serialized per Discord server. The first starts immediately and up to five more wait in arrival order. Nullius acknowledges each queued mention with its position, allows at most one waiting request per user, and expires queued work after five minutes rather than answering stale conversation later. This lifetime is deliberately longer than a normal provider attempt and its one permitted completion retry.

While an active request is collecting context, retrieving knowledge, and waiting on model
passes, Nullius refreshes Discord's typing indicator every eight seconds. The refresh loop
ends only after the answer or error response has finished sending.

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
| `QSSM_OPENROUTER_MODEL` | No | — | Default model override for the QSS-M draft and review |
| `QSSM_PREMIUM_OPENROUTER_MODEL` | No | — | Optional final-review model for the first daily QSS-M answer per server |
| `QSSM_PREMIUM_DAILY_LIMIT` | No | `1` | Successful premium QSS-M reviews per server per UTC day; `0` disables |
| `MAX_OUTPUT_TOKENS` | No | `4096` | Normal OpenRouter completion-token ceiling |
| `MAX_RETRY_OUTPUT_TOKENS` | No | `8192` | One-time retry ceiling for an empty or length-limited result |
| `OPENROUTER_TIMEOUT_SECONDS` | No | `90` | Timeout for each provider attempt; capped at 180 seconds |
| `CHANNEL_CONTEXT_MESSAGES` | No | `10` | Messages immediately before the invocation to read; `0` disables ambient context |
| `MAX_CONTEXT_MESSAGES` | No | `12` | Maximum depth of an explicit Discord reply chain |
| `MAX_CONTEXT_CHARACTERS` | No | `16000` | Shared character ceiling for recent and reply-chain context |
| `REQUEST_QUEUE_MAX_PENDING` | No | `5` | Maximum waiting requests per Discord server; capped at 25 |
| `REQUEST_QUEUE_MAX_AGE_SECONDS` | No | `300` | Discard queued requests older than this; capped at 300 seconds |
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

Answers that use a knowledge pack get an adversarial second model pass. The reviewer sees
the same conversation and retrieved evidence plus the first draft, checks claims and
citations skeptically, and returns only a corrected final answer. Ordinary requests stay
single-pass. A reviewed answer therefore normally makes two billable model completions;
their reported costs are added together for the server's monthly usage total.

For QSS-M, the first successful reviewed answer per server each UTC day can use a stronger
final-review model automatically. The user asks normally—there is no premium command or
mode to discover. Later QSS-M answers use the configured QSS-M model, and failed premium
reviews do not consume the daily quota.

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
OPENROUTER_MODEL=z-ai/glm-5.3-flash
QSSM_OPENROUTER_MODEL=openai/gpt-5.6-luna-pro
QSSM_PREMIUM_OPENROUTER_MODEL=openai/gpt-5.6-sol
QSSM_PREMIUM_DAILY_LIMIT=1
KNOWLEDGE_ENABLED=true
KNOWLEDGE_SOURCE_QSSM=/home/woods/codedev/QSS-M
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
- background collection or storage of channel history;
- attachments, image understanding, tools, and web search;
- autonomous messages and long-term memory;
- a general-purpose dashboard.

Nullius is summoned, never intrusive.
