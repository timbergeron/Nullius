import assert from "node:assert/strict";
import test from "node:test";
import { createWebApp } from "../src/web.js";

const networkTest = { skip: process.env.NULLIUS_NETWORK_TESTS !== "1" };

function fixture() {
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
  const client = { isReady: () => true };
  const store = { getGuild: () => null };
  const openRouter = {};
  return createWebApp({ config, client, store, openRouter, logger: { error() {} } });
}

async function withServer(run) {
  const server = fixture().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves the setup page and reports health", networkTest, async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Add to Discord/);

    const guide = await fetch(`${baseUrl}/setup.html`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /Set up Nullius/);

    const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, discord: true });

    const session = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
    assert.deepEqual(session, { authenticated: false, trialEnabled: false, trialLimit: 20 });
  });
});

test("builds a Discord install URL with the subpath callback", networkTest, async () => {
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
  });
});
