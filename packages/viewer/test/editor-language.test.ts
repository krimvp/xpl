import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { languageSupport } from "../src/editor.js";

describe("Java editor language support", () => {
  it("parses Java source in the editor", () => {
    const state = EditorState.create({
      doc: "class Example { void run() {} }",
      extensions: [languageSupport("java")],
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000);

    expect(tree).not.toBeNull();
    expect(tree!.toString()).toContain("ClassDeclaration");
    expect(tree!.toString()).toContain("MethodDeclaration");
  });
});
