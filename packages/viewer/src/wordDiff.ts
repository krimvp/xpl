type WordRange = { from: number; to: number };

/** Changed phrases on each side, including internal whitespace. Bound the comparison cost. */
export function wordChanges(before: string, after: string): [WordRange[], WordRange[]] {
  const words = [before, after].map((text) => [...text.matchAll(/\S+/g)]);
  const [a, b] = words as [RegExpMatchArray[], RegExpMatchArray[]];
  const common = [new Set<number>(), new Set<number>()];
  if (a.length * b.length <= 250000) {
    const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        rows[i]![j] =
          a[i]![0] === b[j]![0]
            ? rows[i + 1]![j + 1]! + 1
            : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
    let i = 0,
      j = 0;
    while (i < a.length && j < b.length) {
      if (a[i]![0] === b[j]![0]) {
        common[0]!.add(i++);
        common[1]!.add(j++);
      } else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) i++;
      else j++;
    }
  } else {
    // Long details retain common ends and mark the changed passage without a quadratic matrix.
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i]![0] === b[i]![0]) {
      common[0]!.add(i);
      common[1]!.add(i++);
    }
    let x = a.length - 1,
      y = b.length - 1;
    while (x >= i && y >= i && a[x]![0] === b[y]![0]) {
      common[0]!.add(x--);
      common[1]!.add(y--);
    }
  }
  return words.map((items, side) => {
    const ranges: WordRange[] = [];
    for (const [i, word] of items.entries()) {
      if (common[side]!.has(i)) continue;
      const to = word.index! + word[0].length;
      if (i > 0 && !common[side]!.has(i - 1)) ranges.at(-1)!.to = to;
      else ranges.push({ from: word.index!, to });
    }
    return ranges;
  }) as [WordRange[], WordRange[]];
}
