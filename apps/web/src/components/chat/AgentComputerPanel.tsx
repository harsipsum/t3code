import type { OrchestrationV2AgentComputer } from "@t3tools/contracts";
import { ExternalLinkIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

/** A connector supplies a viewer URL, never a provider login token. */
export function AgentComputerPanel(props: {
  computer: OrchestrationV2AgentComputer | null;
  visible: boolean;
}) {
  const [openedUrl, setOpenedUrl] = useState<string | null>(null);
  const computer = props.computer;
  let viewerUrl: string | null = null;
  try {
    const url = new URL(computer?.url ?? "");
    const supportedProtocol =
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    if (
      supportedProtocol &&
      !url.username &&
      !url.password &&
      url.origin !== window.location.origin
    ) {
      viewerUrl = url.href;
    }
  } catch {
    // An unavailable or malformed URL is a display state.
  }
  const title = computer?.title ?? "Agent computer";
  const canView = computer?.state === "live" && viewerUrl !== null;
  const viewing = canView && props.visible && openedUrl === viewerUrl;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title}>
      {viewing && viewerUrl ? (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="truncate text-xs text-secondary-label">{title}</span>
            <Button size="sm" variant="ghost" onClick={() => setOpenedUrl(null)}>
              Disconnect view
            </Button>
          </div>
          <iframe
            key={viewerUrl}
            src={viewerUrl}
            title={title}
            sandbox="allow-scripts allow-forms allow-pointer-lock"
            referrerPolicy="no-referrer"
            allow="fullscreen"
            className="min-h-0 w-full flex-1 border-0"
          />
          <p className="px-3 py-2 text-xs text-secondary-label">
            If the provider blocks embedding, open its viewer in a new tab.
            <a
              href={viewerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 underline"
            >
              Open viewer <ExternalLinkIcon aria-hidden className="inline size-3" />
            </a>
          </p>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <MonitorIcon aria-hidden className="size-7 text-secondary-label" />
          <h3 className="text-sm font-medium">{title}</h3>
          <p role="status" className="max-w-sm text-sm text-secondary-label">
            {computer?.message ??
              (computer?.state === "asleep"
                ? "This computer is asleep. Open its app to wake it."
                : computer?.state === "connecting"
                  ? "The provider is connecting its computer."
                  : computer?.state === "error"
                    ? "The provider could not connect its computer."
                    : canView
                      ? "Open the provider's computer when you're ready."
                      : "This agent has not shared a computer viewer.")}
          </p>
          {canView ? (
            <Button size="sm" variant="outline" onClick={() => setOpenedUrl(viewerUrl)}>
              View computer
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
