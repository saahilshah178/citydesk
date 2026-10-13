import { useState, type FormEvent } from 'react';

interface ControlsProps {
  listening: boolean;
  speechSupported: boolean;
  disabled: boolean;
  onTalkStart: () => void;
  onTalkEnd: () => void;
  onSubmit: (text: string) => void;
}

/**
 * What sits under the device: the push-to-talk button and the typed fallback. An Echo Show has
 * neither, so they live outside the frame.
 */
export function Controls({ listening, speechSupported, disabled, onTalkStart, onTalkEnd, onSubmit }: ControlsProps) {
  const [text, setText] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    onSubmit(value);
  };

  return (
    <div className="controls">
      <div className="controls__talk">
        <button
          type="button"
          id="talk-button"
          className="talk"
          data-listening={listening || undefined}
          disabled={!speechSupported || disabled}
          aria-pressed={listening}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            onTalkStart();
          }}
          onPointerUp={onTalkEnd}
          onPointerCancel={onTalkEnd}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className="talk__dot" aria-hidden="true" />
          {listening ? 'Listening' : 'Hold to talk'}
        </button>
        <p className="controls__hint">
          {speechSupported
            ? 'Hold the button or the space bar, speak, then let go.'
            : 'This browser has no speech recognition. Type instead.'}
        </p>
      </div>

      <form className="controls__type" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="typed-input">
          Type what you would say
        </label>
        <input
          id="typed-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Or type what you would say"
          autoComplete="off"
          maxLength={500}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
