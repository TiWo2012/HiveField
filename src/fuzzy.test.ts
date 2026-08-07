import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  test("an empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  test("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("zzz", "hello")).toBeNull();
    expect(fuzzyMatch("abc", "ab")).toBeNull();
    expect(fuzzyMatch("foo", "bar baz")).toBeNull();
  });

  test("is case-insensitive and reports matched indices", () => {
    expect(fuzzyMatch("ABC", "abcdef")).not.toBeNull();
    expect(fuzzyMatch("abc", "ABCdef")!.indices).toEqual([0, 1, 2]);
  });

  test("a match starting at the beginning scores higher than one later", () => {
    const prefix = fuzzyMatch("term", "terminal")!;
    const later = fuzzyMatch("term", "subterm")!;
    expect(prefix.score).toBeGreaterThan(later.score);
  });

  test("consecutive matches score higher than gapped ones", () => {
    const adjacent = fuzzyMatch("ab", "abxxxx")!;
    const gapped = fuzzyMatch("ab", "axbxxxx")!;
    expect(adjacent.score).toBeGreaterThan(gapped.score);
  });

  test("a match after a word boundary scores higher", () => {
    const boundary = fuzzyMatch("fs", "file-system")!;
    const plain = fuzzyMatch("fs", "fabs")!;
    expect(boundary.score).toBeGreaterThan(plain.score);
  });

  test("a camelCase boundary scores higher", () => {
    const camel = fuzzyMatch("tc", "toCamel")!;
    const plain = fuzzyMatch("tc", "tocamel")!;
    expect(camel.score).toBeGreaterThan(plain.score);
  });

  test("reports ascending matched indices for highlighting", () => {
    const r = fuzzyMatch("hf", "hiveField")!;
    expect(r.indices).toEqual([0, 4]);
  });
});
