import type { Grade, MoveClass } from "@/lib/api";

export const MOVE_CLASSES: { value: MoveClass; label: string; glyph: string; hint: string; tone: string }[] = [
    {
        value: "brilliant",
        label: "Brilliant",
        glyph: "★",
        hint: "Went beyond the question: an insight, a trade-off nobody asked for, or a number that proves it.",
        tone: "border-transparent bg-primary text-primary-foreground",
    },
    {
        value: "great",
        label: "Great",
        glyph: "!",
        hint: "Strong and specific: a real example with your own decisions visible in it.",
        tone: "border-primary/50 bg-primary/10",
    },
    {
        value: "good",
        label: "Good",
        glyph: "✓",
        hint: "Solid and correct: the answer the question was asking for.",
        tone: "border-border bg-muted",
    },
    {
        value: "book",
        label: "Book",
        glyph: "▤",
        hint: "Correct but recited: textbook or definition only, with no first-hand detail.",
        tone: "border-dashed border-border text-muted-foreground",
    },
    {
        value: "inaccuracy",
        label: "Inaccuracy",
        glyph: "?!",
        hint: "Vague or partial: it gestures at an answer without evidence, or misses part of the question.",
        tone: "border-border text-muted-foreground",
    },
    {
        value: "mistake",
        label: "Mistake",
        glyph: "?",
        hint: "Wrong or evasive: contradicts itself, answers a different question, or has no substance.",
        tone: "border-destructive/60 bg-destructive/10",
    },
    {
        value: "blunder",
        label: "Blunder",
        glyph: "??",
        hint: "Nothing usable: refused the question, or said nothing of value.",
        tone: "border-transparent bg-destructive text-destructive-foreground",
    },
];

export function moveClassMeta(value?: string | null) {
    return MOVE_CLASSES.find((m) => m.value === value) ?? null;
}

const GRADE_TONES: Record<Grade, string> = {
    S: "border-primary bg-primary/15",
    A: "border-primary/50 bg-primary/10",
    B: "border-border bg-muted",
    C: "border-border text-muted-foreground",
    D: "border-destructive/50 bg-destructive/10",
    F: "border-destructive bg-destructive/15",
};

export function gradeTone(grade?: string | null): string {
    return GRADE_TONES[grade as Grade] ?? "border-dashed border-border text-muted-foreground";
}
