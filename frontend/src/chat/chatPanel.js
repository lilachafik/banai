// Chat pane rendering. All text is set with textContent (agent output is untrusted).
// Markup comes from the <template>s in index.html (Stitch "BanAI Material 3 - Oak").
import { createChatController, MAX_CHARS } from './controller.js';
import { createDictation, isDictationSupported } from './dictation.js';
import { renderProposalCard } from './proposalCard.js';

const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

function messageNode({ role, text }) {
  const node = clone('chat-message-template');
  node.dataset.role = role === 'user' ? 'user' : 'agent';
  node.querySelector('.chat-msg__bubble').textContent = text;
  return node;
}

function noteNode({ kind, text }) {
  const node = document.createElement('p');
  node.className = kind === 'error' ? 'chat-note chat-note--error' : 'chat-note';
  if (kind === 'error') node.setAttribute('role', 'alert');
  node.textContent = text;
  return node;
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Mic button: record → transcribe → put the text in the input for review. Never sends.
 * Returns null (and keeps the button hidden) when the browser cannot record.
 */
function mountDictation(form, input, api, onBusyChange) {
  if (!isDictationSupported() || !api.transcribe) return null;
  const button = form.querySelector('[data-action="dictate"]');
  const status = form.querySelector('.composer__voice');
  const error = form.querySelector('.composer__error');
  const use = button.querySelector('use');
  const render = ({ status: phase, seconds, error: message }) => {
    const recording = phase === 'recording';
    button.classList.toggle('mic-btn--recording', recording);
    button.classList.toggle('mic-btn--busy', phase === 'starting' || phase === 'transcribing');
    button.disabled = phase === 'starting' || phase === 'transcribing';
    button.setAttribute('aria-label', recording ? 'Stop voice input' : 'Start voice input');
    use.setAttribute('href', recording ? '#i-stop' : '#i-mic');
    status.hidden = phase === 'idle';
    status.dataset.phase = phase;
    status.textContent = recording ? `${clock(seconds)} Listening…` : phase === 'transcribing' ? 'Transcribing…' : '';
    error.hidden = !message;
    error.textContent = message ?? '';
    onBusyChange();
  };
  const dictation = createDictation({
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    MediaRecorder: window.MediaRecorder,
    transcribe: api.transcribe,
    onText: (text) => {
      const current = input.value.trim();
      input.value = (current ? `${current} ${text}` : text).slice(0, MAX_CHARS);
      input.focus();
      onBusyChange();
    },
    onChange: render,
  });
  button.hidden = false;
  form.querySelector('.composer__hint--voice').hidden = false;
  button.addEventListener('click', () => dictation.toggle());
  return dictation;
}

export function mountChat(panel, store, api) {
  const chat = createChatController({ store, api });
  const thread = panel.querySelector('#chat-thread');
  const form = panel.querySelector('#chat-composer');
  const input = form.querySelector('.composer__input');
  const sendButton = form.querySelector('button[type="submit"]');
  const intro = thread.querySelector('.chat__empty');

  const render = () => {
    const nodes = chat.getEntries().map((entry) => {
      if (entry.kind === 'message') return messageNode(entry);
      if (entry.kind === 'proposal') return renderProposalCard(entry, chat);
      return noteNode(entry);
    });
    if (chat.isBusy()) nodes.push(clone('chat-loading-template'));
    thread.replaceChildren(...(nodes.length ? nodes : [intro]));
    thread.scrollTop = thread.scrollHeight;
    sendButton.disabled = isBusy() || !input.value.trim();
  };

  const dictation = mountDictation(form, input, api, () => {
    sendButton.disabled = isBusy() || !input.value.trim();
  });
  const isBusy = () => chat.isBusy() || Boolean(dictation?.isBusy());

  input.disabled = false;
  input.addEventListener('input', () => { sendButton.disabled = isBusy() || !input.value.trim(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (isBusy() || !text.trim()) return;
    input.value = '';
    chat.send(text);
  });

  chat.subscribe(render);
  // Re-render on committed changes so a pending card turns stale after a manual edit.
  // (Only rendering happens here: the agent is never called on manual edits.)
  let revision = store.getState().revision;
  store.subscribe((state) => {
    if (state.revision !== revision) {
      revision = state.revision;
      render();
    }
  });
  render();
  return chat;
}
