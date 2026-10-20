import '@fontsource-variable/roboto-flex/wght.css';
import { applyProposal, getCatalog, getDefaultDesign, postChat, transcribe } from './api/client.js';
import { mountChat } from './chat/chatPanel.js';
import { createStore } from './state/store.js';
import { mountPanel } from './editor/panel.js';
import { createViewer } from './viewer/viewer.js';

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.hidden = false;
}

function bindInteriorToggle(store) {
  const toggle = document.getElementById('toggle-interior');
  toggle.addEventListener('change', () => store.setDoorsVisible(!toggle.checked));
  store.subscribe((state) => { toggle.checked = !state.ui.doorsVisible; });
}

async function boot() {
  let catalog;
  let initial;
  try {
    [catalog, initial] = await Promise.all([getCatalog(), getDefaultDesign()]);
  } catch {
    showError('Could not reach the design service. Please check your connection and reload.');
    return;
  }
  // Validates the server data before anything is rendered (throws on invalid data).
  const store = createStore({ design: initial.design, revision: initial.revision, catalog });
  const viewer = createViewer(document.getElementById('viewer'), store);
  bindInteriorToggle(store);
  mountPanel(document.getElementById('properties-content'), store);
  mountChat(document.getElementById('chat-panel'), store, { postChat, applyProposal, transcribe });
  if (import.meta.env.DEV) {
    window.__banai = Object.freeze({ store, viewer });
  }
}

boot().catch(() => {
  showError('The designer could not start. Please reload the page.');
});
