import { CANCEL_SYMBOL } from "@clack/prompts";
import { expect, test } from "vitest";
import { answered } from "../src/ui/prompts.js";
import { captureOutput } from "./helpers/capture.js";

const io = captureOutput();

test("an answer passes through", () => {
  expect(answered("tvly-abc")).toBe("tvly-abc");
});

test("clack's cancel symbol prints Setup cancelled. and exits 1", () => {
  expect(() => answered(CANCEL_SYMBOL)).toThrow(expect.objectContaining({ code: 1 }));
  expect(io.stderr()).toContain("Setup cancelled.");
});
