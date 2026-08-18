export const HUBSTUDIO_RECONNECT_COOLDOWN_MS = 5_000

export function hubstudioMarketDuration(url: string): 5 | 15 | undefined {
  const match = url.match(/\/prediction-markets\/up-down\/btc-(5|15)min-[^/]+\/[^/?#]+/i)
  if (!match) return undefined
  return Number(match[1]) as 5 | 15
}

export function canAttemptHubstudioReconnect(
  lastAttemptAt: number,
  now = Date.now(),
  force = false
): boolean {
  return force || lastAttemptAt <= 0 || now - lastAttemptAt >= HUBSTUDIO_RECONNECT_COOLDOWN_MS
}
