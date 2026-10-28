export const TEAMS_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"];

export function meetingPlatformForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "meet.google.com") return "meet";
    return TEAMS_HOSTS.includes(url.hostname) ? "teams" : null;
  } catch {
    return null;
  }
}
