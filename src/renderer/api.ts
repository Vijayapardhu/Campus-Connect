import type { CampusConnectApi } from '../shared/bridge';

/**
 * The bridge, resolved when it is used rather than when a module is loaded.
 *
 * On the desktop `window.campusConnect` is installed by the preload script long
 * before any of this runs, so capturing it at module scope was fine. On a phone
 * it is built from `fetch` *after* the bundle has loaded — and every module that
 * had written `const api = window.campusConnect` at the top had already captured
 * `undefined` by then, which failed at the first call with nothing useful to say
 * about why.
 *
 * A proxy defers the lookup to the moment of the call, which makes load order
 * stop mattering. It also binds each method to the real object: a function
 * pulled off `contextBridge` and called detached throws `Illegal invocation`,
 * and that error tells you nothing at all about its cause.
 */
export const api = new Proxy({} as CampusConnectApi, {
  get(_target, property) {
    const bridge = window.campusConnect as unknown as Record<string | symbol, unknown> | undefined;
    if (!bridge) {
      throw new Error('Campus Connect is not ready yet.');
    }

    const value = bridge[property];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(bridge) : value;
  }
});
