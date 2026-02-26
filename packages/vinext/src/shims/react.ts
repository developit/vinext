/**
 * React compatibility shim.
 *
 * Re-exports everything from preact/compat (which covers React 16–18 APIs)
 * and adds React 19 APIs that preact/compat doesn't provide:
 * - `use` — unwraps a Promise or Context
 * - `useActionState` — form action state hook
 * - `useOptimistic` — optimistic update hook
 * - `cache` — per-request caching of async functions
 */

// preact/compat re-exports — covers React 16–18 APIs
export {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createFactory,
  createPortal,
  createRef,
  forwardRef,
  hydrate,
  isValidElement,
  lazy,
  memo,
  render,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} from "preact/compat";

export { default } from "preact/compat";

// React 19: use() — unwraps a Promise or reads a Context value.
// In SSR, Promises are resolved before rendering (by _resolveAsyncTree),
// so `use()` here only needs to handle the Context case. For Promises,
// we throw the promise to trigger Suspense (matching React behavior).
export function use<T>(usable: Promise<T> | { _currentValue: T; _currentValue2?: T }): T {
  if (usable && typeof usable === "object" && "_currentValue" in usable) {
    // It's a Context — return the current value
    return (usable as { _currentValue: T })._currentValue;
  }
  if (usable && typeof (usable as Promise<T>).then === "function") {
    // It's a Promise — throw to trigger Suspense (React behavior)
    throw usable;
  }
  return usable as T;
}

// React 19: useActionState() — manages form action state.
// Stub implementation for Preact SSR compatibility.
export function useActionState<State>(
  _action: (state: State, payload: FormData) => State | Promise<State>,
  initialState: State,
  _permalink?: string,
): [State, (payload: FormData) => void, boolean] {
  return [initialState, () => {}, false];
}

// React 19: useOptimistic() — optimistic state updates.
// Returns the current state and a no-op dispatch for SSR.
export function useOptimistic<State>(
  state: State,
  _updateFn?: (state: State, payload: unknown) => State,
): [State, (action: unknown) => void] {
  return [state, () => {}];
}

// React 19: cache() — per-request function memoization.
// In Preact SSR mode, just pass through the function without caching.
export function cache<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn;
}
