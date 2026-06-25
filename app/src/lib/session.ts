/**
 * Mock sessions — the v0 stand-in for Supabase Auth (§30: OTP + OAuth in prod).
 *  - member session: which member persona is "logged in" on the member front.
 *  - admin session: which org is active in the admin org-selector (1 Conta ↔ N orgs).
 */
import { useSyncExternalStore } from "react";

function reactiveLocal<T>(key: string, initial: T) {
  let value: T = read();
  const listeners = new Set<() => void>();

  function read(): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  }
  function get(): T {
    return value;
  }
  function set(next: T): void {
    value = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  }
  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function use(): T {
    return useSyncExternalStore(subscribe, get, get);
  }
  return { get, set, use };
}

/** Member front: the logged-in member's internal id (null = anonymous). */
export const memberSession = reactiveLocal<string | null>("stanbase.session.member", null);

/** Admin: active org id (default resolved by the admin shell). */
export const adminOrg = reactiveLocal<string | null>("stanbase.session.org", null);
