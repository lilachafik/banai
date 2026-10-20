// Chat pane rendering. All text is set with textContent (agent output is untrusted).
// Markup comes from the <template>s in index.html (Stitch "BanAI Material 3 - Oak").
import { createChatController } from './controller.js';
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
    sendButton.disabled = chat.isBusy() || !input.value.trim();
  };

  input.disabled = false;
  input.addEventListener('input', () => { sendButton.disabled = chat.isBusy() || !input.value.trim(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (chat.isBusy() || !text.trim()) return;
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
