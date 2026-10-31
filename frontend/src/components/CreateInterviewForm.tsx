import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { apiDetail, createInterview, createTemplate, type Depth, deleteTemplate, type InterviewDials, type InterviewTemplate, listResumes, listTemplates, type ResumeSummary, type TemplateInput, updateTemplate } from "@/lib/api";
import { COMPANY_SIZES, CYNICISM, companySizeLabel, DEPTHS, DIAL_FIELDS, LEVELS, planBar, planSegments, planSummary, planTotals, ROLE_PRESETS } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
import { Icon } from "./AppIcons";
import { LABEL } from "./PagePrimitives";
import { RowMenu } from "./RowMenu";

const LAST_TEMPLATE_KEY = "maxterview:last-template";
const VISIBLE_ROLES = 8;

interface Props {
    onCreated: (id: string) => void;
}

function chipClass(on: boolean): string {
    return cn("h-8 rounded-md border px-2.5 text-xs transition-colors", on ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function CreateInterviewForm({ onCreated }: Props) {
    const [role, setRole] = useState("");
    const [level, setLevel] = useState("any");
    const [topic, setTopic] = useState("");
    const [companySize, setCompanySize] = useState(0);
    const [cynicism, setCynicism] = useState(1);
    const [brutallyHonest, setBrutallyHonest] = useState(false);
    const [humanMode, setHumanMode] = useState(true);
    const [hardcore, setHardcore] = useState(false);
    const [depth, setDepth] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [templates, setTemplates] = useState<InterviewTemplate[] | null>(null);
    const [resumes, setResumes] = useState<ResumeSummary[]>([]);
    const [resumeId, setResumeId] = useState<string | null>(null);
    const [lastUsedId, setLastUsedId] = useState<string | null>(() => localStorage.getItem(LAST_TEMPLATE_KEY));
    const [editor, setEditor] = useState<{ mode: "save" } | { mode: "rename"; id: string } | null>(null);
    const [templateName, setTemplateName] = useState("");
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

    function dialsFromForm(): InterviewDials {
        return {
            company_size: COMPANY_SIZES[companySize].value,
            cynicism: CYNICISM[cynicism].value,
            brutally_honest: brutallyHonest,
            human_mode: humanMode,
            hardcore,
            depth: DEPTHS[depth].value,
        };
    }

    function fieldsFromForm() {
        return { role: role.trim(), topic: topic.trim(), level, resume_id: resumeId, ...dialsFromForm() };
    }

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
            depth: t.depth,
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
        setDepth(
            Math.max(
                0,
                DEPTHS.findIndex((d) => d.value === t.depth),
            ),
        );
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

    async function createPreset(name: string): Promise<boolean> {
        if (!role.trim()) {
            setTemplateError("Pick a role or type one first: a preset has to be replayable.");
            return false;
        }
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
        } catch {
            setError("Failed to create interview. Is the backend running?");
            setBusy(false);
        }
    }

    const hiddenRoles = ROLE_PRESETS.length - VISIBLE_ROLES;
    const totals = planTotals(DEPTHS[depth].value);
    const summary = `${totals.questions} questions · ${totals.turns} turns · ${DEPTHS[depth].minutes} min`;

    return (
        <Card className="relative w-full overflow-hidden">
            <div aria-hidden className="dotgrid pointer-events-none absolute inset-x-0 top-0 h-80 opacity-50 [mask-image:radial-gradient(75%_100%_at_50%_0%,#000_10%,transparent_80%)]" />
            <form onSubmit={submit} className="relative">
                <div className="space-y-7 px-5 py-6 sm:px-8 sm:py-8">
                    {templates && (
                        <section className="space-y-2.5">
                            <p className={LABEL}>Start from</p>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {templates.map((t) => {
                                    const applied = t.id === lastUsedId && isApplied(t);
                                    return (
                                        <div
                                            key={t.id}
                                            className={cn("flex h-8 items-center rounded-md border text-xs transition-colors", applied ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-accent hover:text-foreground", !applied && t.id === lastUsedId && "border-dashed")}
                                        >
                                            <button type="button" onClick={() => applyTemplate(t)} className={cn("py-1 pl-2.5 pr-0.5", applied && "font-medium")}>
                                                {t.name}
                                            </button>
                                            <RowMenu
                                                compact
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
                                            className="h-8 w-36 rounded-md text-xs"
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
                                        className="h-8 rounded-md border border-dashed border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                    >
                                        + Save current
                                    </button>
                                )}
                            </div>
                            {templateError && <p className="text-xs text-destructive">{templateError}</p>}
                        </section>
                    )}

                    <section className="space-y-4">
                        <label htmlFor="role" className={LABEL}>
                            Who are you interviewing for?
                        </label>
                        <input
                            id="role"
                            value={role}
                            onChange={(e) => {
                                setError(null);
                                setRole(e.target.value);
                            }}
                            maxLength={200}
                            required
                            autoComplete="off"
                            placeholder="Software Engineer"
                            className="w-full min-w-0 border-b border-input bg-transparent pb-2 font-serif text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.05] tracking-[-0.03em] caret-primary outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
                        />
                        <div className="flex flex-wrap gap-1.5">
                            {(showAllRoles ? ROLE_PRESETS : ROLE_PRESETS.slice(0, VISIBLE_ROLES)).map((preset) => (
                                <button
                                    key={preset}
                                    type="button"
                                    aria-pressed={role === preset}
                                    onClick={() => {
                                        setError(null);
                                        setRole(preset);
                                    }}
                                    className={chipClass(role === preset)}
                                >
                                    {preset}
                                </button>
                            ))}
                            {hiddenRoles > 0 && (
                                <button type="button" onClick={() => setShowAllRoles((v) => !v)} aria-expanded={showAllRoles} className="h-8 rounded-md border border-dashed border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                                    {showAllRoles ? "Show fewer" : `+${hiddenRoles} more`}
                                </button>
                            )}
                        </div>
                    </section>

                    <div className="grid gap-6 sm:grid-cols-[1.4fr_1fr]">
                        <section className="space-y-2.5">
                            <p className={LABEL}>Level</p>
                            <div className="flex flex-wrap gap-1.5">
                                {LEVELS.map((l) => (
                                    <button key={l.value} type="button" aria-pressed={level === l.value} onClick={() => setLevel(l.value)} className={chipClass(level === l.value)}>
                                        {l.label}
                                    </button>
                                ))}
                            </div>
                        </section>

                        {resumes.length > 0 && (
                            <section className="space-y-2.5">
                                <p className={LABEL}>Resume</p>
                                <div className="flex flex-wrap gap-1.5">
                                    <button type="button" aria-pressed={resumeId === null} onClick={() => setResumeId(null)} className={chipClass(resumeId === null)}>
                                        None
                                    </button>
                                    {resumes.map((r) => (
                                        <button key={r.id} type="button" aria-pressed={resumeId === r.id} onClick={() => setResumeId(r.id)} className={chipClass(resumeId === r.id)}>
                                            {r.name}
                                        </button>
                                    ))}
                                </div>
                            </section>
                        )}
                    </div>

                    <fieldset className="space-y-3">
                        <legend className={LABEL}>How deep</legend>
                        <div className="grid gap-2 sm:grid-cols-3">
                            {DEPTHS.map((d, i) => (
                                <label key={d.value} className="relative block cursor-pointer">
                                    <input type="radio" name="depth" value={d.value} checked={depth === i} onChange={() => setDepth(i)} className="peer sr-only" />
                                    <span className="flex h-full flex-col justify-between gap-3 rounded-lg border border-input px-3.5 py-3 transition-colors hover:bg-accent/50 peer-checked:border-primary peer-checked:bg-primary/5 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                                        <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-foreground/70">{d.label}</span>
                                        <span className="flex items-baseline justify-between gap-2">
                                            <span className="font-serif text-xl leading-none tracking-[-0.02em]">{d.minutes} min</span>
                                            <span className="text-xs text-muted-foreground tabular-nums">{planTotals(d.value).questions} questions</span>
                                        </span>
                                    </span>
                                    <span aria-hidden className="pointer-events-none absolute right-3.5 top-3.5 size-1.5 rounded-full bg-primary opacity-0 transition-opacity peer-checked:opacity-100" />
                                </label>
                            ))}
                        </div>
                        <PhaseBar depth={DEPTHS[depth].value} />
                        <p className="text-xs text-muted-foreground">{planSummary(planSegments(DEPTHS[depth].value))}</p>
                    </fieldset>

                    <details className="group border-t pt-4">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center gap-2">
                                <Icon name="sliders" className="size-4 shrink-0 text-muted-foreground" />
                                <span className={LABEL}>Tune the interviewer</span>
                            </span>
                            <Icon name="chevron" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
                            <Dial id="company_size" label="Company size" value={COMPANY_SIZES[companySize].value} values={COMPANY_SIZES.map((c) => c.value)} labels={COMPANY_SIZES.map((c) => companySizeLabel(c.value))} onChange={(v) => setCompanySize(COMPANY_SIZES.findIndex((c) => c.value === v))} />
                            <Dial id="cynicism" label="Cynicism" value={CYNICISM[cynicism].value} values={CYNICISM.map((c) => c.value)} labels={CYNICISM.map((c) => c.label)} onChange={(v) => setCynicism(CYNICISM.findIndex((c) => c.value === v))} />
                            <div className="space-y-2 sm:col-span-2">
                                <label htmlFor="topic" className="block text-sm font-medium">
                                    Topic (optional)
                                </label>
                                <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} placeholder="e.g. system design" className="max-w-xl rounded-md" />
                            </div>
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:col-span-2">
                                <Toggle id="brutally_honest" checked={brutallyHonest} onChange={setBrutallyHonest} label="Brutally honest" />
                                <Toggle id="hardcore" checked={hardcore} onChange={setHardcore} label="Hardcore" />
                                <Toggle id="human_mode" checked={humanMode} onChange={setHumanMode} label="Human mode" />
                            </div>
                        </div>
                    </details>
                </div>

                <div className="sticky bottom-0 border-t bg-card/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:px-8">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        {error ? (
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                        ) : (
                            <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>
                        )}
                        <Button type="submit" disabled={busy} className="h-10 px-6">
                            {busy ? "Creating..." : "Start interview"}
                        </Button>
                    </div>
                </div>
            </form>
        </Card>
    );
}

function PhaseBar({ depth }: { depth: Depth }) {
    const segments = planBar(depth);
    const total = segments.reduce((n, s) => n + s.turns, 0);
    const tones = ["bg-foreground/12", "bg-foreground/12", "bg-foreground/30", "bg-foreground/55", "bg-foreground/35", "bg-primary"];
    return (
        <div aria-hidden className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted">
            {segments.map((s, i) => (
                <span key={s.label} title={`${s.label} · ${s.turns} ${s.turns === 1 ? "turn" : "turns"}`} style={{ width: `${(s.turns / total) * 100}%` }} className={cn("h-full transition-[width] duration-300", tones[i])} />
            ))}
        </div>
    );
}

function Dial({ id, label, value, values, labels, onChange, showRange = true }: { id: string; label: string; value: string; values: string[]; labels: string[]; onChange: (value: string) => void; showRange?: boolean }) {
    const index = Math.max(0, values.indexOf(value));
    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className={LABEL}>
                    {label}
                </label>
                <span className="shrink-0 text-sm tabular-nums">{labels[index]}</span>
            </div>
            <Slider id={id} name={id} min={0} max={values.length - 1} step={1} value={index} aria-valuetext={labels[index]} onChange={(e) => onChange(values[Number(e.target.value)])} className="w-full" />
            {showRange && (
                <div aria-hidden className="flex justify-between text-[10px] leading-none text-muted-foreground">
                    <span>{labels[0]}</span>
                    <span>{labels[labels.length - 1]}</span>
                </div>
            )}
        </div>
    );
}

function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm">
            <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
            <span className="font-medium">{label}</span>
        </label>
    );
}
