import type { TavilyClientLike } from "./core/tavily-client.js";

/** What the API commands take from the outside world; tests substitute a stub client. */
export interface Context {
  resolveClient(key: string | null, clientName?: string): Promise<TavilyClientLike>;
}

/** Loads the SDK only when a command calls the API, so startup and the REPL never pay for it. */
export const defaultContext: Context = {
  resolveClient: async (key, clientName) =>
    (await import("./core/client-factory.js")).buildClient(key, clientName),
};
