import { go } from "@codemirror/lang-go";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { FileLanguage } from "@xpl/core";

/** CodeMirror language support for an `IndexedFile.language`. */
export function languageSupport(language: FileLanguage): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "python":
      return python();
    case "go":
      return go();
    case "yaml":
      return yaml();
    case "json":
      return json();
    case "text":
      return [];
  }
}

/**
 * A read-only editor: the document cannot change, but the cursor and selection still work (the
 * viewer maps them back to diagram elements). The caller owns the view and must `destroy()` it.
 */
export function createReadOnlyEditor(
  parent: HTMLElement,
  doc: string,
  language: FileLanguage,
): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.readOnly.of(true),
        lineNumbers(),
        syntaxHighlighting(defaultHighlightStyle),
        languageSupport(language),
      ],
    }),
  });
}
