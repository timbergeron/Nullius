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

`OPENROUTER_MODEL` defaults to `openrouter/auto`. Responses are capped at 350 output tokens and the system prompt asks for two or three sentences by default.

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
| `TRIAL_ANSWER_LIMIT` | No | `20` | Free successful answers per server |
| `DEFAULT_MONTHLY_LIMIT_USD` | No | `5` | Safety cutoff for connected servers |
| `DATA_FILE` | No | `./data/store.json` | Encrypted configuration file location |

The data file needs a persistent disk in production. Storage is isolated in `src/store.js`, so it can later be replaced by Google Sheets or another service without changing the bot.

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
