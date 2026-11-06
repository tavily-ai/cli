/** `tvly search` flags generated from the SDK's search parameter catalog. */
import { type ParameterDefinition, searchParameters } from "@tavily/core/parameters";
import { type Command, InvalidArgumentError, Option } from "commander";
import { parseNumberArg } from "../commands/options.js";

type SearchKey = keyof typeof searchParameters;

export const SEARCH_FLAG_OVERRIDES: Partial<
  Record<SearchKey, { flag?: string; positional?: true; bareValue?: string }>
> = {
  query: { positional: true },
  searchDepth: { flag: "depth" },
  includeAnswer: { bareValue: "basic" },
  includeRawContent: { bareValue: "markdown" },
};

export type SearchFlagSpec = {
  key: SearchKey;
  apiName: string;
  flags: string;
  description: string;
  parse: (raw: string | true) => unknown;
  choices?: readonly string[];
};

// The Python CLI's flags, in its order, so the top of `--help` stays familiar.
const PYTHON_ORDER: readonly SearchKey[] = [
  "searchDepth",
  "maxResults",
  "topic",
  "timeRange",
  "startDate",
  "endDate",
  "includeDomains",
  "excludeDomains",
  "country",
  "includeAnswer",
  "includeRawContent",
  "includeImages",
  "includeImageDescriptions",
  "chunksPerSource",
];

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
// The regex the SDK's serializeSearchParameters uses.
export const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function checkChoice(raw: string, choices: readonly string[]): string {
  if (!choices.includes(raw)) {
    throw new InvalidArgumentError(`Allowed choices are ${choices.join(", ")}.`);
  }
  return raw;
}

function toSpec(key: SearchKey, def: ParameterDefinition): SearchFlagSpec {
  const override = SEARCH_FLAG_OVERRIDES[key] ?? {};
  const flag = `--${override.flag ?? kebab(key)}`;
  const base = { key, apiName: snake(key), description: def.description };

  if (Array.isArray(def.type)) {
    // ["boolean", "string"]: an optional value; bare means `bareValue`, "true"/"false" are booleans.
    const values = "enum" in def ? def.enum : [];
    const choices = [
      ...values.filter((v) => typeof v === "string"),
      ...values.filter((v) => typeof v === "boolean"),
    ].map(String);
    return {
      ...base,
      flags: `${flag} [value]`,
      choices,
      parse: (raw) => {
        const value = checkChoice(raw === true ? (override.bareValue ?? "true") : raw, choices);
        return value === "true" ? true : value === "false" ? false : value;
      },
    };
  }
  switch (def.type) {
    case "boolean":
      return { ...base, flags: flag, parse: () => true };
    case "array":
      return {
        ...base,
        flags: `${flag} <list>`,
        parse: (raw) =>
          String(raw)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
      };
    case "integer":
    case "number":
      return {
        ...base,
        flags: `${flag} <n>`,
        parse: (raw) =>
          parseNumberArg(String(raw), {
            integer: def.type === "integer",
            ...(def.minimum !== undefined ? { minimum: def.minimum } : {}),
            ...(def.maximum !== undefined ? { maximum: def.maximum } : {}),
          }),
      };
    default: {
      const choices = "enum" in def ? def.enum.map(String) : undefined;
      return {
        ...base,
        flags: `${flag} <value>`,
        ...(choices ? { choices } : {}),
        parse: (raw) => (choices ? checkChoice(String(raw), choices) : String(raw)),
      };
    }
  }
}

/** One spec per catalog key except the positional query: Python's flags first, then the rest A–Z. */
export function searchFlagSpecs(): SearchFlagSpec[] {
  const keys = (Object.keys(searchParameters) as SearchKey[]).filter(
    (key) => !SEARCH_FLAG_OVERRIDES[key]?.positional,
  );
  const specs = keys.map((key) => toSpec(key, searchParameters[key]));
  const rank = (s: SearchFlagSpec) => PYTHON_ORDER.indexOf(s.key);
  const python = specs.filter((s) => rank(s) >= 0).sort((a, b) => rank(a) - rank(b));
  const rest = specs.filter((s) => rank(s) < 0).sort((a, b) => (a.flags < b.flags ? -1 : 1));
  return [...python, ...rest];
}

/** Add every generated flag to `cmd`; parsed values are stored under the camelCase catalog key. */
export function applySearchFlags(cmd: Command): Command {
  for (const spec of searchFlagSpecs()) {
    const option = new Option(spec.flags, spec.description);
    if (spec.choices) option.choices(spec.choices);
    if (!option.isBoolean()) option.argParser((raw: string) => spec.parse(raw));
    const bareValue = SEARCH_FLAG_OVERRIDES[spec.key]?.bareValue;
    if (bareValue !== undefined) option.preset(bareValue);
    // `--depth` would otherwise be stored as `depth`.
    option.attributeName = () => spec.key;
    cmd.addOption(option);
  }
  return cmd;
}

/** The snake_case request fields for the generated options that were set. */
export function searchBodyFromOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const spec of searchFlagSpecs()) {
    const value = opts[spec.key];
    // An array flag with no entries (`--include-domains ""`) sends nothing, as Python's did.
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    body[spec.apiName] = value;
  }
  return body;
}
