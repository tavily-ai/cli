import { searchParameters } from "@tavily/core/parameters";
import { Command } from "commander";
import { expect, test } from "vitest";
import {
  applySearchFlags,
  searchBodyFromOptions,
  searchFlagSpecs,
} from "../src/core/search-flags.js";

const specs = searchFlagSpecs();
const spec = (key: string) => {
  const s = specs.find((x) => x.key === key);
  if (!s) throw new Error(`no spec for ${key}`);
  return s;
};
const flagName = (flags: string) => flags.split(/\s/)[0]?.replace(/^--/, "");

test("every catalog key except query produces exactly one spec", () => {
  const keys = Object.keys(searchParameters).filter((k) => k !== "query");
  expect(specs.map((s) => s.key).sort()).toEqual(keys.sort());
});

test("searchDepth is --depth with the catalog choices", () => {
  const s = spec("searchDepth");
  expect(s.flags).toBe("--depth <value>");
  expect(searchBodyFromOptions({ searchDepth: "basic" })).toEqual({ search_depth: "basic" });
  expect(s.choices).toEqual(["basic", "advanced", "fast", "ultra-fast"]);
});

test("maxResults is --max-results <n> and enforces the catalog bounds", () => {
  const s = spec("maxResults");
  expect(s.flags).toBe("--max-results <n>");
  expect(s.parse("3")).toBe(3);
  expect(() => s.parse("21")).toThrow(/maximum 20/);
  expect(() => s.parse("-1")).toThrow(/minimum 0/);
  expect(() => s.parse("2.5")).toThrow();
  expect(() => s.parse("abc")).toThrow();
});

test("number flags accept fractions", () => {
  expect(spec("days").parse("1.5")).toBe(1.5);
});

test("includeDomains splits on commas and trims", () => {
  expect(spec("includeDomains").parse("a.com, b.com")).toEqual(["a.com", "b.com"]);
});

test("array flags drop empty entries and send nothing when no entries remain", () => {
  const s = spec("includeDomains");
  expect(s.parse("a.com,,b.com")).toEqual(["a.com", "b.com"]);
  expect(s.parse("")).toEqual([]);
  expect(s.parse(" , ")).toEqual([]);
  for (const raw of ["", " , "]) {
    const cmd = applySearchFlags(new Command("search").exitOverride().argument("[q...]"));
    cmd.parse(["q", "--include-domains", raw, "--exclude-domains", "x.com,,"], { from: "user" });
    expect(searchBodyFromOptions(cmd.opts())).toEqual({ exclude_domains: ["x.com"] });
  }
});

test("includeAnswer bare is basic; a value passes through; booleans are accepted", () => {
  const s = spec("includeAnswer");
  expect(s.flags).toBe("--include-answer [value]");
  expect(s.parse(true)).toBe("basic");
  expect(s.parse("advanced")).toBe("advanced");
  expect(s.parse("true")).toBe(true);
  expect(s.parse("false")).toBe(false);
  expect(() => s.parse("bogus")).toThrow(/Allowed choices/);
  expect(spec("includeRawContent").parse(true)).toBe("markdown");
});

test("catalog-only keys get kebab-case flags", () => {
  expect(spec("safeSearch").flags).toBe("--safe-search");
  expect(spec("maxAgeHours").flags).toBe("--max-age-hours <n>");
});

test("flag names are unique and do not collide with the fixed options", () => {
  const names = specs.map((s) => flagName(s.flags));
  expect(new Set(names).size).toBe(names.length);
  for (const fixed of ["output", "client-name", "json", "max-chars"]) {
    expect(names).not.toContain(fixed);
  }
});

test("Python flags come first in Python order, then catalog-only flags alphabetically", () => {
  const names = specs.map((s) => flagName(s.flags));
  const python = [
    "depth",
    "max-results",
    "topic",
    "time-range",
    "start-date",
    "end-date",
    "include-domains",
    "exclude-domains",
    "country",
    "include-answer",
    "include-raw-content",
    "include-images",
    "include-image-descriptions",
    "chunks-per-source",
  ];
  expect(names.slice(0, python.length)).toEqual(python);
  const rest = names.slice(python.length);
  expect(rest.length).toBeGreaterThan(0);
  expect(rest).toEqual([...rest].sort());
});

test("searchBodyFromOptions emits snake_case keys only for set options", () => {
  expect(
    searchBodyFromOptions({ searchDepth: "fast", maxResults: 3, output: "x", clientName: "y" }),
  ).toEqual({ search_depth: "fast", max_results: 3 });
});

test("applySearchFlags parses argv into catalog keys", () => {
  const cmd = applySearchFlags(new Command("search").exitOverride().argument("[q...]"));
  cmd.parse(
    [
      "q",
      "--depth",
      "advanced",
      "--include-answer",
      "--include-domains",
      "a.com,b.com",
      "--safe-search",
      "--chunks-per-source",
      "2",
    ],
    { from: "user" },
  );
  expect(searchBodyFromOptions(cmd.opts())).toEqual({
    search_depth: "advanced",
    include_answer: "basic",
    include_domains: ["a.com", "b.com"],
    safe_search: true,
    chunks_per_source: 2,
  });
});

test("applySearchFlags rejects out-of-range and unknown choice values", () => {
  const make = () =>
    applySearchFlags(
      new Command("search")
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .argument("[q...]"),
    );
  expect(() => make().parse(["q", "--max-results", "21"], { from: "user" })).toThrow(/maximum 20/);
  expect(() => make().parse(["q", "--depth", "deep"], { from: "user" })).toThrow(/Allowed choices/);
});
