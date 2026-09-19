import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { apiDetail, createInterview, createTemplate, deleteTemplate, type InterviewDials, type InterviewTemplate, isQuotaError, listResumes, listTemplates, type ResumeSummary, type TemplateInput, updateTemplate } from "@/lib/api";
import { COMPANY_SIZES, CYNICISM, companySizeLabel, DIAL_FIELDS, LEVELS, MIX_FIELDS, MIX_MAX, mixCountLabel, ROLE_PRESETS } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
import { RowMenu } from "./RowMenu";
import { UpgradeNotice } from "./UsageBadge";

const LAST_TEMPLATE_KEY = "maxterview:last-template";

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
    // null = still loading or the fetch failed; the preset row hides either way.
    const [templates, setTemplates] = useState<InterviewTemplate[] | null>(null);
    // Same contract as templates: absent/empty hides the row rather than showing an empty picker.
    const [resumes, setResumes] = useState<ResumeSummary[]>([]);
    // null = no resume attached. This is the create-form's bool: it always names WHICH resume, because
    // an owner with two CVs asking for "my resume" is a question the server cannot answer.
    const [resumeId, setResumeId] = useState<string | null>(null);
    const [lastUsedId, setLastUsedId] = useState<string | null>(() => localStorage.getItem(LAST_TEMPLATE_KEY));
    const [editor, setEditor] = useState<{ mode: "save" } | { mode: "rename"; id: string } | null>(null);
    const [templateName, setTemplateName] = useState("");
    // Preset list is long enough to bury the input below it on a phone.
    const [showAllRoles, setShowAllRoles] = useState(false);
    const [templateBusy, setTemplateBusy] = useState(false);
    const [templateError, setTemplateError] = useState<string | null>(null);

    useEffect(() => {
        listTemplates()
            .then(setTemplates)
            .catch(() => setTemplates(null));
    }, []);

    useEffect(() => {
        listResumes()
            .then(setResumes)
            .catch(() => setResumes([]));
    }, []);

    // The form's dials in API shape, shared by the create and preset bodies.
    function dialsFromForm(): InterviewDials {
        return {
            company_size: COMPANY_SIZES[companySize].value,
            cynicism: CYNICISM[cynicism].value,
            brutally_honest: brutallyHonest,
            human_mode: humanMode,
            hardcore,
            ...mix,
        };
    }

    function fieldsFromForm() {
        return { role: role.trim(), topic: topic.trim(), level, resume_id: resumeId, ...dialsFromForm() };
    }

    /** Template as a PUT body. Spelled out, not spread: a new dial then breaks this line at compile time. */
    function bodyFrom(t: InterviewTemplate, patch: Partial<TemplateInput> = {}): TemplateInput {
        return {
            name: t.name,
            role: t.role,
            topic: t.topic ?? "",
            level: t.level,
            resume_id: t.resume_id ?? null,
            company_size: t.company_size,
            cynicism: t.cynicism,
            brutally_honest: t.brutally_honest,
            human_mode: t.human_mode,
            hardcore: t.hardcore,
            mix_chitchat: t.mix_chitchat,
            mix_behavioural: t.mix_behavioural,
            mix_technical: t.mix_technical,
            ...patch,
        };
    }

    function isApplied(t: InterviewTemplate): boolean {
        const dials = dialsFromForm();
        return t.role === role.trim() && (t.topic ?? "") === topic.trim() && t.level === level && (t.resume_id ?? null) === resumeId && DIAL_FIELDS.every((field) => t[field] === dials[field]);
    }

    function remember(id: string | null) {
        setLastUsedId(id);
        if (id) localStorage.setItem(LAST_TEMPLATE_KEY, id);
        else localStorage.removeItem(LAST_TEMPLATE_KEY);
    }

    function applyTemplate(t: InterviewTemplate) {
        setRole(t.role);
        setLevel(t.level);
        setTopic(t.topic ?? "");
        setResumeId(t.resume_id ?? null);
        setCompanySize(
            Math.max(
                0,
                COMPANY_SIZES.findIndex((c) => c.value === t.company_size),
            ),
        );
        setCynicism(
            Math.max(
                0,
                CYNICISM.findIndex((c) => c.value === t.cynicism),
            ),
        );
        setBrutallyHonest(t.brutally_honest);
        setHumanMode(t.human_mode);
        setHardcore(t.hardcore);
        setMix({ mix_chitchat: t.mix_chitchat, mix_behavioural: t.mix_behavioural, mix_technical: t.mix_technical });
        remember(t.id);
        setError(null);
        setEditor(null);
        setTemplateError(null);
    }

    async function submitTemplate() {
        const name = templateName.trim();
        if (!name) return;
        const renaming = editor?.mode === "rename" ? templates?.find((t) => t.id === editor.id) : undefined;
        setTemplateBusy(true);
        try {
            const ok = renaming ? await putTemplate(renaming, { name }) : await createPreset(name);
            if (ok) setEditor(null);
        } finally {
            setTemplateBusy(false);
        }
    }

    /** POST the form as a named preset; false = failed. */
    async function createPreset(name: string): Promise<boolean> {
        setTemplateError(null);
        try {
            const saved = await createTemplate({ name, ...fieldsFromForm() });
            setTemplates((list) => [saved, ...(list ?? [])]);
            return true;
        } catch (e) {
            setTemplateError(apiDetail(e, "Could not save the preset."));
            return false;
        }
    }

    async function putTemplate(t: InterviewTemplate, patch: Partial<TemplateInput>): Promise<boolean> {
        setTemplateError(null);
        try {
            const saved = await updateTemplate(t.id, bodyFrom(t, patch));
            setTemplates((list) => (list ?? []).map((x) => (x.id === saved.id ? saved : x)));
            return true;
        } catch (e) {
            setTemplateError(apiDetail(e, "Could not update the preset."));
            return false;
        }
    }

    async function removeTemplate(t: InterviewTemplate) {
        if (!confirm(`Delete preset "${t.name}"?`)) return;
        try {
            await deleteTemplate(t.id);
            setTemplates((list) => (list ?? []).filter((x) => x.id !== t.id));
            if (lastUsedId === t.id) remember(null);
        } catch (e) {
            setTemplateError(apiDetail(e, "Could not delete the preset."));
        }
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!role.trim()) {
            setError("Role is required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const interview = await createInterview(fieldsFromForm());
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
                </CardHeader>
                <CardContent className={featured ? "grid gap-x-4 gap-y-4 sm:grid-cols-2" : "space-y-4"}>
                    {templates && (
                        <div className={cn("space-y-1.5", featured && "sm:col-span-2")}>
                            <span className="text-sm font-medium leading-none">Presets</span>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {templates.map((t) => {
                                    const applied = isApplied(t);
                                    return (
                                        <div key={t.id} className={cn("flex items-center rounded-full border text-xs transition-colors", applied ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-accent", !applied && t.id === lastUsedId && "border-dashed")}>
                                            <button type="button" onClick={() => applyTemplate(t)} className={cn("py-1 pl-2.5 pr-0.5", applied && "font-medium")}>
                                                {t.name}
                                            </button>
                                            <RowMenu
                                                label={`${t.name} options`}
                                                items={[
                                                    {
                                                        label: "Rename",
                                                        onSelect: () => {
                                                            setTemplateName(t.name);
                                                            setEditor({ mode: "rename", id: t.id });
                                                        },
                                                    },
                                                    { label: "Update from dials", onSelect: () => void putTemplate(t, fieldsFromForm()) },
                                                    { label: "Delete", onSelect: () => void removeTemplate(t), destructive: true },
                                                ]}
                                            />
                                        </div>
                                    );
                                })}
                                {editor ? (
                                    <div className="flex items-center gap-1">
                                        <Input
                                            autoFocus
                                            value={templateName}
                                            onChange={(e) => setTemplateName(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    void submitTemplate();
                                                }
                                            }}
                                            placeholder="Preset name"
                                            maxLength={60}
                                            className="h-7 w-36 text-xs"
                                        />
                                        <Button type="button" size="sm" variant="secondary" disabled={templateBusy || !templateName.trim()} onClick={() => void submitTemplate()}>
                                            {templateBusy ? "Saving..." : editor.mode === "save" ? "Save" : "Rename"}
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setEditor(null);
                                                setTemplateError(null);
                                            }}
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setTemplateName("");
                                            setTemplateError(null);
                                            setEditor({ mode: "save" });
                                        }}
                                        className="rounded-full border border-dashed border-input px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
                                    >
                                        + Save current
                                    </button>
                                )}
                            </div>
                            {templateError && <p className="text-xs text-destructive">{templateError}</p>}
                        </div>
                    )}

                    {/* Hidden entirely with no resumes: an empty picker is noise when the answer is
                        "none". Import one on the Resume page and this row appears. */}
                    {resumes.length > 0 && (
                        <div className={cn("space-y-1.5", featured && "sm:col-span-2")}>
                            <span className="text-sm font-medium leading-none">Resume</span>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {/* "None" is a chip, not the absence of one: the picker has to read as a
                                    choice you can undo, like every other row here. */}
                                <button type="button" onClick={() => setResumeId(null)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", resumeId === null ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}>
                                    None
                                </button>
                                {resumes.map((r) => (
                                    <button key={r.id} type="button" onClick={() => setResumeId(r.id)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", resumeId === r.id ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}>
                                        {r.name}
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">The interviewer asks about what it claims, and the reviewer holds you to it.</p>
                        </div>
                    )}

                    <div className={cn("space-y-1.5", featured && "sm:col-span-2")}>
                        <Label htmlFor="role">Role</Label>
                        <div className="flex flex-wrap gap-1.5">
                            {(showAllRoles ? ROLE_PRESETS : ROLE_PRESETS.slice(0, 8)).map((preset) => (
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
                            {ROLE_PRESETS.length > 9 && (
                                <button type="button" onClick={() => setShowAllRoles((v) => !v)} aria-expanded={showAllRoles} className="rounded-full border border-dashed border-input px-3 py-1 text-xs text-muted-foreground hover:bg-accent">
                                    {showAllRoles ? "Show fewer" : `+${ROLE_PRESETS.length - 9} more`}
                                </button>
                            )}
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
