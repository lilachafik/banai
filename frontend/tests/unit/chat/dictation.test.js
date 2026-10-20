import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/client.js';
import { createDictation, isDictationSupported, MAX_SECONDS } from '../../../src/chat/dictation.js';

class FakeRecorder extends EventTarget {
  static isTypeSupported = (type) => type === 'audio/webm;codecs=opus';
  static last = null;

  constructor(stream, options) {
    super();
    this.stream = stream;
    this.mimeType = options?.mimeType ?? '';
    this.state = 'inactive';
    FakeRecorder.last = this;
  }

  start() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    const data = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data }));
    this.dispatchEvent(new Event('stop'));
  }
}

function setup({ transcribe = vi.fn().mockResolvedValue('add a shelf at 80 cm'), denied = null } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = denied
    ? vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: denied }))
    : vi.fn().mockResolvedValue(stream);
  let tick = null;
  let clockMs = 0;
  const onText = vi.fn();
  const states = [];
  const dictation = createDictation({
    getUserMedia, MediaRecorder: FakeRecorder, transcribe, onText,
    onChange: (state) => states.push(state.status),
    setTimer: (fn) => { tick = fn; return 1; }, clearTimer: vi.fn(), now: () => clockMs,
  });
  const advance = (seconds) => { clockMs += seconds * 1000; tick?.(); };
  return { dictation, getUserMedia, transcribe, onText, track, states, advance };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dictation', () => {
  it('records, transcribes and hands the text over without sending anything', async () => {
    const { dictation, getUserMedia, transcribe, onText, track, states } = setup();
    await dictation.start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(dictation.getState().status).toBe('recording');
    expect(FakeRecorder.last.mimeType).toBe('audio/webm;codecs=opus');
    dictation.stop();
    await settle();
    const blob = transcribe.mock.calls[0][0];
    expect(blob.type).toBe('audio/webm'); // codec parameters are stripped
    expect(blob.size).toBe(2048);
    expect(onText).toHaveBeenCalledWith('add a shelf at 80 cm');
    expect(track.stop).toHaveBeenCalled(); // the microphone is released
    expect(states).toEqual(['starting', 'recording', 'transcribing', 'idle']);
    expect(dictation.isBusy()).toBe(false);
  });

  it(`stops by itself after ${MAX_SECONDS} seconds and shows the timer`, async () => {
    const { dictation, transcribe, advance } = setup();
    await dictation.start();
    advance(7);
    expect(dictation.getState().seconds).toBe(7);
    advance(MAX_SECONDS);
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('shows a fixed message when the microphone is blocked or missing', async () => {
    for (const [name, text] of [
      ['NotAllowedError', 'Microphone access is blocked. Allow it in your browser to use voice input.'],
      ['NotFoundError', 'No microphone was found.'],
    ]) {
      const { dictation, onText } = setup({ denied: name });
      await dictation.start();
      expect(dictation.getState()).toEqual({ status: 'idle', seconds: 0, error: text });
      expect(onText).not.toHaveBeenCalled();
    }
  });

  it('maps server errors and empty transcripts to fixed texts', async () => {
    const cases = [
      [vi.fn().mockRejectedValue(new ApiError(503, 'AGENT_UNAVAILABLE', '/api/transcribe')),
        'Voice input is not available on this server.'],
      [vi.fn().mockRejectedValue(new Error('<b>boom</b>')), 'Voice input failed. Please try again.'],
      [vi.fn().mockResolvedValue('   '), 'Nothing was heard. Please try again.'],
    ];
    for (const [transcribe, text] of cases) {
      const { dictation, onText, track } = setup({ transcribe });
      await dictation.start();
      dictation.stop();
      await settle();
      expect(dictation.getState().error).toBe(text);
      expect(onText).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
    }
  });

  it('ignores a second start while busy', async () => {
    const { dictation, getUserMedia } = setup();
    await dictation.start();
    await dictation.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('is unsupported without a secure context, MediaRecorder or getUserMedia', () => {
    const full = { isSecureContext: true, MediaRecorder: FakeRecorder, navigator: { mediaDevices: { getUserMedia() {} } } };
    expect(isDictationSupported(full)).toBe(true);
    expect(isDictationSupported({ ...full, isSecureContext: false })).toBe(false);
    expect(isDictationSupported({ ...full, MediaRecorder: undefined })).toBe(false);
    expect(isDictationSupported({ ...full, navigator: {} })).toBe(false);
  });
});
