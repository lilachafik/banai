// Single committed-state store (no framework). The design only changes through
// domain ops (applyOps); a failed op leaves the state untouched. Snapshots are
// deep-frozen, so consumers can compare by reference.

import { applyOps } from '../domain/apply.js';
import { parseCatalog } from '../domain/catalog.js';
import { DomainError } from '../domain/errors.js';
import { locate } from '../domain/lookup.js';
import { deepFreeze } from '../domain/util.js';

const KIND_BY_LOCATION = Object.freeze({
  compartment: 'compartment',
  partition: 'partition',
  door: 'door',
  shelves: 'shelf',
  drawers: 'drawer',
  rails: 'rail',
});
const INTERIOR_KINDS = new Set(['shelf', 'drawer', 'rail', 'compartment', 'partition']);

/** Resolve a component id to a selection, or null when it does not exist. */
export function resolveSelection(design, id) {
  if (id === 'carcass') return { id, kind: 'carcass' };
  const found = typeof id === 'string' ? locate(design, id) : null;
  return found ? { id, kind: KIND_BY_LOCATION[found[0]] } : null;
}

/**
 * Create the store. The initial catalog and design are validated first (applyOps with
 * no ops = parse + full validation); invalid data throws instead of being rendered.
 */
export function createStore({ design, revision = 1, catalog }) {
  const validCatalog = parseCatalog(catalog);
  const validDesign = applyOps(design, [], validCatalog);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new DomainError('SCHEMA_INVALID', 'revision', 'invalid revision');
  }
  let state = deepFreeze({
    design: validDesign,
    revision,
    catalog: validCatalog,
    selection: null,
    ui: { doorsVisible: true },
    // An AI proposal awaiting Confirm/Cancel. Never part of the committed design.
    pendingProposal: null,
  });
  const listeners = new Set();

  const commit = (patch) => {
    state = deepFreeze({ ...state, ...patch });
    listeners.forEach((listener) => listener(state));
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Apply domain ops atomically. Returns { ok: true } or { ok: false, error: DomainError }. */
    dispatch(ops) {
      let next;
      try {
        next = applyOps(state.design, ops, state.catalog);
      } catch (error) {
        if (error instanceof DomainError) return { ok: false, error };
        throw error;
      }
      const selection = state.selection && resolveSelection(next, state.selection.id);
      commit({ design: next, revision: state.revision + 1, selection });
      return { ok: true };
    },

    /**
     * Commit a design produced by the server (an approved AI proposal). It is validated
     * like the initial design; invalid data throws and leaves the state untouched.
     */
    commitDesign(design, nextRevision) {
      const valid = applyOps(design, [], state.catalog);
      if (!Number.isInteger(nextRevision) || nextRevision <= state.revision) {
        throw new DomainError('SCHEMA_INVALID', 'revision', 'invalid revision');
      }
      const selection = state.selection && resolveSelection(valid, state.selection.id);
      commit({ design: valid, revision: nextRevision, selection });
    },

    setProposal(proposal) {
      commit({ pendingProposal: proposal });
    },

    clearProposal() {
      if (state.pendingProposal !== null) commit({ pendingProposal: null });
    },

    select(id) {
      const selection = id === null ? null : resolveSelection(state.design, id);
      const hideDoors = selection !== null && INTERIOR_KINDS.has(selection.kind) && state.ui.doorsVisible;
      commit({ selection, ui: hideDoors ? { ...state.ui, doorsVisible: false } : state.ui });
    },

    setDoorsVisible(doorsVisible) {
      commit({ ui: { ...state.ui, doorsVisible } });
    },
  };
}
