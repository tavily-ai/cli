/** Interactive questions, drawn by @clack/prompts on stderr so stdout stays for command output. */
import * as clack from "@clack/prompts";
import { ExitError } from "../errors.js";

export interface Choice<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

export interface Prompter {
  confirm(message: string, initial?: boolean): Promise<boolean>;
  select<V extends string>(message: string, choices: Choice<V>[], initial?: V): Promise<V>;
  multiselect<V extends string>(message: string, choices: Choice<V>[], initial: V[]): Promise<V[]>;
  password(message: string): Promise<string>;
}

const output = process.stderr;

/** Ctrl-C or Esc at a prompt ends the run with exit code 1. */
export function answered<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel("Setup cancelled.", { output });
    throw new ExitError(1);
  }
  return value as Exclude<T, symbol>;
}

// clack's Option<V> is a conditional type a generic V cannot resolve, hence the cast.
const options = <V extends string>(choices: Choice<V>[]) => choices as clack.Option<V>[];

export const clackPrompter: Prompter = {
  confirm: async (message, initial = true) =>
    answered(await clack.confirm({ message, initialValue: initial, output })),
  select: async (message, choices, initial) =>
    answered(
      await clack.select({
        message,
        options: options(choices),
        ...(initial !== undefined && { initialValue: initial }),
        output,
      }),
    ),
  multiselect: async (message, choices, initial) =>
    answered(
      await clack.multiselect({
        message,
        options: options(choices),
        initialValues: initial,
        required: false,
        output,
      }),
    ),
  password: async (message) =>
    answered(
      await clack.password({
        message,
        validate: (value) => (value?.trim() ? undefined : "Enter a key"),
        output,
      }),
    ).trim(),
};
