import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../../src/state/store.js';
import { loadCatalog, loadDesign } from '../domain/helpers.js';

const catalog = loadCatalog();
const makeStore = () => createStore({ design: loadDesign('basic'), revision: 1, catalog });

describe('store', () => {
  it('exposes an immutable initial snapshot', () => {
    const state = makeStore().getState();
    expect(state.revision).toBe(1);
    expect(state.selection).toBeNull();
    expect(state.ui.doorsVisible).toBe(true);
    expect(Object.isFrozen(state.design.compartments[0])).toBe(true);
  });

  it('applies ops, bumps the revision and notifies subscribers', () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 450 }]);
    expect(result.ok).toBe(true);
    expect(store.getState().revision).toBe(2);
    expect(store.getState().design.compartments[0].shelves[0].y).toBe(450);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves state untouched and does not notify on a domain error', () => {
    const store = makeStore();
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 99999 }]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('OUT_OF_BOUNDS');
    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('selects components by id and resolves their kind', () => {
    const store = makeStore();
    store.select('shf_l2');
    expect(store.getState().selection).toEqual({ id: 'shf_l2', kind: 'shelf' });
    store.select('carcass');
    expect(store.getState().selection).toEqual({ id: 'carcass', kind: 'carcass' });
    store.select(null);
    expect(store.getState().selection).toBeNull();
    store.select('shf_unknown');
    expect(store.getState().selection).toBeNull();
  });

  it('hides doors when an interior component is selected', () => {
    const store = makeStore();
    store.select('dr_left');
    expect(store.getState().ui.doorsVisible).toBe(true);
    store.select('drw_r1');
    expect(store.getState().ui.doorsVisible).toBe(false);
  });

  it('clears the selection when the selected component is removed', () => {
    const store = makeStore();
    store.select('shf_l1');
    store.dispatch([{ op: 'remove_component', id: 'shf_l1' }]);
    expect(store.getState().selection).toBeNull();
  });

  it('toggles door visibility and unsubscribes listeners', () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setDoorsVisible(false);
    expect(store.getState().ui.doorsVisible).toBe(false);
    unsubscribe();
    store.setDoorsVisible(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('store input validation (Phase 3 security review M1)', () => {
  it('rejects an invalid initial design before anything renders', () => {
    const bad = structuredClone(loadDesign('basic'));
    bad.dimensions.width = -5000;
    expect(() => createStore({ design: bad, revision: 1, catalog })).toThrow();
    expect(() => createStore({ design: {}, revision: 1, catalog })).toThrow();
  });

  it('rejects a malformed or hostile catalog', () => {
    const missing = { materials: [], finishes: [] };
    expect(() => createStore({ design: loadDesign('basic'), revision: 1, catalog: missing })).toThrow();
    const hostile = structuredClone(catalog);
    hostile.colors[0].hex = 'red;background:url(https://evil/x)';
    expect(() => createStore({ design: loadDesign('basic'), revision: 1, catalog: hostile })).toThrow();
  });

  it('rejects an invalid revision', () => {
    expect(() => createStore({ design: loadDesign('basic'), revision: 0, catalog })).toThrow();
  });

  it('commits a validated server design with a higher revision', () => {
    const store = makeStore();
    const next = structuredClone(store.getState().design);
    next.compartments[0].shelves[0].y = 450;
    store.commitDesign(next, 2);
    expect(store.getState().revision).toBe(2);
    expect(store.getState().design.compartments[0].shelves[0].y).toBe(450);
    expect(() => store.commitDesign(next, 2)).toThrow(); // revision must move forward
    const invalid = { ...next, dimensions: { ...next.dimensions, width: 1 } };
    expect(() => store.commitDesign(invalid, 3)).toThrow();
    expect(store.getState().revision).toBe(2);
  });

  it('keeps a pending proposal outside the committed design', () => {
    const store = makeStore();
    const proposal = { baseRevision: 1, ops: [] };
    store.setProposal(proposal);
    expect(store.getState().pendingProposal).toBe(proposal);
    expect(store.getState().revision).toBe(1);
    expect('pendingProposal' in store.getState().design).toBe(false);
    store.clearProposal();
    expect(store.getState().pendingProposal).toBeNull();
  });
});
