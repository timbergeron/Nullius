async function copyGuideText(text) {
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
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea?.remove();
    }
  }
}

for (const [index, pre] of [...document.querySelectorAll(".guide pre")].entries()) {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";
  pre.before(wrapper);
  wrapper.append(pre);

  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy code block ${index + 1}`);
  button.setAttribute("aria-live", "polite");
  wrapper.append(button);

  button.addEventListener("click", async () => {
    button.disabled = true;
    const code = pre.querySelector("code");
    const copied = await copyGuideText(code?.textContent || pre.textContent);
    button.textContent = copied ? "Copied" : "Copy failed";
    button.dataset.status = copied ? "copied" : "error";
    window.setTimeout(() => {
      button.disabled = false;
      button.textContent = "Copy";
      delete button.dataset.status;
    }, 1_800);
  });
}
