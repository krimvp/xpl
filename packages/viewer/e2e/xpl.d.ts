/** The part of `window.__xpl` (src/testHooks.ts) the specs use. */
interface XplFocusRange {
  file: string;
  range: { startLine: number; endLine: number };
  role: string;
  elementId: string;
  status: string;
}

interface XplSnapshot {
  mode: string;
  viewId: string | null;
  viewType: string | null;
  selection: string[];
  cursor: { file: string; fromLine: number; toLine: number } | null;
  matches: string[];
  related: string[];
  panes: { file: string; focused: boolean; opened: boolean }[];
  focusFiles: string[];
  openedFile: string | null;
  graph: { nodes: string[]; edges: string[]; stubs: string[] } | null;
  serverMode: boolean;
  dirty: boolean;
  include: string[] | null;
  edgeKinds: string[] | null;
}

interface XplHooks {
  select(ids: string[]): void;
  selection(): string[];
  focus(): XplFocusRange[];
  matches(): string[];
  setCursor(file: string, line: number): void;
  setView(id: string): void;
  state(): XplSnapshot;
}

interface Window {
  __xpl?: XplHooks;
}
