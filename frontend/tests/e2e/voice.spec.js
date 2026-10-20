// Phase 5b: voice dictation. Runs in the "voice" project (Chromium's fake microphone).
// /api/transcribe and /api/chat are mocked: the transcript must land in the input for review
// and must never reach the agent until the customer presses Send.
import { expect, openDesigner, test } from './fixtures.js';

const TRANSCRIPT = 'Add a shelf at 80 cm in the left compartment';

async function mockVoice(page, { status = 200 } = {}) {
  const seen = { transcribe: [], chat: 0 };
  await page.route('**/api/transcribe', async (route) => {
    const request = route.request();
    seen.transcribe.push({ type: request.headers()['content-type'], bytes: request.postDataBuffer()?.length ?? 0 });
    const body = status === 200
      ? { success: true, data: { text: TRANSCRIPT } }
      : { success: false, data: null, error: { code: 'AGENT_UNAVAILABLE', message: 'x' } };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/chat', async (route) => {
    seen.chat += 1;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { reply: 'Which height exactly?', proposal: null } }) });
  });
  return seen;
}

const input = (page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.describe('Phase 5b: voice dictation', () => {
  test.beforeEach(async ({ page }) => openDesigner(page));

  test('dictation fills the input for review and sends nothing until Send', async ({ page }) => {
    const seen = await mockVoice(page);
    await expect(page.getByText('Voice is transcribed by OpenAI and not stored.')).toBeVisible();
    await page.getByRole('button', { name: 'Start voice input' }).click();
    await expect(page.getByRole('button', { name: 'Stop voice input' })).toBeVisible();
    await expect(page.getByText(/0:0\d Listening…/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Stop voice input' }).click();

    await expect(input(page)).toHaveValue(TRANSCRIPT);
    expect(seen.transcribe).toHaveLength(1);
    expect(seen.transcribe[0].type).toMatch(/^audio\//);
    expect(seen.transcribe[0].bytes).toBeGreaterThan(0);
    expect(seen.chat).toBe(0); // review before send

    await input(page).fill(`${TRANSCRIPT}, please`); // the customer can correct it
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Which height exactly?')).toBeVisible();
    expect(seen.chat).toBe(1);
  });

  test.describe('when the server cannot transcribe', () => {
    test.use({ expectedConsoleErrors: ['status of 503'] });

    test('shows a fixed error and leaves the input untouched', async ({ page }) => {
      await mockVoice(page, { status: 503 });
      await input(page).fill('typed text');
      await page.getByRole('button', { name: 'Start voice input' }).click();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Stop voice input' }).click();
      await expect(page.getByText('Voice input is not available on this server.')).toBeVisible();
      await expect(input(page)).toHaveValue('typed text');
    });
  });

  test('a blocked microphone shows a fixed message', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await openDesigner(page);
    await page.getByRole('button', { name: 'Start voice input' }).click();
    await expect(page.getByText('Microphone access is blocked. Allow it in your browser to use voice input.')).toBeVisible();
  });
});
