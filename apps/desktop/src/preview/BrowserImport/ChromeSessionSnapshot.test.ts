import { describe, expect, it } from "@effect/vitest";
import { parseChromeSessionSnapshot } from "./ChromeSessionSnapshot.ts";

const cookie = {
  name: "session",
  value: "synthetic-test-value",
  domain: "localhost",
  path: "/",
  secure: false,
  httpOnly: true,
  hostOnly: true,
  sameSite: "lax",
  session: true,
};
const snapshot = (cookies: unknown[]) =>
  JSON.stringify({
    version: 1,
    browser: "chrome",
    capturedAt: "2026-10-12T01:00:00Z",
    profileName: "Local test",
    domains: ["localhost"],
    scope: "current-domain",
    cookies,
  });

describe("Chrome extension session import", () => {
  it("retains an HttpOnly session cookie without widening host-only scope", () => {
    const parsed = parseChromeSessionSnapshot(snapshot([cookie]), 1_000_000);
    expect(parsed.read.cookies).toEqual([
      {
        url: "http://localhost/",
        name: "session",
        value: "synthetic-test-value",
        domain: undefined,
        path: "/",
        secure: false,
        httpOnly: true,
        expirationDate: undefined,
        sameSite: "lax",
      },
    ]);
    expect(parsed.domains).toEqual(["localhost"]);
  });

  it("reports expired and partitioned cookies instead of changing their meaning", () => {
    const parsed = parseChromeSessionSnapshot(
      snapshot([
        { ...cookie, expirationDate: 1 },
        { ...cookie, partitionKey: { topLevelSite: "https://example.test" } },
        { ...cookie, domain: ".example.test", hostOnly: false, secure: true },
      ]),
      1_000_000,
    );
    expect(parsed.read.undecryptable).toBe(2);
    expect(parsed.read.undecryptableHosts).toEqual(["localhost"]);
    expect(parsed.read.cookies[0]?.domain).toBe(".example.test");
    expect(parsed.read.cookies[0]?.url).toBe("https://example.test/");
  });

  it("rejects unrelated files and counts malformed cookie rows", () => {
    expect(() => parseChromeSessionSnapshot('{"cookies":[]}', 1_000_000)).toThrow(
      "Invalid Chrome session snapshot",
    );
    const parsed = parseChromeSessionSnapshot(
      snapshot([{ ...cookie, domain: "https://bad/path" }, null]),
      1_000_000,
    );
    expect(parsed.read.cookies).toEqual([]);
    expect(parsed.read.undecryptable).toBe(2);
  });
});
