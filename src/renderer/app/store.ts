import type { AppSnapshot } from '../../shared/types';
import { createMockApi } from './mock';

export type Api = NonNullable<Window['quill']>;

export const api: Api = window.quill ?? createMockApi();

type Listener = (s: AppSnapshot, prev: AppSnapshot | null) => void;
const listeners = new Set<Listener>();
let current: AppSnapshot | null = null;

export function snapshot() {
  return current!;
}

export function subscribe(fn: Listener) {
  listeners.add(fn);
  if (current) fn(current, null);
  return () => listeners.delete(fn);
}

export function setSnapshot(s: AppSnapshot) {
  const prev = current;
  current = s;
  for (const l of listeners) l(s, prev);
}

export async function initStore() {
  api.onUpdate(setSnapshot);
  setSnapshot(await api.snapshot());
}
