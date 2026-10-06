import { expect, it } from "vitest";
import { wordChanges } from "../src/wordDiff.js";

it.each([
  {
    name: "inserts a phrase before unchanged words",
    before: "the worker",
    after: "The runner takes one queued job and hands it to the worker",
    marked: [[], ["The runner takes one queued job and hands it to"]],
  },
  {
    name: "removes a phrase before unchanged words",
    before: "The runner takes one queued job and hands it to the worker",
    after: "the worker",
    marked: [["The runner takes one queued job and hands it to"], []],
  },
  {
    name: "separates phrases around unchanged words",
    before: "Keep old wording near the start and old words near the end.",
    after: "Keep clear wording near the start and new concise words near the end.",
    marked: [
      ["old", "old"],
      ["clear", "new concise"],
    ],
  },
  {
    name: "keeps the whitespace within each changed phrase",
    before: "Read stale  \t repeated text.",
    after: "Read fresh  \t chosen text.",
    marked: [["stale  \t repeated"], ["fresh  \t chosen"]],
  },
])("$name", ({ before, after, marked }) => {
  const text = [before, after];
  expect(
    wordChanges(before, after).map((ranges, side) =>
      ranges.map(({ from, to }) => text[side]!.slice(from, to)),
    ),
  ).toEqual(marked);
});
