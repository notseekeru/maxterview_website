export const MOVE_CLASSES = ["brilliant", "great", "good", "book", "inaccuracy", "mistake", "blunder"] as const;

export type MoveClass = (typeof MOVE_CLASSES)[number];

// Hardcore fails the run on any of these: wrong (mistake), nothing usable (blunder) and vague
// (inaccuracy). `book` and above survive: correct-but-recited is a small deduction, not a failure.
export const FAIL_CLASSES = ["inaccuracy", "mistake", "blunder"] as const;

// What one classed turn is worth out of 1.0: `book` sits just under `good`.
export const MOVE_POINTS: Record<MoveClass, number> = {
    brilliant: 1.0,
    great: 1.0,
    good: 0.85,
    book: 0.8,
    inaccuracy: 0.6,
    mistake: 0.35,
    blunder: 0.0,
};

export const GRADES = ["S", "A", "B", "C", "D", "F"] as const;

export type Grade = (typeof GRADES)[number];

export const GRADE_BANDS: readonly (readonly [number, Grade])[] = [
    [90, "S"],
    [80, "A"],
    [70, "B"],
    [60, "C"],
    [50, "D"],
];

// STUB_MODE only (no LLM configured: dev/seed/tests). Cycled over the transcript so a model-free run
// still exercises the review UI. Opens on `good` so a one-answer smoke run does not read S or F.
export const STUB_MOVE_CYCLE = ["good", "inaccuracy", "great", "book", "mistake"] as const;

// Canned per class: a model-free run must render the note without spending a model call, and canned text
// never claims to have read the answer.
export const STUB_MOVE_NOTES: Record<MoveClass, string> = {
    brilliant: "No notes: this one went past what was asked. Repeat it by naming the trade-off and the number that backed it.",
    great: "A real example with your own decisions in it, which is the bar. Add what you would do differently now.",
    good: "Correct and complete, which is the job. One number or one outcome would make it stick.",
    book: "Correct but recited: no sign you have done it. Next time, answer with the time you actually shipped it.",
    inaccuracy: "Right direction, no evidence: name the situation you were in and the call you made.",
    mistake: "This answered something other than the question. Restate the question in your first line, then answer it.",
    blunder: 'Nothing usable landed. Even "I have not done that; here is how I would find out" scores above this.',
};

export function accuracy(classes: Iterable<string>): number | null {
    const graded = [...classes].flatMap((cls) => (cls in MOVE_POINTS ? [MOVE_POINTS[cls as MoveClass]] : []));
    if (graded.length === 0) return null;
    // Half-up, matching Python's int(100 * mean + 0.5); Math.round flips .5 on digit parity.
    return Math.floor((100 * graded.reduce((sum, points) => sum + points, 0)) / graded.length + 0.5);
}

export function grade(acc: number | null, failed = false): Grade | null {
    if (failed) return "F";
    if (acc === null) return null;
    return GRADE_BANDS.find(([floor]) => acc >= floor)?.[1] ?? "F";
}

// AI HERE: the framework-free self-check rating.py ran at import, kept in one place. A class without a
// point value, or bands that stop matching GRADES, would silently drop turns out of the average.
if (MOVE_CLASSES.some((cls) => !(cls in MOVE_POINTS)) || GRADE_BANDS.map(([, band]) => band).join("") !== GRADES.slice(0, GRADE_BANDS.length).join("")) {
    throw new Error("rating: vocabulary and grade bands drifted");
}
if (accuracy([]) !== null || accuracy(["brilliant"]) !== 100 || accuracy(["blunder"]) !== 0 || grade(null) !== null || grade(89) !== "A" || grade(0, true) !== "F") {
    throw new Error("rating: accuracy or band lookup is wrong");
}
