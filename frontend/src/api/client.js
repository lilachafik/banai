import { API_BASE_URL } from '../config.js';

/** A failed API call. `code` is the server's error code (e.g. STALE), when it sent one. */
export class ApiError extends Error {
  constructor(status, code, path) {
    super(`Request to ${path} failed with status ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function errorCode(response) {
  try {
    const body = await response.json();
    const code = body?.error?.code;
    return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

async function request(path, fetchImpl, init) {
  if (!API_BASE_URL) throw new Error('The API base URL is not configured');
  const url = `${API_BASE_URL}${path}`;
  const response = await (init ? fetchImpl(url, init) : fetchImpl(url));
  if (!response.ok) {
    throw new ApiError(response.status, init ? await errorCode(response) : null, path);
  }
  const body = await response.json();
  if (!body || body.success !== true) {
    throw new Error(`Request to ${path} returned an unsuccessful response`);
  }
  return body.data;
}

const getJson = (path, fetchImpl) => request(path, fetchImpl);

const postJson = (path, payload, fetchImpl) => request(path, fetchImpl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const getHealth = (fetchImpl = fetch) => getJson('/api/health', fetchImpl).then((data) => ({ success: true, data }));

export const getCatalog = (fetchImpl = fetch) => getJson('/api/catalog', fetchImpl);

/** Returns { design, revision } for the predefined basic wardrobe. */
export const getDefaultDesign = (fetchImpl = fetch) => getJson('/api/designs/default', fetchImpl);

/** One agent turn. Returns { reply, proposal | null }. Never changes the design. */
export const postChat = ({ messages, design, revision }, fetchImpl = fetch) =>
  postJson('/api/chat', { messages, design, revision }, fetchImpl);

/** Apply a signed proposal. Returns { design, revision }; throws ApiError 409 when stale. */
export const applyProposal = ({ design, revision, proposal }, fetchImpl = fetch) =>
  postJson('/api/proposals/apply', { design, revision, proposal }, fetchImpl);
