import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/client.js';
import { applyOps } from '../../../src/domain/apply.js';
import { createChatController, MAX_CHARS, MAX_HISTORY } from '../../../src/chat/controller.js';
import { createStore } from '../../../src/state/store.js';
import { loadCatalog, loadDesign } from '../domain/helpers.js';

const catalog = loadCatalog();
const SHELF_OP = { op: 'add_shelf', compartmentId: 'cmp_left', y: 1000, id: 'shf_ai1' };

const proposalFor = (revision = 1) => ({
  proposalId: 'p'.repeat(32), baseRevision: revision, baseHash: 'h'.repeat(64), expiresAt: 0,
  ops: [SHELF_OP], summary: ['Add a shelf at 100.0 cm in compartment 1'], signature: 's'.repeat(64),
});

function setup({ reply = 'Here you go.', proposal = proposalFor() } = {}) {
  const store = createStore({ design: loadDesign('basic'), revision: 1, catalog });
  const api = {
    postChat: vi.fn().mockResolvedValue({ reply, proposal }),
    applyProposal: vi.fn(async ({ design, revision, proposal: p }) => ({
      design: applyOps(design, p.ops, catalog), revision: revision + 1,
    })),
  };
  const chat = createChatController({ store, api });
  return { store, api, chat };
}

const proposalEntry = (chat) => chat.getEntries().find((e) => e.kind === 'proposal');
const shelfIds = (store) => store.getState().design.compartments[0].shelves.map((s) => s.id);

describe('chat controller', () => {
  it('sends the current design and revision with the conversation, and shows the proposal', async () => {
    const { store, api, chat } = setup();
    store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 450 }]); // a manual edit first
    api.postChat.mockResolvedValue({ reply: 'ok', proposal: proposalFor(2) });
    await chat.send('  Add a shelf  ');
    const sent = api.postChat.mock.calls[0][0];
    expect(sent.messages).toEqual([{ role: 'user', content: 'Add a shelf' }]);
    expect(sent.revision).toBe(2);
    expect(sent.design.compartments[0].shelves[0].y).toBe(450); // the agent sees the manual edit
    expect(chat.getEntries().map((e) => e.kind)).toEqual(['message', 'message', 'proposal']);
    expect(store.getState().pendingProposal).toBe(proposalEntry(chat).proposal);
  });

  it('never changes the committed design before Confirm', async () => {
    const { store, chat } = setup();
    const before = store.getState().design;
    await chat.send('Add a shelf');
    expect(store.getState().design).toBe(before);
    expect(store.getState().revision).toBe(1);
  });

  it('Confirm applies the signed proposal and commits the server design', async () => {
    const { store, api, chat } = setup();
    await chat.send('Add a shelf');
    await chat.confirm(proposalEntry(chat));
    expect(api.applyProposal).toHaveBeenCalledTimes(1);
    expect(shelfIds(store)).toContain('shf_ai1');
    expect(store.getState().revision).toBe(2);
    expect(store.getState().pendingProposal).toBeNull();
    expect(chat.statusOf(proposalEntry(chat))).toBe('applied');
  });

  it('Cancel changes nothing and tells the agent next time', async () => {
    const { store, api, chat } = setup();
    await chat.send('Add a shelf');
    const before = store.getState().design;
    chat.cancel(proposalEntry(chat));
    expect(store.getState().design).toBe(before);
    expect(store.getState().pendingProposal).toBeNull();
    expect(api.applyProposal).not.toHaveBeenCalled();
    await chat.send('Something else');
    const history = api.postChat.mock.calls[1][0].messages;
    expect(history.at(-2)).toEqual({ role: 'assistant', content: 'The customer cancelled the proposal; nothing was changed.' });
    expect(history[1].content).toContain('Proposed changes: Add a shelf at 100.0 cm in compartment 1');
  });

  it('a manual edit while a proposal is pending makes it stale; Confirm then does nothing', async () => {
    const { store, api, chat } = setup();
    await chat.send('Add a shelf');
    store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 450 }]);
    expect(chat.statusOf(proposalEntry(chat))).toBe('stale');
    await chat.confirm(proposalEntry(chat));
    expect(api.applyProposal).not.toHaveBeenCalled();
    expect(shelfIds(store)).not.toContain('shf_ai1');
  });

  it('a manual edit during the apply request is never overwritten', async () => {
    const { store, api, chat } = setup();
    await chat.send('Add a shelf');
    let release;
    api.applyProposal.mockImplementation((args) => new Promise((resolve) => {
      release = () => resolve({ design: applyOps(args.design, args.proposal.ops, catalog), revision: 2 });
    }));
    const pending = chat.confirm(proposalEntry(chat));
    store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 450 }]);
    release();
    await pending;
    expect(shelfIds(store)).not.toContain('shf_ai1');
    expect(store.getState().design.compartments[0].shelves[0].y).toBe(450);
    expect(chat.statusOf(proposalEntry(chat))).toBe('stale');
  });

  it('a 409 from the server marks the proposal stale or expired', async () => {
    for (const [code, status] of [['STALE', 'stale'], ['EXPIRED', 'expired']]) {
      const { api, chat } = setup();
      await chat.send('Add a shelf');
      api.applyProposal.mockRejectedValue(new ApiError(409, code, '/api/proposals/apply'));
      await chat.confirm(proposalEntry(chat));
      expect(chat.statusOf(proposalEntry(chat))).toBe(status);
    }
  });

  it('a new proposal replaces the pending one', async () => {
    const { store, api, chat } = setup();
    await chat.send('Add a shelf');
    const first = proposalEntry(chat);
    api.postChat.mockResolvedValueOnce({ reply: 'ok', proposal: proposalFor() });
    await chat.send('Actually two shelves');
    expect(chat.statusOf(first)).toBe('replaced');
    expect(store.getState().pendingProposal).not.toBe(first.proposal);
  });

  it('shows fixed error texts (never server text) and ignores empty input', async () => {
    const { api, chat } = setup();
    expect(await chat.send('   ')).toBe(false);
    api.postChat.mockRejectedValue(new ApiError(503, 'AGENT_UNAVAILABLE', '/api/chat'));
    await chat.send('hi');
    expect(chat.getEntries().at(-1)).toEqual({ kind: 'error', text: 'The AI designer is not available on this server.' });
    api.postChat.mockRejectedValue(new Error('<img onerror=alert(1)>'));
    await chat.send('hi');
    expect(chat.getEntries().at(-1).text).toBe('The AI designer could not answer. Please try again.');
  });

  it('caps history length and message size like the server', async () => {
    const { api, chat } = setup({ proposal: null });
    for (let i = 0; i < 20; i += 1) await chat.send(`message ${i} ${'x'.repeat(3000)}`);
    const { messages } = api.postChat.mock.calls.at(-1)[0];
    expect(messages.length).toBe(MAX_HISTORY);
    expect(Math.max(...messages.map((m) => m.content.length))).toBeLessThanOrEqual(MAX_CHARS);
    expect(messages.at(-1).role).toBe('user');
  });
});
