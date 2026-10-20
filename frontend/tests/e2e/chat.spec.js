// Phase 5: AI chat with Confirm / Cancel / Stale. The agent endpoints are mocked with
// page.route, so the suite is deterministic and never calls the LLM; the mocked apply
// endpoint uses the real domain engine.
import { applyOps } from '../../src/domain/apply.js';
import { loadCatalog } from '../unit/domain/helpers.js';
import { clickComponent, expect, openDesigner, test } from './fixtures.js';

const catalog = loadCatalog();
const SHELF_OP = { op: 'add_shelf', compartmentId: 'cmp_left', y: 1800, id: 'shf_ai1' };

const proposal = (baseRevision = 1) => ({
  proposalId: 'a'.repeat(32), baseRevision, baseHash: 'b'.repeat(64), expiresAt: 4102444800,
  ops: [SHELF_OP], summary: ['Add a shelf at 180.0 cm in compartment 1'], signature: 'c'.repeat(64),
});

const json = (route, status, body) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function mockAgent(page, { reply = 'Adding a shelf near the top.', applyStatus = 200 } = {}) {
  const seen = { chat: [], apply: [] };
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON();
    seen.chat.push(body);
    await json(route, 200, { success: true, data: { reply, proposal: proposal(body.revision) } });
  });
  await page.route('**/api/proposals/apply', async (route) => {
    const body = route.request().postDataJSON();
    seen.apply.push(body);
    if (applyStatus !== 200) {
      await json(route, applyStatus, { success: false, data: null, error: { code: 'STALE', message: 'x' } });
      return;
    }
    const design = applyOps(body.design, body.proposal.ops, catalog);
    await json(route, 200, { success: true, data: { design, revision: body.revision + 1 } });
  });
  return seen;
}

const state = (page) => page.evaluate(() => {
  const { design, revision, pendingProposal } = window.__banai.store.getState();
  return { design, revision, pendingProposal };
});

async function ask(page, text) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('proposal-card').last()).toBeVisible();
}

test.describe('Phase 5: AI agent', () => {
  test.beforeEach(async ({ page }) => openDesigner(page));

  test('a proposal changes nothing until Confirm; Confirm updates the 3D model and the editor', async ({ page }) => {
    const seen = await mockAgent(page);
    await ask(page, 'Add a shelf at 180 cm on the left');
    await expect(page.getByText('Add a shelf at 180 cm on the left')).toBeVisible();
    await expect(page.getByText('Adding a shelf near the top.')).toBeVisible();
    await expect(page.getByText('Add a shelf at 180.0 cm in compartment 1')).toBeVisible();
    expect((await state(page)).revision).toBe(1);
    expect(await page.evaluate(() => Boolean(window.__banai.viewer.meshOf('shf_ai1')))).toBe(false);

    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Changes applied.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(window.__banai.viewer.meshOf('shf_ai1')))).toBe(true);
    const after = await state(page);
    expect(after.revision).toBe(2);
    expect(after.pendingProposal).toBeNull();
    expect(seen.apply).toHaveLength(1);

    // The new shelf is selectable and shows its properties in the editor.
    await page.getByLabel('Show interior').check();
    await clickComponent(page, 'shf_ai1');
    await expect(page.getByTestId('shelf-y')).toHaveValue('180.0');
  });

  test('Cancel leaves the design unchanged', async ({ page }) => {
    const seen = await mockAgent(page);
    await ask(page, 'Add a shelf');
    const before = await state(page);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Proposal cancelled. Nothing was changed.')).toBeVisible();
    const after = await state(page);
    expect(after.design).toEqual(before.design);
    expect(after.revision).toBe(before.revision);
    expect(seen.apply).toHaveLength(0);
  });

  test('a manual edit while a proposal is pending makes it stale; the agent then sees the edit', async ({ page }) => {
    const seen = await mockAgent(page);
    await ask(page, 'Add a shelf');
    const height = page.getByTestId('dim-height');
    await height.fill('250');
    await height.press('Enter');
    const card = page.getByTestId('proposal-card');
    await expect(card.getByText('Design changed – ask the agent to re-propose.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(seen.chat).toHaveLength(1); // the manual edit did not call the agent

    await ask(page, 'Try again please');
    expect(seen.chat[1].revision).toBe(2);
    expect(seen.chat[1].design.dimensions.height).toBe(2500);
  });

  test.describe('when the server rejects the proposal', () => {
    test.use({ expectedConsoleErrors: ['status of 409'] });

    test('a 409 from the server marks the proposal stale', async ({ page }) => {
      await mockAgent(page, { applyStatus: 409 });
      await ask(page, 'Add a shelf');
      await page.getByRole('button', { name: 'Confirm' }).click();
      await expect(page.getByText('Design changed – ask the agent to re-propose.')).toBeVisible();
      expect((await state(page)).revision).toBe(1);
    });
  });

  test('agent text is rendered as text, never as markup', async ({ page }) => {
    await mockAgent(page, { reply: '<img src=x onerror="window.__xss=1">Hi' });
    await ask(page, 'Hello');
    await expect(page.getByText('<img src=x onerror="window.__xss=1">Hi')).toBeVisible();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('#chat-thread img').count()).toBe(0);
  });
});
