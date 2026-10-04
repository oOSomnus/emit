import { describe, expect, it } from "vitest";
import { generateEmployeeAvatar } from "../src/web/avatar.ts";

describe("generateEmployeeAvatar", () => {
  it("returns identical cells and palette for the same seed", () => {
    const first = generateEmployeeAvatar("emp_avatar_ada");
    const repeated = generateEmployeeAvatar("emp_avatar_ada");

    expect(repeated.cells).toEqual(first.cells);
    expect(repeated.palette).toBe(first.palette);
  });

  it("produces different cell patterns for distinct fixed employee IDs", () => {
    const ada = generateEmployeeAvatar("emp_avatar_ada");
    const bea = generateEmployeeAvatar("emp_avatar_bea");

    expect(ada.cells).not.toEqual(bea.cells);
  });

  it("keeps every generated cell within the 5-by-5 grid", () => {
    const { cells } = generateEmployeeAvatar("emp_avatar_bounds");

    for (const cell of cells) {
      expect(Number.isInteger(cell.x)).toBe(true);
      expect(Number.isInteger(cell.y)).toBe(true);
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(5);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(5);
      expect([0, 1]).toContain(cell.tone);
    }
  });

  it("mirrors each cell across the vertical center line with the same tone", () => {
    const { cells } = generateEmployeeAvatar("emp_avatar_mirror");
    const tones = new Map(cells.map(({ x, y, tone }) => [`${x},${y}`, tone]));

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        expect(tones.get(`${x},${y}`)).toBe(tones.get(`${4 - x},${y}`));
      }
    }
  });

  it("always contains at least one filled cell", () => {
    const { cells } = generateEmployeeAvatar("emp_avatar_nonempty");

    expect(cells.length).toBeGreaterThan(0);
  });

  it("keeps an employee's avatar unchanged when only the display name changes", () => {
    const employee = { id: "emp_stable_identity", name: "Ada" };
    const beforeRename = generateEmployeeAvatar(employee.id);
    employee.name = "Augusta Lovelace";
    const afterRename = generateEmployeeAvatar(employee.id);

    expect(afterRename).toEqual(beforeRename);
  });
});
