import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionsBitField } from "discord.js";
import { sealSession } from "../src/security.js";
import { bestChannel, createWebApp } from "../src/web.js";

function fixture(overrides = {}) {
  const config = {
    appSecret: "this-is-a-test-secret-with-more-than-32-characters",
    publicUrl: "https://example.com/nullius",
    discord: {
      clientId: "123456789",
      clientSecret: "secret",
      callbackUrl: "https://example.com/nullius/auth/discord/callback",
    },
    openRouter: {
      callbackUrl: "https://example.com/nullius/auth/openrouter/callback",
      trialApiKey: "",
      trialLimit: 20,
      monthlyLimitUsd: 5,
    },
  };
  const client = overrides.client || { isReady: () => true };
  const store = overrides.store || { getGuild: () => null };
  const openRouter = overrides.openRouter || {};
  return createWebApp({ config, client, store, openRouter, logger: { error() {} } });
}

async function withServer(run, app = fixture()) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves the setup page and reports health", async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);
    const landing = await page.text();
    assert.match(landing, /Add Nullius to Discord/);
    assert.match(landing, /One mention\. Three layers of confidence\./);
    assert.match(landing, /Daily frontier review/);
    assert.match(landing, /Add to another Discord server/);
    assert.match(landing, /id="add-another-server" href="auth\/discord"/);
    assert.match(landing, /property="og:image" content="https:\/\/timbergeron\.com\/nullius\/og\.png"/);

    const socialCard = await fetch(`${baseUrl}/og.png`);
    assert.equal(socialCard.status, 200);
    assert.equal(socialCard.headers.get("content-type"), "image/png");

    const guide = await fetch(`${baseUrl}/setup.html`);
    assert.equal(guide.status, 200);
    const guideHtml = await guide.text();
    assert.match(guideHtml, /Set up Nullius/);
    assert.match(guideHtml, /guide\.js/);

    const packGuide = await fetch(`${baseUrl}/knowledge-packs.html`);
    assert.equal(packGuide.status, 200);
    assert.match(await packGuide.text(), /Teach Nullius a subject/);

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await healthResponse.json(), { ok: true, discord: true });

    const session = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
    assert.deepEqual(session, { authenticated: false, trialEnabled: false, trialLimit: 20 });

    const missingApi = await fetch(`${baseUrl}/api/missing`);
    assert.equal(missingApi.status, 404);
    assert.deepEqual(await missingApi.json(), { error: "not-found" });

    const missingPage = await fetch(`${baseUrl}/missing`);
    assert.equal(missingPage.status, 404);
    const missingHtml = await missingPage.text();
    assert.match(missingHtml, /This page wandered off/);
    assert.match(missingHtml, /href="\/nullius\/"/);
    assert.equal(missingPage.headers.get("cache-control"), "no-store");
  });
});

test("reports a disconnected Discord client as unhealthy", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, discord: false });
  }, fixture({ client: { isReady: () => false } }));
});

test("builds a Discord install URL with scoped OAuth cookies", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/discord`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://discord.com");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://example.com/nullius/auth/discord/callback",
    );
    assert.equal(location.searchParams.get("scope"), "bot identify");
    assert.match(response.headers.get("set-cookie"), /Secure/);
    assert.match(response.headers.get("set-cookie"), /Path=\/nullius/);
  });
});

test("rejects an OpenRouter callback without an exact OAuth state", async () => {
  let exchangeCalled = false;
  const secret = "this-is-a-test-secret-with-more-than-32-characters";
  const session = sealSession({
    userId: "owner",
    guildId: "guild",
    expiresAt: Date.now() + 60_000,
  }, secret);
  const app = fixture({
    store: { getGuild: () => ({ ownerId: "owner" }) },
    openRouter: {
      async exchangeOAuthCode() {
        exchangeCalled = true;
        return "unexpected";
      },
    },
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/openrouter/callback?code=test`, {
      redirect: "manual",
      headers: {
        Cookie: [
          `nullius_session=${session}`,
          "nullius_openrouter_state=expected",
          "nullius_openrouter_verifier=verifier",
        ].join("; "),
      },
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/nullius/?error=openrouter-state");
    assert.match(response.headers.get("set-cookie"), /nullius_openrouter_state=/);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(exchangeCalled, false);
  }, app);
});

test("chooses a readable text channel and prefers the system channel", () => {
  const me = { id: "bot" };
  const allPermissions = new Set([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  const channel = (id, type, rawPosition, permissions = allPermissions) => ({
    id,
    type,
    rawPosition,
    permissionsFor: () => ({ has: (permission) => permissions.has(permission) }),
  });
  const noHistory = new Set([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
  ]);
  const guild = {
    members: { me },
    systemChannelId: "system",
    channels: {
      cache: new Map([
        ["voice", channel("voice", ChannelType.GuildVoice, 0)],
        ["unreadable", channel("unreadable", ChannelType.GuildText, 1, noHistory)],
        ["general", channel("general", ChannelType.GuildText, 2)],
        ["system", channel("system", ChannelType.GuildText, 3)],
      ]),
    },
  };

  assert.equal(bestChannel(guild).id, "system");
  guild.systemChannelId = "unreadable";
  assert.equal(bestChannel(guild).id, "general");
});
