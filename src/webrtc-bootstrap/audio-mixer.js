// src/webrtc-bootstrap/audio-mixer.js
export class MeetingAudioMixer {
  constructor() {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.createMediaStreamDestination();
    this.remoteSourceNodesByTrackId = new Map();
    this.micSourceNode = null;
    this.micGainNode = null;
  }

  addRemoteTrack(track) {
    if (this.remoteSourceNodesByTrackId.has(track.id)) return;
    const trackStream = new MediaStream([track]);
    const sourceNode = this.audioContext.createMediaStreamSource(trackStream);
    sourceNode.connect(this.destination);
    this.remoteSourceNodesByTrackId.set(track.id, sourceNode);
    track.addEventListener("ended", () => this.removeRemoteTrack(track.id));
  }

  removeRemoteTrack(trackId) {
    const sourceNode = this.remoteSourceNodesByTrackId.get(trackId);
    if (!sourceNode) return;
    sourceNode.disconnect();
    this.remoteSourceNodesByTrackId.delete(trackId);
  }

  setMicTrack(micTrack, { initiallyMuted }) {
    const micStream = new MediaStream([micTrack]);
    this.micSourceNode = this.audioContext.createMediaStreamSource(micStream);
    this.micGainNode = this.audioContext.createGain();
    this.micGainNode.gain.value = initiallyMuted ? 0 : 1;
    this.micSourceNode.connect(this.micGainNode);
    this.micGainNode.connect(this.destination);
  }

  setMicMuted(muted) {
    if (!this.micGainNode) return;
    const now = this.audioContext.currentTime;
    const targetGain = muted ? 0 : 1;
    // Rampa corta en vez de asignar gain.value directo — evita un "click" audible
    // en la transición.
    this.micGainNode.gain.cancelScheduledValues(now);
    this.micGainNode.gain.setValueAtTime(this.micGainNode.gain.value, now);
    this.micGainNode.gain.linearRampToValueAtTime(targetGain, now + 0.01);
  }

  get stream() {
    return this.destination.stream;
  }

  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async close() {
    await this.audioContext.close();
  }
}
