import { expect, test } from "vitest";
import { splitShellWords } from "../src/util/shell-words.js";

test("splits on whitespace and groups double quotes", () => {
  expect(splitShellWords('search "two words" --max-results 3')).toEqual([
    "search",
    "two words",
    "--max-results",
    "3",
  ]);
});

test("single quotes keep backslashes literally", () => {
  expect(splitShellWords("echo 'a\\nb'")).toEqual(["echo", "a\\nb"]);
});

test("backslash outside quotes escapes the next character", () => {
  expect(splitShellWords("a\\ b")).toEqual(["a b"]);
});

test("double quotes only escape quote and backslash (shlex posix)", () => {
  expect(splitShellWords('"a\\"b\\\\c\\$d\\`e\\nf"')).toEqual(['a"b\\c\\$d\\`e\\nf']);
});

test("adjacent quoted segments join and empty quotes yield an empty word", () => {
  expect(splitShellWords("a\"b\"'c' ''")).toEqual(["abc", ""]);
});
