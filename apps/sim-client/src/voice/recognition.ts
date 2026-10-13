/**
 * Push-to-talk on top of the browser's Web Speech API (`SpeechRecognition`, prefixed in Chromium
 * and Safari). Not every browser has it (Firefox does not), which is why the typed input is always
 * there. The API is not in TypeScript's DOM library, so the slice used here is declared below.
 */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative | undefined;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult | undefined };
}
interface RecognitionErrorEvent {
  readonly error: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = globalThis as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function speechRecognitionSupported(): boolean {
  return recognitionConstructor() !== undefined;
}

const ERROR_TEXT: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the browser, or type instead.',
  'service-not-allowed': 'Speech recognition is not allowed here. Type instead.',
  'audio-capture': 'No microphone was found. Type instead.',
  network: 'Speech recognition needs a network connection. Type instead.',
  'no-speech': '',
  aborted: '',
};

export interface PushToTalkCallbacks {
  /** Everything heard so far in this press, including words still being revised. */
  onTranscript: (text: string) => void;
  /** The press ended. `text` is empty when nothing was heard. */
  onDone: (text: string) => void;
  onError: (message: string) => void;
}

/** One press-and-hold: `start()` on press, `stop()` on release, then `onDone` with the transcript. */
export class PushToTalk {
  private recognition: Recognition | undefined;
  private finalText = '';
  private latest = '';

  constructor(
    private readonly callbacks: PushToTalkCallbacks,
    private readonly lang: string = 'en-US',
  ) {}

  get active(): boolean {
    return this.recognition !== undefined;
  }

  start(): boolean {
    const Ctor = recognitionConstructor();
    if (!Ctor || this.recognition) return false;

    const recognition = new Ctor();
    recognition.lang = this.lang;
    // Keep listening through pauses for as long as the button is held.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    this.finalText = '';
    this.latest = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? '';
        if (result?.isFinal) this.finalText = `${this.finalText} ${transcript}`.trim();
        else interim += transcript;
      }
      this.latest = `${this.finalText} ${interim}`.replace(/\s+/g, ' ').trim();
      this.callbacks.onTranscript(this.latest);
    };
    recognition.onerror = (event) => {
      const message = ERROR_TEXT[event.error] ?? `Speech recognition failed (${event.error}).`;
      if (message) this.callbacks.onError(message);
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = undefined;
      this.callbacks.onDone(this.latest);
    };

    try {
      recognition.start();
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : 'Speech recognition could not start.');
      return false;
    }
    this.recognition = recognition;
    return true;
  }

  /** Release: stop capturing and let the recognizer deliver what it has. */
  stop(): void {
    this.recognition?.stop();
  }

  /** Throw the press away without submitting anything. */
  cancel(): void {
    const recognition = this.recognition;
    this.recognition = undefined;
    recognition?.abort();
  }
}
