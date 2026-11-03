// Preloaded into dist/cli.js with `node --import` by the contract test: sends the update check's
// hard-coded npm registry request to the fixture server named by TVLY_FIXTURE_REGISTRY.
const target = process.env.TVLY_FIXTURE_REGISTRY;
const realFetch = globalThis.fetch;
const REGISTRY = "https://registry.npmjs.org/";

globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target && url.startsWith(REGISTRY)) {
    return realFetch(`${target}/${url.slice(REGISTRY.length)}`, init);
  }
  return realFetch(input, init);
};
