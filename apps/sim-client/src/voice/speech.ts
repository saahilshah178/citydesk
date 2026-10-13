/** Plays the assistant's replies with Amazon Polly audio from `/api/speak`. */

import { apiSpeak } from '../api.ts';

export class Speaker {
  private audio: HTMLAudioElement | undefined;
  private objectUrl: string | undefined;
  private abort: AbortController | undefined;

  /**
   * Speaks `text` and resolves when playback ends or is stopped. Rejects when the audio cannot be
   * fetched or played; the caller decides how to say so (the caption is on screen either way).
   */
  async speak(text: string, onStart?: () => void): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;

    let blob: Blob;
    try {
      blob = await apiSpeak(text, abort.signal);
    } catch (error) {
      // Stopped while the audio was still being fetched: not a failure.
      if (abort.signal.aborted) return;
      throw error;
    }
    if (abort.signal.aborted) return;

    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    this.audio = audio;
    this.objectUrl = objectUrl;

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error('The audio could not be played.'));
      audio.play().then(() => onStart?.(), reject);
    }).finally(() => {
      if (this.audio === audio) this.release();
    });
  }

  /** Stops playback and any request still in flight. Called the moment the resident starts talking. */
  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.audio?.pause();
    this.release();
  }

  private release(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.audio = undefined;
    this.objectUrl = undefined;
  }
}
