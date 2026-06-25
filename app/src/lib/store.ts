/**
 * Mock data store — the v0 stand-in for Supabase Postgres.
 * Single DBSnapshot persisted to localStorage, with a useSyncExternalStore
 * binding for React. REPLAN: swap this module + lib/api.ts for supabase-js + RLS
 * / Edge `/v1` without touching the UI.
 */
import { useSyncExternalStore } from "react";
import type { DBSnapshot } from "@/types/domain";
import { buildSeed } from "@/seed/seed";

const KEY = "stanbase.db.v1";
const SCHEMA_VERSION = 2;

let state: DBSnapshot = load();
const listeners = new Set<() => void>();

function load(): DBSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DBSnapshot;
      if (parsed.version === SCHEMA_VERSION) return parsed;
    }
  } catch {
    /* fall through to seed */
  }
  const seed = buildSeed();
  persist(seed);
  return seed;
}

function persist(snap: DBSnapshot) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    /* quota / private mode — keep in memory */
  }
}

function emit() {
  listeners.forEach((l) => l());
}

export function getState(): DBSnapshot {
  return state;
}

/** Apply a mutation to the snapshot (returns a value), persist, and notify React. */
export function mutate<T>(fn: (draft: DBSnapshot) => T): T {
  const next = structuredClone(state);
  const result = fn(next);
  state = next;
  persist(state);
  emit();
  return result;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reset to a fresh demo seed. */
export function resetDemo(): void {
  state = buildSeed();
  persist(state);
  emit();
}

/** React hook: re-render on any store change; pass a selector to scope. */
export function useStore<T>(selector: (db: DBSnapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state)
  );
}
