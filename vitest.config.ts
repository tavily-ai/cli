import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    // Builds dist/ once, so `npx vitest run` works without `npm run build` first.
    globalSetup: ["tests/helpers/build-dist.ts"],
    // The cold-start timing test runs after every other file so parallel load cannot skew it.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/startup.test.ts",
            // install.sh is a POSIX script tested under script(1) ptys.
            ...(process.platform === "win32" ? ["tests/install-sh.test.ts"] : []),
          ],
        },
      },
      {
        extends: true,
        test: { name: "startup", include: ["tests/startup.test.ts"], sequence: { groupOrder: 1 } },
      },
    ],
  },
});
