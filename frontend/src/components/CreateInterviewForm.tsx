import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { apiDetail, createInterview, createTemplate, deleteTemplate, type InterviewDials, type InterviewTemplate, listResumes, listTemplates, type ResumeSummary, type TemplateInput, updateTemplate } from "@/lib/api";
import { COMPANY_SIZES, CYNICISM, companySizeLabel, DIAL_FIELDS, LEVELS, MIX_FIELDS, MIX_MAX, mixCountLabel, ROLE_PRESETS } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
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
    const [mix, setMix] = useState({ mix_chitchat: 0, mix_behavioural: 2, mix_technical: MIX_MAX });
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
            ...mix,
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

    return (
        <Card className="w-full overflow-hidden">
            <form onSubmit={submit}>
                <CardHeader className="border-b py-4">
                    <CardTitle className="text-lg">New interview</CardTitle>
                </CardHeader>

                <CardContent className="divide-y p-0">
                    {templates && (
                        <section className="space-y-2 px-5 py-4">
                            <p className="text-sm font-medium">Presets</p>
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

                    {resumes.length > 0 && (
                        <section className="space-y-2 px-5 py-4">
                            <p className="text-sm font-medium">Resume</p>
                            <div className="flex flex-wrap items-center gap-1.5">
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

                    <section className="space-y-2 px-5 py-4">
                        <label htmlFor="role" className="block text-sm font-medium">
                            Role
                        </label>
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
                        <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} maxLength={200} placeholder="e.g. Software Engineer, or pick a preset above" required className="max-w-xl rounded-md" />
                    </section>

                    <section className="space-y-4 px-5 py-4">
                        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
                            <Dial id="level" label="Level" value={level} values={LEVELS.map((l) => l.value)} labels={LEVELS.map((l) => l.label)} onChange={setLevel} />
                            <Dial id="company_size" label="Company size" value={COMPANY_SIZES[companySize].value} values={COMPANY_SIZES.map((c) => c.value)} labels={COMPANY_SIZES.map((c) => companySizeLabel(c.value))} onChange={(v) => setCompanySize(COMPANY_SIZES.findIndex((c) => c.value === v))} />
                            <Dial id="cynicism" label="Cynicism" value={CYNICISM[cynicism].value} values={CYNICISM.map((c) => c.value)} labels={CYNICISM.map((c) => c.label)} onChange={(v) => setCynicism(CYNICISM.findIndex((c) => c.value === v))} />
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="topic" className="block text-sm font-medium">
                                Topic (optional)
                            </label>
                            <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} placeholder="e.g. system design" className="max-w-xl rounded-md" />
                        </div>
                    </section>

                    <section className="space-y-3 px-5 py-4">
                        <p className="text-sm font-medium">Question mix</p>
                        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
                            {MIX_FIELDS.map((f) => (
                                <Dial
                                    key={f.field}
                                    id={f.field}
                                    label={f.label}
                                    value={String(mix[f.field])}
                                    values={Array.from({ length: MIX_MAX + 1 }, (_, n) => String(n))}
                                    labels={Array.from({ length: MIX_MAX + 1 }, (_, n) => mixCountLabel(n))}
                                    onChange={(v) => setMix((m) => ({ ...m, [f.field]: Number(v) }))}
                                    showRange={false}
                                />
                            ))}
                        </div>
                    </section>

                    <section className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3">
                        <Toggle id="brutally_honest" checked={brutallyHonest} onChange={setBrutallyHonest} label="Brutally honest" />
                        <Toggle id="hardcore" checked={hardcore} onChange={setHardcore} label="Hardcore" />
                        <Toggle id="human_mode" checked={humanMode} onChange={setHumanMode} label="Human mode" />
                    </section>
                </CardContent>

                <CardFooter className="flex-wrap items-center justify-end gap-3 border-t py-4">
                    {error && (
                        <p role="alert" className="mr-auto text-sm text-destructive">
                            {error}
                        </p>
                    )}
                    <Button type="submit" disabled={busy} className="h-10 px-6">
                        {busy ? "Creating..." : "Start interview"}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}

function Dial({ id, label, value, values, labels, onChange, showRange = true }: { id: string; label: string; value: string; values: string[]; labels: string[]; onChange: (value: string) => void; showRange?: boolean }) {
    const index = Math.max(0, values.indexOf(value));
    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-sm font-medium">
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
