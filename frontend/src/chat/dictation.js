// Voice dictation for the chat input (Phase 5b). No DOM: the browser APIs are injected so
// the state machine can be unit-tested. The transcript is handed to onText for the customer
// to review; it is never sent to the agent from here.

export const MAX_SECONDS = 60;

const ERROR_TEXT = {
  NotAllowedError: 'Microphone access is blocked. Allow it in your browser to use voice input.',
  SecurityError: 'Microphone access is blocked. Allow it in your browser to use voice input.',
  NotFoundError: 'No microphone was found.',
  NotReadableError: 'The microphone is in use by another application.',
  AGENT_UNAVAILABLE: 'Voice input is not available on this server.',
  RATE_LIMITED: 'Too many recordings. Please wait a moment and try again.',
  EMPTY_AUDIO: 'The recording was too short. Please try again.',
  PAYLOAD_TOO_LARGE: 'The recording was too long. Please keep it under a minute.',
  NOTHING_HEARD: 'Nothing was heard. Please try again.',
};
const GENERIC_ERROR = 'Voice input failed. Please try again.';
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export function isDictationSupported(env = globalThis) {
  return Boolean(env.isSecureContext && env.MediaRecorder && env.navigator?.mediaDevices?.getUserMedia);
}

/**
 * State: { status: 'idle' | 'starting' | 'recording' | 'transcribing', seconds, error }.
 */
export function createDictation({
  getUserMedia, MediaRecorder, transcribe, onText, onChange = () => {},
  maxSeconds = MAX_SECONDS, setTimer = setInterval, clearTimer = clearInterval, now = Date.now,
}) {
  let state = { status: 'idle', seconds: 0, error: null };
  let recorder = null;
  let stream = null;
  let timer = null;
  let startedAt = 0;

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  const releaseMic = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const fail = (code) => {
    releaseMic();
    recorder = null;
    set({ status: 'idle', seconds: 0, error: ERROR_TEXT[code] ?? GENERIC_ERROR });
  };

  async function finish(chunks, type) {
    set({ status: 'transcribing' });
    try {
      const text = (await transcribe(new Blob(chunks, { type }))).trim();
      if (!text) {
        fail('NOTHING_HEARD');
        return;
      }
      set({ status: 'idle', seconds: 0, error: null });
      onText(text);
    } catch (error) {
      fail(error?.code);
    }
  }

  async function start() {
    if (state.status !== 'idle') return;
    set({ status: 'starting', error: null, seconds: 0 });
    try {
      stream = await getUserMedia({ audio: true });
    } catch (error) {
      fail(error?.name);
      return;
    }
    const mimeType = PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const type = (recorder?.mimeType || mimeType || 'audio/webm').split(';')[0];
      releaseMic();
      recorder = null;
      finish(chunks, type);
    });
    recorder.start();
    startedAt = now();
    timer = setTimer(() => {
      const seconds = Math.floor((now() - startedAt) / 1000);
      if (seconds >= maxSeconds) stop();
      else set({ seconds });
    }, 250);
    set({ status: 'recording' });
  }

  function stop() {
    if (state.status === 'recording' && recorder && recorder.state !== 'inactive') recorder.stop();
  }

  return {
    getState: () => state,
    start,
    stop,
    toggle: () => (state.status === 'recording' ? stop() : start()),
    isBusy: () => state.status !== 'idle',
  };
}
