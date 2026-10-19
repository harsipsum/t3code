import { assert, describe, it } from "@effect/vitest";

import { makeSseDecoder } from "./sse.ts";

describe("makeSseDecoder", () => {
  it("joins frames split across chunks and keeps the event id", () => {
    const decode = makeSseDecoder();
    assert.deepEqual(decode("event: client_ev"), []);
    assert.deepEqual(decode('ent\r\nid: 41\r\ndata: {"a":'), []);
    assert.deepEqual(decode("1}\r\n\r\n: keepalive\n\n"), [
      { event: "client_event", id: "41", data: '{"a":1}' },
    ]);
  });

  it("joins multi-line data and defaults the event name", () => {
    const decode = makeSseDecoder();
    assert.deepEqual(decode("data: one\ndata: two\n\n"), [
      { event: "message", id: undefined, data: "one\ntwo" },
    ]);
  });
});
