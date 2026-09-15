import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { createInterview, isQuotaError } from "@/lib/api";
import { COMPANY_SIZES, CYNICISM, companySizeLabel, LEVELS, MIX_FIELDS, MIX_MAX, mixCountLabel, ROLE_PRESETS } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
import { UpgradeNotice } from "./UsageBadge";

type Variant = "compact" | "featured";

interface Props {
    onCreated: (id: string) => void;
    variant?: Variant;
    className?: string;
}

export function CreateInterviewForm({ onCreated, variant = "compact", className }: Props) {
    // "featured" sheds the width cap and lets Role + Topic span both columns.
    const featured = variant === "featured";
    const [role, setRole] = useState("");
    const [level, setLevel] = useState("any");
    const [topic, setTopic] = useState("");
    // Dials. Index-based state, because the sliders ARE the vocabulary order (see
    // interviewOptions): moving a slider right must mean "more senior / bigger / harsher".
    const [companySize, setCompanySize] = useState(0);
    const [cynicism, setCynicism] = useState(1); // neutral
    const [brutallyHonest, setBrutallyHonest] = useState(false);
    const [humanMode, setHumanMode] = useState(true);
    const [hardcore, setHardcore] = useState(false);
    const [mix, setMix] = useState({ mix_chitchat: 0, mix_behavioural: 2, mix_technical: MIX_MAX });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [quotaLocked, setQuotaLocked] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!role.trim()) {
            setError("Role is required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const interview = await createInterview({
                role: role.trim(),
                topic: topic.trim(),
                level,
                company_size: COMPANY_SIZES[companySize].value,
                cynicism: CYNICISM[cynicism].value,
                brutally_honest: brutallyHonest,
                human_mode: humanMode,
                hardcore,
                ...mix,
            });
            onCreated(interview.id);
        } catch (e) {
            if (isQuotaError(e)) setQuotaLocked(true);
            else setError("Failed to create interview. Is the backend running?");
            setBusy(false);
        }
    }

    return (
        <Card className={cn(featured ? "w-full" : "w-full max-w-lg", className)}>
            <form onSubmit={submit}>
                <CardHeader>
                    <CardTitle>New interview</CardTitle>
                    <CardDescription>Start a simulated interview with an AI coach.</CardDescription>
                </CardHeader>
                <CardContent className={featured ? "grid gap-x-4 gap-y-4 sm:grid-cols-2" : "space-y-4"}>
                    <div className={cn("space-y-1.5", featured && "sm:col-span-2")}>
                        <Label htmlFor="role">Role</Label>
                        <div className="flex flex-wrap gap-1.5">
                            {ROLE_PRESETS.slice(0, 6).map((preset) => (
                                <button
                                    key={preset}
                                    type="button"
                                    onClick={() => {
                                        setError(null);
                                        setRole(preset);
                                    }}
                                    className={cn("rounded-full border px-3 py-1 text-xs transition-colors", role === preset ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}
                                >
                                    {preset}
                                </button>
                            ))}
                        </div>
                        <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Software Engineer — or pick a preset above" required />
                    </div>

                    <DialSlider id="level" label="Level" value={level} values={LEVELS.map((l) => l.value)} labels={LEVELS.map((l) => l.label)} onChange={setLevel} hint={level === "any" ? "AI adapts to you" : undefined} />
                    <DialSlider
                        id="company_size"
                        label="Company size"
                        value={COMPANY_SIZES[companySize].value}
                        values={COMPANY_SIZES.map((c) => c.value)}
                        labels={COMPANY_SIZES.map((c) => companySizeLabel(c.value))}
                        onChange={(v) => setCompanySize(COMPANY_SIZES.findIndex((c) => c.value === v))}
                        hint={companySize === 0 ? "scales the scenarios" : undefined}
                    />
                    <DialSlider id="cynicism" label="Cynicism" value={CYNICISM[cynicism].value} values={CYNICISM.map((c) => c.value)} labels={CYNICISM.map((c) => c.label)} onChange={(v) => setCynicism(CYNICISM.findIndex((c) => c.value === v))} hint={CYNICISM[cynicism].hint} />
                    <div className="space-y-1.5">
                        <Label htmlFor="topic">Topic (optional)</Label>
                        <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. system design" />
                    </div>

                    {/* Question budgets, folded away: they matter when you want them and are noise
                        when you don't, and the defaults already match the standard arc. */}
                    <details open={featured} className={cn("rounded-md border px-3 py-2", featured && "sm:col-span-2")}>
                        <summary className="cursor-pointer text-sm font-medium">Question mix</summary>
                        <p className="mt-1 text-xs text-muted-foreground">How many questions of each kind. The interviewer closes the interview once every budget is spent.</p>
                        <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-3">
                            {MIX_FIELDS.map((f) => (
                                <DialSlider
                                    key={f.field}
                                    id={f.field}
                                    label={f.label}
                                    value={String(mix[f.field])}
                                    values={Array.from({ length: MIX_MAX + 1 }, (_, n) => String(n))}
                                    labels={Array.from({ length: MIX_MAX + 1 }, (_, n) => mixCountLabel(n))}
                                    onChange={(v) => setMix((m) => ({ ...m, [f.field]: Number(v) }))}
                                    hint={f.hint}
                                    numbered
                                />
                            ))}
                        </div>
                    </details>

                    <div className={cn("flex flex-wrap gap-x-6 gap-y-2", featured && "sm:col-span-2")}>
                        <Toggle id="brutally_honest" checked={brutallyHonest} onChange={setBrutallyHonest} label="Brutally honest" hint="names weaknesses as they happen, and leads the feedback with them" />
                        <Toggle id="hardcore" checked={hardcore} onChange={setHardcore} label="Hardcore" hint="one wrong answer ends the run on the spot, and the feedback is a shouting match" />
                        <Toggle id="human_mode" checked={humanMode} onChange={setHumanMode} label="Human mode" hint="contractions and plain words, no AI or corporate phrasing" />
                    </div>

                    {(error || quotaLocked) && (
                        <div className={cn("space-y-2", featured && "sm:col-span-2")}>
                            {error && <p className="text-sm text-destructive">{error}</p>}
                            {quotaLocked && <UpgradeNotice reason="your free daily interview quota ran out." />}
                        </div>
                    )}
                </CardContent>
                <CardFooter>
                    <Button type="submit" disabled={busy}>
                        {busy ? "Creating..." : "Start interview"}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}

/** One discrete dial: current choice named in the label, ends named under the track. */
function DialSlider({ id, label, value, values, labels, onChange, hint, numbered }: { id: string; label: string; value: string; values: string[]; labels: string[]; onChange: (value: string) => void; hint?: string; numbered?: boolean }) {
    const index = Math.max(0, values.indexOf(value));
    return (
        <div className="space-y-1">
            <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-1.5">
                {label}
                <span className="text-xs font-normal text-foreground">{labels[index]}</span>
                {hint && <span className="text-xs font-normal text-muted-foreground">· {hint}</span>}
            </Label>
            <Slider id={id} name={id} min={0} max={values.length - 1} step={1} value={index} aria-valuetext={labels[index]} onChange={(e) => onChange(values[Number(e.target.value)])} />
            <div className="flex justify-between text-[10px] leading-none text-muted-foreground" aria-hidden>
                <span>{numbered ? "off" : labels[0]}</span>
                <span>{labels[labels.length - 1]}</span>
            </div>
        </div>
    );
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
    return (
        <label htmlFor={id} className="flex max-w-sm cursor-pointer items-start gap-2 text-sm">
            <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
            <span>
                {label}
                <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
        </label>
    );
}
