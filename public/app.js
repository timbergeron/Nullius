const loadingScreen = document.querySelector("#loading-screen");
const landingScreen = document.querySelector("#landing-screen");
const readyScreen = document.querySelector("#ready-screen");
const landingNav = document.querySelector("#landing-nav");
const errorMessages = {
  "discord-state": "That Discord connection expired. Try once more.",
  "discord-cancelled": "Discord wasn’t connected yet.",
  discord: "Discord didn’t finish connecting. Try once more.",
  "missing-server": "Choose a Discord server to continue.",
  "openrouter-state": "That OpenRouter connection expired. Try once more.",
  "openrouter-cancelled": "OpenRouter wasn’t connected yet.",
  openrouter: "OpenRouter didn’t finish connecting. Try once more.",
  session: "Your setup session expired. Connect Discord again.",
};

function show(screen) {
  loadingScreen.hidden = true;
  landingScreen.hidden = screen !== "landing";
  readyScreen.hidden = screen !== "ready";
  landingNav.hidden = screen !== "landing";
}

function consumeQueryMessage(target, guildName = "") {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("error");
  if (code) {
    target.textContent = `○ ${errorMessages[code] || "That didn’t finish. Try once more."}`;
  } else if (guildName && url.searchParams.get("openrouter") === "connected") {
    target.textContent = "✓ OpenRouter connected. Nullius is ready to use.";
  } else if (guildName && url.searchParams.get("installed") === "1") {
    target.textContent = `✓ Nullius was added to ${guildName}.`;
  }
  url.searchParams.delete("error");
  url.searchParams.delete("installed");
  url.searchParams.delete("openrouter");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function requestJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "request-failed");
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

async function saveNickname(nickname, state) {
  state.textContent = "Saving…";
  state.dataset.status = "saving";
  try {
    const data = await requestJson("api/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    });
    state.textContent = "Saved";
    state.dataset.status = "saved";
    return data.nickname;
  } catch {
    state.textContent = "Not saved";
    state.dataset.status = "error";
    return null;
  }
}

async function saveKnowledgePacks(packIds, state) {
  state.textContent = "Saving…";
  state.dataset.status = "saving";
  try {
    await requestJson("api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packIds }),
    });
    state.textContent = "Saved";
    state.dataset.status = "saved";
    return true;
  } catch {
    state.textContent = "Couldn’t save. Try again.";
    state.dataset.status = "error";
    return false;
  }
}

function formatUsd(value) {
  const amount = Math.max(0, Number(value) || 0);
  const fractionDigits = amount > 0 && amount < 0.01 ? 3 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

function renderKnowledgePacks(packs) {
  const fieldset = document.querySelector("#knowledge-packs");
  const list = document.querySelector("#knowledge-list");
  const state = document.querySelector("#knowledge-state");
  if (!packs?.length) return;
  fieldset.hidden = false;

  for (const pack of packs) {
    const row = document.createElement("label");
    row.className = "knowledge-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = pack.enabled;
    input.disabled = !pack.ready;
    input.dataset.packId = pack.id;
    input.dataset.ready = String(pack.ready);
    const text = document.createElement("span");
    text.innerHTML = "";
    const name = document.createElement("strong");
    name.textContent = pack.name;
    const detail = document.createElement("small");
    detail.textContent = pack.ready ? pack.description : "Index not built yet";
    text.append(name, document.createElement("br"), detail);
    if (pack.id === "qssm" && pack.ready) {
      const capabilities = document.createElement("span");
      capabilities.className = "knowledge-capabilities";
      capabilities.textContent = "Source-backed · Double-checked · Daily frontier review";
      text.append(capabilities);
    }
    row.append(input, text);
    list.append(row);
  }

  let savedPackIds = new Set(
    packs.filter((pack) => pack.enabled && pack.ready).map((pack) => pack.id),
  );
  list.addEventListener("change", async () => {
    const inputs = [...list.querySelectorAll("input")];
    const packIds = inputs.filter(
      (input) => input.checked && input.dataset.ready === "true",
    ).map(
      (input) => input.dataset.packId,
    );
    inputs.forEach((input) => { input.disabled = true; });
    fieldset.setAttribute("aria-busy", "true");
    const saved = await saveKnowledgePacks(packIds, state);
    if (saved) {
      savedPackIds = new Set(packIds);
    } else {
      inputs.forEach((input) => { input.checked = savedPackIds.has(input.dataset.packId); });
    }
    inputs.forEach((input) => { input.disabled = input.dataset.ready !== "true"; });
    fieldset.removeAttribute("aria-busy");
  });
}

async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    let textarea;
    try {
      textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.className = "clipboard-helper";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      return copied;
    } catch {
      return false;
    } finally {
      textarea?.remove();
    }
  }
}

function renderReady(data) {
  show("ready");
  document.querySelector("#server-name").textContent = data.guild.name;
  const serverIcon = document.querySelector("#server-icon");
  const serverInitial = document.querySelector("#server-initial");
  serverInitial.textContent = data.guild.name.slice(0, 1).toUpperCase();
  if (data.guild.iconUrl) {
    serverIcon.src = data.guild.iconUrl;
    serverIcon.hidden = false;
    serverInitial.hidden = true;
    serverIcon.addEventListener("error", () => {
      serverIcon.hidden = true;
      serverInitial.hidden = false;
    }, { once: true });
  }

  const nickname = document.querySelector("#nickname");
  const nicknameState = document.querySelector("#nickname-state");
  nickname.value = data.guild.nickname;
  let nicknameTimer;
  let lastSavedNickname = nickname.value.trim();
  let nicknameSave = Promise.resolve(true);
  let nicknameSaveRunning = false;
  const persistNickname = () => {
    if (nicknameSaveRunning) return nicknameSave;
    nicknameSaveRunning = true;
    nicknameSave = (async () => {
      while (nickname.value.trim() !== lastSavedNickname) {
        const candidate = nickname.value.trim();
        nickname.setAttribute("aria-busy", "true");
        const savedNickname = await saveNickname(candidate, nicknameState);
        nickname.removeAttribute("aria-busy");
        if (savedNickname === null) return false;
        lastSavedNickname = savedNickname;
      }
      return true;
    })().finally(() => { nicknameSaveRunning = false; });
    return nicknameSave;
  };
  nickname.addEventListener("input", () => {
    nicknameState.textContent = "";
    delete nicknameState.dataset.status;
    clearTimeout(nicknameTimer);
    nicknameTimer = setTimeout(persistNickname, 600);
  });
  nickname.addEventListener("blur", () => {
    clearTimeout(nicknameTimer);
    persistNickname();
  });
  nickname.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    nickname.blur();
  });

  const openButton = document.querySelector("#open-discord");
  const copiedPrompt = document.querySelector("#copied-prompt");
  openButton.addEventListener("click", async () => {
    const prompt = `<@${data.clientId}> what can you help with?`;
    openButton.disabled = true;
    openButton.setAttribute("aria-busy", "true");
    openButton.textContent = "Finishing setup…";
    clearTimeout(nicknameTimer);
    const nicknameSaved = await persistNickname();
    openButton.textContent = "Opening Discord…";
    const copied = await copyText(prompt);
    if (!nicknameSaved) {
      copiedPrompt.textContent = copied
        ? "Nickname not saved. Prompt copied; opening Discord…"
        : "Nickname not saved. Opening Discord—mention Nullius to begin.";
    } else {
      copiedPrompt.textContent = copied
        ? "Prompt copied. Opening Discord…"
        : "Opening Discord—mention Nullius to get started.";
    }
    window.setTimeout(() => {
      window.location.assign(data.guild.channelUrl);
    }, 300);
  });

  const trialState = document.querySelector("#trial-state");
  const openRouterState = document.querySelector("#openrouter-state");
  const connectOpenRouter = document.querySelector("#connect-openrouter");
  if (data.openRouterConnected) {
    trialState.hidden = true;
    openRouterState.hidden = false;
    const usage = Math.max(0, Number(data.monthlyUsageUsd) || 0);
    const limit = Math.max(0, Number(data.monthlyLimitUsd) || 0);
    const usageTrack = document.querySelector("#usage-track");
    document.querySelector("#limit-status").textContent = `${formatUsd(usage)} of ${formatUsd(limit)}`;
    document.querySelector("#usage-fill").style.width = `${
      limit > 0 ? Math.min(100, (usage / limit) * 100) : 0
    }%`;
    usageTrack.setAttribute("aria-valuenow", String(usage));
    usageTrack.setAttribute("aria-valuemax", String(limit));
    usageTrack.setAttribute("aria-valuetext", `${formatUsd(usage)} of ${formatUsd(limit)} used this month`);
  } else if (data.trialEnabled) {
    trialState.hidden = false;
    openRouterState.hidden = true;
    const remaining = Math.max(0, Number(data.trialRemaining) || 0);
    trialState.dataset.status = remaining > 0 ? "active" : "attention";
    document.querySelector("#trial-status").textContent = remaining > 0
      ? `${remaining} included answer${remaining === 1 ? "" : "s"} remaining`
      : "Included answers used";
  } else {
    trialState.hidden = true;
    openRouterState.hidden = true;
  }
  if (!data.openRouterConnected) {
    connectOpenRouter.hidden = false;
    connectOpenRouter.textContent = data.trialEnabled && data.trialRemaining > 0
      ? "Connect your OpenRouter"
      : "Connect OpenRouter";
  }
  renderKnowledgePacks(data.knowledgePacks);
  consumeQueryMessage(document.querySelector("#ready-status"), data.guild.name);
}

async function init() {
  try {
    const data = await requestJson("api/session", { headers: { Accept: "application/json" } });
    if (data.authenticated) {
      renderReady(data);
      return;
    }
    show("landing");
    if (!data.trialEnabled) document.querySelector("#trial-copy").hidden = true;
    else document.querySelector("#trial-copy").firstChild.textContent = `${data.trialLimit} answers included `;
    consumeQueryMessage(document.querySelector("#landing-status"));
  } catch (error) {
    show("landing");
    document.querySelector("#landing-status").textContent = error.message === "server-unavailable"
      ? "○ Nullius can’t reach that Discord server. Add it again to reconnect."
      : "○ Setup is waking up. Refresh in a moment.";
  }
}

init();
