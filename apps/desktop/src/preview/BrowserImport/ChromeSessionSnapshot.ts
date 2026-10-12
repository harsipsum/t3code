import type { CookieReadResult, ImportedCookie } from "./CookieDatabase.ts";

export interface ChromeSessionSnapshot {
  readonly capturedAt: string;
  readonly profileName: string;
  readonly domains: ReadonlyArray<string>;
  readonly read: CookieReadResult;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads only the extension's explicit export, never Chrome's encrypted database. */
export function parseChromeSessionSnapshot(text: string, now: number): ChromeSessionSnapshot {
  if (text.length > 20_000_000) throw new Error("Chrome session snapshot is too large.");
  const source: unknown = JSON.parse(text);
  if (
    !record(source) ||
    source.version !== 1 ||
    source.browser !== "chrome" ||
    typeof source.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(source.capturedAt)) ||
    !Array.isArray(source.cookies) ||
    source.cookies.length > 30_000
  ) {
    throw new Error("Invalid Chrome session snapshot.");
  }

  const cookies: ImportedCookie[] = [];
  let skipped = 0;
  const skippedHosts = new Set<string>();
  const domains = new Set<string>();
  for (const item of source.cookies) {
    const host = record(item) && typeof item.domain === "string" ? item.domain : "unknown";
    // Electron's cookie API cannot retain a Chrome partition key. Importing it
    // as an ordinary cookie would change which site can use it, so report it skipped.
    if (
      !record(item) ||
      typeof item.name !== "string" ||
      typeof item.value !== "string" ||
      typeof item.domain !== "string" ||
      !/^\.?[a-zA-Z0-9_:[\].-]+$/.test(item.domain) ||
      typeof item.path !== "string" ||
      !item.path.startsWith("/") ||
      typeof item.secure !== "boolean" ||
      typeof item.httpOnly !== "boolean" ||
      typeof item.hostOnly !== "boolean" ||
      item.partitionKey !== undefined ||
      (item.expirationDate !== undefined &&
        (typeof item.expirationDate !== "number" ||
          !Number.isFinite(item.expirationDate) ||
          item.expirationDate <= now / 1_000))
    ) {
      skipped++;
      skippedHosts.add(host);
      continue;
    }
    const bareHost = item.domain.replace(/^\./, "");
    const authority =
      bareHost.includes(":") && !bareHost.startsWith("[") ? `[${bareHost}]` : bareHost;
    domains.add(bareHost);
    cookies.push({
      url: `${item.secure ? "https" : "http"}://${authority}${item.path}`,
      name: item.name,
      value: item.value,
      domain: item.hostOnly ? undefined : item.domain,
      path: item.path,
      secure: item.secure,
      httpOnly: item.httpOnly,
      expirationDate: typeof item.expirationDate === "number" ? item.expirationDate : undefined,
      sameSite:
        item.sameSite === "no_restriction" || item.sameSite === "strict" || item.sameSite === "lax"
          ? item.sameSite
          : "unspecified",
    });
  }
  return {
    capturedAt: source.capturedAt,
    profileName:
      typeof source.profileName === "string" && source.profileName.trim()
        ? source.profileName.slice(0, 120)
        : "Chrome extension snapshot",
    domains: [...domains].slice(0, 20),
    read: { cookies, undecryptable: skipped, undecryptableHosts: [...skippedHosts].slice(0, 20) },
  };
}
