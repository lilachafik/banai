// Chat logic without DOM: conversation entries, agent calls and the proposal lifecycle.
// The agent is called only from send() (a customer message), never on manual edits.
// A proposal is applied only on confirm(); cancel() is client-only.

export const MAX_HISTORY = 30; // mirrors the backend's MAX_MESSAGES
export const MAX_CHARS = 2000; // mirrors the backend's MAX_MESSAGE_CHARS

const ERROR_TEXT = {
  AGENT_UNAVAILABLE: 'The AI designer is not available on this server.',
  RATE_LIMITED: 'Too many messages. Please wait a moment and try again.',
  INVALID_DESIGN: 'The current design could not be sent to the AI designer.',
};
const GENERIC_ERROR = 'The AI designer could not answer. Please try again.';
const APPLY_ERROR = 'The changes could not be applied. Please try again.';

/**
 * Entry kinds: { kind: 'message', role, text } | { kind: 'proposal', proposal, status }
 * | { kind: 'note', text } | { kind: 'error', text }.
 * Proposal status: pending | applying | stale | expired | applied | cancelled | replaced.
 */
export function createChatController({ store, api }) {
  let entries = [];
  let busy = false;
  const listeners = new Set();
  const emit = () => listeners.forEach((listener) => listener());
  const add = (entry) => { entries = [...entries, entry]; };
  const update = (target, patch) => {
    entries = entries.map((entry) => (entry === target ? Object.assign(target, patch) : entry));
  };

  // What the agent sees: customer messages, its own replies and the outcome of each proposal.
  const history = () => entries
    .filter((entry) => entry.kind === 'message' || entry.kind === 'note')
    .map((entry) => ({
      role: entry.kind === 'message' ? entry.role : 'assistant',
      content: (entry.historyText ?? entry.text).slice(0, MAX_CHARS),
    }))
    .slice(-MAX_HISTORY);

  const activeProposal = () => entries.find((e) => e.kind === 'proposal' && e.proposal === store.getState().pendingProposal);

  /** The status shown for a proposal entry (stale once the design moved on). */
  const statusOf = (entry) => {
    if (entry.status !== 'pending') return entry.status;
    return store.getState().revision === entry.proposal.baseRevision ? 'pending' : 'stale';
  };

  async function send(rawText) {
    const text = String(rawText ?? '').trim().slice(0, MAX_CHARS);
    if (!text || busy) return false;
    add({ kind: 'message', role: 'user', text });
    busy = true;
    emit();
    const { design, revision } = store.getState();
    try {
      const { reply, proposal } = await api.postChat({ messages: history(), design, revision });
      const summary = proposal ? `\nProposed changes: ${proposal.summary.join('; ')}` : '';
      add({ kind: 'message', role: 'assistant', text: String(reply), historyText: `${reply}${summary}` });
      if (proposal) {
        const previous = activeProposal();
        if (previous) update(previous, { status: 'replaced' });
        add({ kind: 'proposal', proposal, status: 'pending' });
        store.setProposal(proposal);
      }
    } catch (error) {
      add({ kind: 'error', text: ERROR_TEXT[error?.code] ?? GENERIC_ERROR });
    } finally {
      busy = false;
      emit();
    }
    return true;
  }

  async function confirm(entry) {
    if (statusOf(entry) !== 'pending' || store.getState().pendingProposal !== entry.proposal) return;
    const { design, revision } = store.getState();
    update(entry, { status: 'applying' });
    emit();
    try {
      const result = await api.applyProposal({ design, revision, proposal: entry.proposal });
      if (store.getState().revision !== revision) {
        // A manual edit landed while the request was in flight: never overwrite it.
        update(entry, { status: 'stale' });
      } else {
        store.commitDesign(result.design, result.revision);
        store.clearProposal();
        update(entry, { status: 'applied' });
        add({ kind: 'note', text: 'Changes applied.', historyText: 'The customer confirmed; the proposal was applied.' });
      }
    } catch (error) {
      if (error?.status === 409) {
        update(entry, { status: error.code === 'EXPIRED' ? 'expired' : 'stale' });
      } else {
        update(entry, { status: 'pending' });
        add({ kind: 'error', text: APPLY_ERROR });
      }
    }
    emit();
  }

  function cancel(entry) {
    if (!['pending', 'stale', 'expired'].includes(statusOf(entry))) return;
    update(entry, { status: 'cancelled' });
    if (store.getState().pendingProposal === entry.proposal) store.clearProposal();
    add({ kind: 'note', text: 'Proposal cancelled. Nothing was changed.',
      historyText: 'The customer cancelled the proposal; nothing was changed.' });
    emit();
  }

  return {
    getEntries: () => entries,
    isBusy: () => busy,
    statusOf,
    send,
    confirm,
    cancel,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
