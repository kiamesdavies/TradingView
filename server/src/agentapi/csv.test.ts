import { expect, test } from "bun:test";
import { csvCell, toCsv } from "./csv";

test("csv quoting, nulls, formula neutralisation", () => {
  expect(csvCell(null)).toBe("");
  expect(csvCell(-1.5)).toBe("-1.5");
  expect(csvCell(Number.NaN)).toBe("");
  expect(csvCell('Mid Inc, "The"')).toBe('"Mid Inc, ""The"""');
  expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
  expect(csvCell("-x")).toBe("'-x");
  expect(csvCell("a\nb")).toBe('"a\nb"');
  expect(toCsv(["symbol", "price"], [{ symbol: "AAPL.US", price: 230 }, { symbol: "X.US", price: null }]))
    .toBe("symbol,price\r\nAAPL.US,230\r\nX.US,\r\n");
});
