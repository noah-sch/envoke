import { describe, expect, it } from "vitest";
import { groupByDate } from "../src/dates.ts";

describe("groupByDate", () => {
  it("sorts into sidebar groups, newest first, skipping empty groups", () => {
    const now = new Date(2026, 10, 25, 15, 0);
    const at = (d: number, h = 10) => ({
      updatedAt: new Date(2026, 10, d, h).toISOString(),
      id: `${d}-${h}`,
    });
    const groups = groupByDate([at(25, 9), at(24), at(25, 14), at(20), at(1), at(2, 1)], now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Aujourd'hui", ["25-14", "25-9"]],
      ["Hier", ["24-10"]],
      ["7 derniers jours", ["20-10"]],
      ["30 derniers jours", ["2-1", "1-10"]],
    ]);
  });
});
