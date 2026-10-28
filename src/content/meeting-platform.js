import { meetingPlatformForUrl } from "../shared/meeting-platform.js";
import { findByIconText } from "./meet-selectors.js";
import { observeMuteState } from "./meet-mute-observer.js";
import { observeLocalIdentity } from "./meet-local-identity.js";
import { enableCaptionsAndObserve } from "./meet-caption-observer.js";
import { isInTeamsMeeting, getTeamsMeetingTitle } from "./teams-selectors.js";
import { observeTeamsMuteState } from "./teams-mute-observer.js";
import { enableTeamsCaptionsAndObserve } from "./teams-caption-observer.js";

export function getMeetingPlatform(url = location.href) {
  if (meetingPlatformForUrl(url) === "teams") return {
    id: "teams",
    isInActiveMeeting: isInTeamsMeeting,
    getTitle: getTeamsMeetingTitle,
    observeMuteState: observeTeamsMuteState,
    observeCaptions: enableTeamsCaptionsAndObserve,
    // Do not infer an identity from Teams' account menu or other people's tiles.
    observeLocalIdentity: () => () => {},
    captionMode: () => "dom",
  };
  return {
    id: "meet",
    isInActiveMeeting: () => findByIconText("call_end", { visible: true }) !== null,
    getTitle: () => document.title?.trim() && document.title.trim() !== "Meet" ? document.title.trim() : "Reunión sin título",
    observeMuteState,
    observeCaptions: enableCaptionsAndObserve,
    observeLocalIdentity,
    captionMode: preference => ["dom", "shadow", "hybrid"].includes(preference) ? preference : "dom",
  };
}
