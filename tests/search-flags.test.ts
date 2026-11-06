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

test("every catalog key except query produces exactly one spec", () => {
  const keys = Object.keys(searchParameters).filter((k) => k !== "query");
  expect(specs.map((s) => s.key).sort()).toEqual(keys.sort());
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
