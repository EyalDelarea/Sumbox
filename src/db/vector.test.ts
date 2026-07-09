import { describe, expect, it } from "vitest";
import { toVectorLiteral } from "./vector.js";

describe("toVectorLiteral", () => {
  it("formats a number array as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, -0.2, 3])).toBe("[0.1,-0.2,3]");
    expect(toVectorLiteral([])).toBe("[]");
  });
});
