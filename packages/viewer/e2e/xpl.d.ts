/**
 * `window.__xpl` in the specs: the very types of src/testHooks.ts (the contract of ARCHITECTURE.md
 * section 6 plus the Present hooks), so the specs and the page cannot drift apart.
 */
import type { XplHooks } from "../src/testHooks.js";

declare global {
  interface Window {
    __xpl?: XplHooks;
  }
}
