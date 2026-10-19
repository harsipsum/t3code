export interface SseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** Incremental `text/event-stream` decoder; feed it decoded text in any chunking. */
export function makeSseDecoder() {
  let buffer = "";
  let event = "";
  let id: string | undefined;
  let data: Array<string> = [];

  const takeLine = (line: string, frames: Array<SseFrame>) => {
    if (line === "") {
      if (data.length > 0) frames.push({ event: event || "message", id, data: data.join("\n") });
      event = "";
      id = undefined;
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  };

  return (chunk: string): ReadonlyArray<SseFrame> => {
    buffer += chunk;
    const frames: Array<SseFrame> = [];
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      takeLine(line.endsWith("\r") ? line.slice(0, -1) : line, frames);
      newline = buffer.indexOf("\n");
    }
    return frames;
  };
}
