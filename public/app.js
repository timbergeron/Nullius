const loadingScreen = document.querySelector("#loading-screen");
const landingScreen = document.querySelector("#landing-screen");
const readyScreen = document.querySelector("#ready-screen");
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
}

function setError(target) {
  const code = new URLSearchParams(window.location.search).get("error");
  if (code) target.textContent = `○ ${errorMessages[code] || "That didn’t finish. Try once more."}`;
}

async function saveNickname(input, state) {
  state.textContent = "…";
  try {
    const response = await fetch("api/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: input.value }),
    });
    if (!response.ok) throw new Error("Nickname failed");
    state.textContent = "✓";
  } catch {
    state.textContent = "Try again";
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
  }

  const nickname = document.querySelector("#nickname");
  const nicknameState = document.querySelector("#nickname-state");
  nickname.value = data.guild.nickname;
  let nicknameTimer;
  let lastSavedNickname = nickname.value;
  const persistNickname = async () => {
    if (nickname.value === lastSavedNickname) return;
    await saveNickname(nickname, nicknameState);
    if (nicknameState.textContent === "✓") lastSavedNickname = nickname.value;
  };
  nickname.addEventListener("input", () => {
    nicknameState.textContent = "";
    clearTimeout(nicknameTimer);
    nicknameTimer = setTimeout(persistNickname, 600);
  });
  nickname.addEventListener("blur", () => {
    clearTimeout(nicknameTimer);
    persistNickname();
  });

  const openButton = document.querySelector("#open-discord");
  const copiedPrompt = document.querySelector("#copied-prompt");
  openButton.addEventListener("click", () => {
    const prompt = `<@${data.clientId}> what can you help with?`;
    navigator.clipboard?.writeText(prompt).catch(() => {});
    copiedPrompt.textContent = "Prompt copied. Paste it into Discord.";
    window.setTimeout(() => {
      window.location.assign(data.guild.channelUrl);
    }, 180);
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
  setError(document.querySelector("#ready-status"));
}

async function init() {
  try {
    const response = await fetch("api/session", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (data.authenticated) {
      renderReady(data);
      return;
    }
    show("landing");
    if (!data.trialEnabled) document.querySelector("#trial-copy").hidden = true;
    else document.querySelector("#trial-copy").firstChild.textContent = `${data.trialLimit} answers included `;
    setError(document.querySelector("#landing-status"));
  } catch {
    show("landing");
    document.querySelector("#landing-status").textContent = "○ Setup is waking up. Refresh in a moment.";
  }
}

init();
