// src/webrtc-bootstrap/audio-mixer.js
export class RemoteAudioMixer {
  constructor() {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.createMediaStreamDestination();
    this.sourceNodesByTrackId = new Map();
  }

  addTrack(track) {
    if (this.sourceNodesByTrackId.has(track.id)) return;
    const trackStream = new MediaStream([track]);
    const sourceNode = this.audioContext.createMediaStreamSource(trackStream);
    sourceNode.connect(this.destination);
    this.sourceNodesByTrackId.set(track.id, sourceNode);
    track.addEventListener("ended", () => this.removeTrack(track.id));
  }

  removeTrack(trackId) {
    const sourceNode = this.sourceNodesByTrackId.get(trackId);
    if (!sourceNode) return;
    sourceNode.disconnect();
    this.sourceNodesByTrackId.delete(trackId);
  }

  get stream() {
    return this.destination.stream;
  }

  async close() {
    await this.audioContext.close();
  }
}
