import { expect, test } from "vitest";
import { compareVersions, isNewer } from "../src/util/semver.js";

test("compares numerically per component", () => {
  expect(compareVersions("0.3.0", "0.2.1")).toBe(1);
  expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
});

test("release ranks above its prerelease", () => {
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
});

test("prerelease identifiers compare per identifier", () => {
  expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
  expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBe(1);
  expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  expect(compareVersions("1.0.0-rc", "1.0.0-rc.1")).toBe(-1);
});

test("unparsable versions throw", () => {
  expect(() => isNewer("0.3.0", "abc")).toThrow("The installed Tavily CLI version is invalid.");
  expect(() => compareVersions("abc", "1.0.0")).toThrow(
    "The installed Tavily CLI version is invalid.",
  );
});
