import { describe, expect, it } from "vitest";
import { shortText } from "../src/index.js";

describe("shortText: what a box, an arrow, a list or a title shows of a text", () => {
  it.each([
    // a draft's placeholder that names the code: the name, marked as not written
    ["TODO: 1-3 plain words for this part (now: worker)", "worker (TODO)"],
    ["TODO: 2-5 plain words for this file (now: anchors.ts)", "anchors.ts (TODO)"],
    [
      "TODO: the condition, in a few words (now: `if (job.attempts < max)`)",
      "if (job.attempts < max) (TODO)",
    ],
    [
      "TODO: what this map shows, in plain words (now: the files of src/node)",
      "the files of src/node (TODO)",
    ],
    // one that does not: the mark alone, never the instruction or its example
    ["TODO: 1-4 words: what they do with it (for example: sends requests)", "TODO"],
    ["TODO: what this part is for, as a plain statement", "TODO"],
    // written words before the placeholder stay
    [
      "Where to go next: TODO: where a newcomer starts reading, as a plain statement",
      "Where to go next: TODO",
    ],
  ])("%s", (text, shown) => {
    expect(shortText(text)).toBe(shown);
  });

  it.each([
    "Job queue",
    "Reads the settings",
    // not a placeholder: a word that holds TODO, and TODO as code
    "TODO_LIST handling",
    "Collects `TODO` comments (now: grep)",
  ])("a written text shows as it is: %s", (text) => {
    expect(shortText(text)).toBe(text);
  });
});
