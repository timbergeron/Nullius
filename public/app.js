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

function setError(target) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("error");
  if (!code) return;
  target.textContent = `○ ${errorMessages[code] || "That didn’t finish. Try once more."}`;
  url.searchParams.delete("error");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function saveNickname(nickname, state) {
  state.textContent = "Saving…";
  state.dataset.status = "saving";
  try {
    const response = await fetch("api/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    });
    if (!response.ok) throw new Error("Nickname failed");
    const data = await response.json();
    state.textContent = "Saved";
    state.dataset.status = "saved";
    return data.nickname;
  } catch {
    state.textContent = "Retry";
    state.dataset.status = "error";
    return null;
  }
}

async function saveKnowledgePacks(packIds, state) {
  state.textContent = "Saving…";
  state.dataset.status = "saving";
  try {
    const response = await fetch("api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packIds }),
    });
    if (!response.ok) throw new Error("Knowledge failed");
    state.textContent = "Saved";
    state.dataset.status = "saved";
    return true;
  } catch {
    state.textContent = "Couldn’t save. Try again.";
    state.dataset.status = "error";
    return false;
  }
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
  let lastSavedNickname = nickname.value;
  let nicknameSave = Promise.resolve();
  const persistNickname = async () => {
    nicknameSave = nicknameSave.then(async () => {
      const candidate = nickname.value.trim();
      if (candidate === lastSavedNickname) return;
      nickname.setAttribute("aria-busy", "true");
      const savedNickname = await saveNickname(candidate, nicknameState);
      nickname.removeAttribute("aria-busy");
      if (savedNickname !== null) lastSavedNickname = savedNickname;
    });
    await nicknameSave;
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

  const openButton = document.querySelector("#open-discord");
  const copiedPrompt = document.querySelector("#copied-prompt");
  openButton.addEventListener("click", async () => {
    const prompt = `<@${data.clientId}> what can you help with?`;
    openButton.disabled = true;
    openButton.setAttribute("aria-busy", "true");
    openButton.textContent = "Opening Discord…";
    const copied = await copyText(prompt);
    copiedPrompt.textContent = copied
      ? "Prompt copied. Opening Discord…"
      : "Opening Discord—mention Nullius to get started.";
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
    document.querySelector("#limit-status").textContent = `$${data.monthlyLimitUsd}/month limit`;
  } else if (data.trialEnabled && data.trialRemaining > 0) {
    trialState.hidden = false;
    openRouterState.hidden = true;
    document.querySelector("#trial-status").textContent = `${data.trialRemaining} free answers remaining`;
  } else {
    trialState.hidden = true;
    openRouterState.hidden = true;
    connectOpenRouter.hidden = false;
  }
  renderKnowledgePacks(data.knowledgePacks);
  setError(document.querySelector("#ready-status"));
}

async function init() {
  try {
    const response = await fetch("api/session", { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "setup-unavailable");
    if (data.authenticated) {
      renderReady(data);
      return;
    }
    show("landing");
    if (!data.trialEnabled) document.querySelector("#trial-copy").hidden = true;
    else document.querySelector("#trial-copy").firstChild.textContent = `${data.trialLimit} answers included `;
    setError(document.querySelector("#landing-status"));
  } catch (error) {
    show("landing");
    document.querySelector("#landing-status").textContent = error.message === "server-unavailable"
      ? "○ Nullius can’t reach that Discord server. Add it again to reconnect."
      : "○ Setup is waking up. Refresh in a moment.";
  }
}

init();
