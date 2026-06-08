import { describe, it, expect } from "vitest";
import { renderValue, parseValue } from "./value";

describe("renderValue", () => {
  it("marks NULL distinctly", () => {
    const r = renderValue({ t: "Null" });
    expect(r.isNull).toBe(true);
    expect(r.text).toBe("NULL");
  });

  it("renders bytes as blob summary", () => {
    const r = renderValue({ t: "Bytes", v: { len: 12, preview_hex: "00ff" } });
    expect(r.isBytes).toBe(true);
    expect(r.text).toContain("12 bytes");
  });

  it("stringifies json", () => {
    const r = renderValue({ t: "Json", v: { a: 1 } });
    expect(r.isJson).toBe(true);
    expect(r.text).toBe('{"a":1}');
  });

  it("renders empty text distinct from null", () => {
    const r = renderValue({ t: "Text", v: "" });
    expect(r.isNull).toBe(false);
    expect(r.text).toBe("");
  });
});

describe("parseValue", () => {
  it("parses int by column kind", () => {
    expect(parseValue("42", "Int")).toEqual({ t: "Int", v: 42 });
  });
  it("falls back to text", () => {
    expect(parseValue("hi", "Text")).toEqual({ t: "Text", v: "hi" });
  });
});
