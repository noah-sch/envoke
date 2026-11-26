import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse.ts";

describe("SseParser", () => {
  it("returns complete events only, across chunk boundaries and CRLF", () => {
    const parser = new SseParser();
    expect(parser.push('event: text_delta\ndata: {"a":')).toEqual([]);
    expect(parser.push('1}\n\nevent: x\r\ndata: {"b":2}\r\n\r\ndata: {"c"')).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(parser.push(":3}\n\n")).toEqual(['{"c":3}']);
  });

  it("ignores comments and events without data", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\n\nevent: ping\n\n")).toEqual([]);
  });
});
