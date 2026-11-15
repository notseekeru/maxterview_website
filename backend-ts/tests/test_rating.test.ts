import { describe, expect, it } from "vitest";
import { accuracy, grade, MOVE_CLASSES, MOVE_POINTS } from "../src/rating.ts";

describe("rating", () => {
    it("accuracy averages the stored classes and ignores unknown ones", () => {
        expect(accuracy([])).toBeNull();
        expect(accuracy(["brilliant", "brilliant"])).toBe(100);
        expect(accuracy(["good", "inaccuracy"])).toBe(73);
        expect(accuracy(["nonsense"])).toBeNull();
    });

    it("grade bands are the documented ladder", () => {
        const bounds = [95, 90, 89, 80, 79, 70, 69, 60, 59, 50, 49];
        expect(bounds.map((acc) => grade(acc))).toEqual(["S", "S", "A", "A", "B", "B", "C", "C", "D", "D", "F"]);
        expect(grade(null)).toBeNull();
    });

    it("class order matches its point values", () => {
        const points = MOVE_CLASSES.map((cls) => MOVE_POINTS[cls]);
        expect(points).toEqual([...points].sort((a, b) => b - a));
        expect(MOVE_POINTS.blunder).toBe(0);
    });
});
