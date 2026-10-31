// What this page is doing for an item: a Queue, Back to List, Abandon or Needs you choice in flight, or the error
// it left. Keyed by item id.

import { create } from 'zustand';
export interface ItemAction {
  phase: 'pending' | 'error';
  kind: 'queue' | 'back-to-list' | 'abandon' | 'needs-you' | 'dependency-met';
  message?: string;
}

/** `record` with `key` set to `value`, or without `key` when `value` is `undefined`. */
export function setKey<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return value ? { ...rest, [key]: value } : rest;
}

interface ActionState {
  actions: Record<string, ItemAction>;
  /** Sets the item's action, or clears it with `undefined`. */
  set: (itemId: string, action: ItemAction | undefined) => void;
}

export const useActionStore = create<ActionState>()((set) => ({
  actions: {},
  set: (itemId, action) => set((state) => ({ actions: setKey(state.actions, itemId, action) })),
}));

export const useItemAction = (itemId: string): ItemAction | undefined => useActionStore((state) => state.actions[itemId]);
