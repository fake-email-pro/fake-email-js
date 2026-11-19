import { describe, expect, it } from "vitest";
import { parseContentDispositionFileName as parse } from "../src/resources/messages.js";

describe("Content-Disposition file name", () => {
  it.each([
    ["RFC 5987 UTF-8 wins over the ASCII fallback", `attachment; filename="invoice_.pdf"; filename*=UTF-8''%D1%81%D1%87%D1%91%D1%82.pdf`, "счёт.pdf"],
    ["filename* first", `attachment; filename*=UTF-8''a%20b.txt; filename="a b.txt"`, "a b.txt"],
    ["charset is case-insensitive, language tag allowed", `attachment; filename*=utf-8'en'na%C3%AFve.txt`, "naïve.txt"],
    ["ISO-8859-1", `attachment; filename*=ISO-8859-1''caf%E9.txt`, "café.txt"],
    ["quoted plain", `attachment; filename="invoice.pdf"`, "invoice.pdf"],
    ["quoted with escapes and ;", `attachment; filename="a \\"b\\"; c.pdf"`, `a "b"; c.pdf`],
    ["token", `attachment; filename=report.csv`, "report.csv"],
    ["case-insensitive names", `Attachment; FileName="X.PDF"`, "X.PDF"],
    ["no name: the server's attachment id", `attachment; filename="9a7e2c44-0d0b-4f7a-a1c1-2b9d5f3e6a10"`, "9a7e2c44-0d0b-4f7a-a1c1-2b9d5f3e6a10"],
    ["malformed filename* falls back", `attachment; filename="ok.txt"; filename*=UTF-8''%E2%82`, "ok.txt"],
    ["unknown charset falls back", `attachment; filename="ok.txt"; filename*=KOI8-R''%C1`, "ok.txt"],
  ])("%s", (_, header, expected) => {
    expect(parse(header)).toBe(expected);
  });

  it("returns null without a header or a name", () => {
    expect(parse(null)).toBeNull();
    expect(parse("attachment")).toBeNull();
    expect(parse(`attachment; filename=""`)).toBeNull();
  });
});
