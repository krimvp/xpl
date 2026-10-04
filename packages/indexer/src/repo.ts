import { readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import type { FilePath } from "@xpl/core";
import type { RepoView } from "./languages/types.js";
/** `RepoView` over the indexed files of a build. */
export class SourceRepoView implements RepoView {
  readonly files: ReadonlySet<FilePath>;
  private readonly dirs = new Map<string, FilePath[]>();
  private readonly texts = new Map<FilePath, string | undefined>();

  constructor(
    readonly root: string,
    paths: readonly FilePath[],
    private readonly getText?: (path: FilePath) => string | undefined,
  ) {
    this.files = new Set(paths);
    for (const path of paths) {
      const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
      const list = this.dirs.get(dir);
      if (list) list.push(path);
      else this.dirs.set(dir, [path]);
    }
    for (const list of this.dirs.values()) list.sort();
  }

  filesInDir(dir: string): readonly FilePath[] {
    return this.dirs.get(dir === "." ? "" : dir) ?? [];
  }

  readText(path: FilePath): string | undefined {
    if (this.texts.has(path)) return this.texts.get(path);
    let text: string | undefined;
    const normalized = posix.normalize(path);
    if (!normalized.startsWith("../") && !isAbsolute(normalized)) {
      try {
        text = this.getText
          ? this.getText(path)
          : readFileSync(join(this.root, ...normalized.split("/")), "utf8");
      } catch {
        text = undefined;
      }
    }
    this.texts.set(path, text);
    return text;
  }
}
