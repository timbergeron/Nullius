export const TYPING_REFRESH_MS = 8_000;

export function maintainTyping(channel, {
  intervalMs = TYPING_REFRESH_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let active = true;
  let inFlight = false;

  const refresh = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      await channel.sendTyping();
    } catch {
      // Typing is best-effort and must never prevent the actual answer.
    } finally {
      inFlight = false;
    }
  };

  void refresh();
  const timer = setIntervalFn(refresh, intervalMs);
  timer?.unref?.();

  return () => {
    if (!active) return;
    active = false;
    clearIntervalFn(timer);
  };
}
