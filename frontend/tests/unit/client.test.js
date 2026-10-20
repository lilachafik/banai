import { describe, expect, it, vi } from 'vitest';
import {
  ApiError, applyProposal, getCatalog, getDefaultDesign, getHealth, postChat,
} from '../../src/api/client.js';

const okResponse = (body) => vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe('api client', () => {
  it('returns the health payload', async () => {
    const fetchImpl = okResponse({ success: true, data: { status: 'ok' } });
    await expect(getHealth(fetchImpl)).resolves.toEqual({ success: true, data: { status: 'ok' } });
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/api/health');
  });

  it('unwraps the envelope for catalog and default design', async () => {
    await expect(getCatalog(okResponse({ success: true, data: { colors: [] } }))).resolves.toEqual({ colors: [] });
    await expect(getDefaultDesign(okResponse({ success: true, data: { design: {}, revision: 1 } })))
      .resolves.toEqual({ design: {}, revision: 1 });
  });

  it('posts JSON for chat and apply, and maps error codes', async () => {
    const fetchImpl = okResponse({ success: true, data: { reply: 'hi', proposal: null } });
    await expect(postChat({ messages: [], design: {}, revision: 1 }, fetchImpl))
      .resolves.toEqual({ reply: 'hi', proposal: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ messages: [], design: {}, revision: 1 });

    const stale = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: 'STALE' } }) });
    const error = await applyProposal({ design: {}, revision: 1, proposal: {} }, stale).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect([error.status, error.code]).toEqual([409, 'STALE']);

    const weird = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { code: '<b>' } }) });
    expect((await postChat({}, weird).catch((e) => e)).code).toBeNull();
  });

  it('throws on HTTP errors and unsuccessful envelopes', async () => {
    await expect(getCatalog(vi.fn().mockResolvedValue({ ok: false, status: 503 }))).rejects.toThrow('503');
    await expect(getCatalog(okResponse({ success: false, error: 'x' }))).rejects.toThrow('unsuccessful');
  });
});
