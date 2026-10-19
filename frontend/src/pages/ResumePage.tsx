import { useCallback, useEffect, useState } from "react";
import { Page, SectionHeading } from "@/components/PagePrimitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StateNote } from "@/components/ui/state";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, createResume, deleteResume, extractResume, getResume, getUsage, httpStatus, listResumes, type Resume as ResumeRecord, type ResumeSummary, updateResume } from "@/lib/api";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

interface Draft {
    id: string | null;
    name: string;
    text: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: "", text: "" };

export function ResumePage() {
    const [rows, setRows] = useState<ResumeSummary[]>([]);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [limit, setLimit] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [capped, setCapped] = useState(false);
    const [dropping, setDropping] = useState(false);
    const [pasting, setPasting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [restore, setRestore] = useState<Draft | null>(null);
    const editing = draft.id !== null || pasting;
    const showDrop = !editing && importing;

    useEffect(() => {
        if (pasting) document.getElementById("resume-text")?.focus();
    }, [pasting]);

    useEffect(() => {
        const swallow = (e: DragEvent) => e.preventDefault();
        document.addEventListener("drop", swallow);
        return () => document.removeEventListener("drop", swallow);
    }, []);

    const load = useCallback(async () => {
        try {
            const list = await listResumes();
            setRows(list);
            if (list.length) {
                const full = await getResume(list[0].id);
                setDraft({ id: full.id, name: full.name, text: full.text });
            }
        } catch {
            setError("Could not load your resumes.");
        }
        try {
            setLimit((await getUsage()).resume_limit ?? null);
        } catch {
            setLimit(null);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    function fail(e: unknown, fallback: string) {
        setError(apiDetail(e, fallback));
        setCapped(httpStatus(e) === 402);
    }

    function pick(file: File | undefined) {
        if (!file || busy) return;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
            setError("That isn't a PDF. Drop a PDF, or paste it instead.");
            setNotice(null);
            setCapped(false);
            return;
        }
        void importPdf(file);
    }

    async function importPdf(file: File) {
        setBusy(true);
        setError(null);
        setCapped(false);
        setNotice(null);
        try {
            const got = await extractResume(file);
            setDraft({ id: null, name: file.name.replace(/\.pdf$/i, "").slice(0, 80), text: got.text });
            setPasting(true);
            setImporting(false);
            setRestore(null);
            setNotice(got.truncated ? `Read the first ${got.pages} pages. Check the text and fix anything missing. Not saved yet.` : "Read the PDF. Check the text, then Save. Not saved yet.");
        } catch (e) {
            fail(e, "Could not import that PDF.");
        } finally {
            setBusy(false);
        }
    }

    async function save() {
        const name = draft.name.trim();
        if (!name || !draft.text.trim()) {
            setError("A resume needs a name and some text.");
            return;
        }
        setBusy(true);
        setError(null);
        setCapped(false);
        try {
            const saved = draft.id ? await updateResume(draft.id, { name, text: draft.text }) : await createResume({ name, text: draft.text });
            setRows((list) => (draft.id ? list.map((r) => (r.id === saved.id ? saved : r)) : [saved, ...list]));
            setDraft({ id: saved.id, name: saved.name, text: saved.text });
            setPasting(false);
            setImporting(false);
            setRestore(null);
            setNotice("Saved.");
        } catch (e) {
            fail(e, "Could not save this resume.");
        } finally {
            setBusy(false);
        }
    }

    async function open(id: string) {
        setError(null);
        setNotice(null);
        setCapped(false);
        setImporting(false);
        setPasting(false);
        if (draft.id === id) return;
        try {
            const full: ResumeRecord = await getResume(id);
            setDraft({ id: full.id, name: full.name, text: full.text });
            setRestore(null);
        } catch (e) {
            fail(e, "Could not open that resume.");
        }
    }

    function startNew() {
        setRestore(draft);
        setDraft(EMPTY_DRAFT);
        setPasting(false);
        setImporting(true);
        setDropping(false);
        setError(null);
        setNotice(null);
    }

    function cancelNew(blank = false) {
        setImporting(false);
        setDraft(blank ? EMPTY_DRAFT : (restore ?? EMPTY_DRAFT));
        setPasting(blank);
        setRestore(null);
        setError(null);
    }

    // The draft card's Cancel/Discard. Unsaved text (an extraction, or a hand edit) is work the
    // candidate cannot get back, so it asks first; a clean card just closes.
    function discardDraft() {
        if (dirty && !confirm("Discard these unsaved changes?")) return;
        if (!restore && draft.id === null) {
            setPasting(false);
            setDraft(EMPTY_DRAFT);
            setNotice(null);
            return;
        }
        cancelNew();
    }

    async function remove() {
        if (!draft.id || !confirm(`Delete "${draft.name}"? Interviews already created keep their transcript.`)) return;
        setBusy(true);
        setError(null);
        try {
            await deleteResume(draft.id);
            setRows((list) => list.filter((r) => r.id !== draft.id));
            setDraft(EMPTY_DRAFT);
            setPasting(false);
            setImporting(false);
            setRestore(null);
            setNotice(null);
        } catch (e) {
            fail(e, "Could not delete that resume.");
        } finally {
            setBusy(false);
        }
    }

    const atCap = limit !== null && rows.length >= limit;
    const active = rows.find((r) => r.id === draft.id);
    const dirty = draft.id === null ? !!draft.name.trim() || !!draft.text.trim() : !!active && (active.name !== draft.name || active.chars !== draft.text.length);

    return (
        <Page title="Resume" description="The text the interviewer reads. One per role is usually enough." wide>
            <div className="space-y-4">
                {(!editing || showDrop) && (
                    <label
                        onDragOver={(e) => {
                            e.preventDefault();
                            setDropping(true);
                        }}
                        onDragLeave={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
                        }}
                        onDrop={(e) => {
                            e.preventDefault();
                            setDropping(false);
                            pick(e.dataTransfer.files?.[0]);
                        }}
                        className={cn(
                            "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 text-center transition-colors",
                            editing || importing ? "min-h-[12rem]" : "min-h-[calc(100dvh-10.5rem)] lg:min-h-[calc(100dvh-6.5rem)]",
                            busy ? "cursor-default opacity-60" : "cursor-pointer",
                            dropping ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
                        )}
                    >
                        <span className="text-base">{dropping ? "Drop it" : busy ? "Reading the PDF…" : "Drop a PDF here, or click to browse"}</span>
                        <input
                            type="file"
                            accept="application/pdf,.pdf"
                            disabled={busy}
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                pick(file);
                            }}
                        />
                        <button type="button" onClick={() => (restore ? discardDraft() : cancelNew(true))} className="text-xs underline underline-offset-2 hover:text-foreground">
                            {rows.length ? "Cancel" : "Paste resume instead"}
                        </button>
                    </label>
                )}

                {(error || notice || capped) && (
                    <div className="space-y-1">
                        {error && <StateNote tone="danger">{error}</StateNote>}
                        {notice && !error && <StateNote>{notice}</StateNote>}
                        {capped && (
                            <a href="/settings/billing" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                                See plans
                            </a>
                        )}
                    </div>
                )}

                {rows.length > 0 && (
                    <section className="space-y-3">
                        <SectionHeading title="Your resumes" hint={limit === null ? undefined : `${rows.length} of ${limit}${limit === 1 ? ` · ${PLANS.premium.name} keeps more` : ""}`} />
                        <div className="flex flex-wrap items-center gap-1.5">
                            {rows.map((r) => (
                                <button key={r.id} type="button" onClick={() => void open(r.id)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", draft.id === r.id ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}>
                                    {r.name}
                                    <span className="ml-1.5 text-[10px] text-muted-foreground">{r.chars.toLocaleString()} chars</span>
                                </button>
                            ))}
                            {draft.id && !atCap && (
                                <button type="button" onClick={startNew} className="rounded-full border border-dashed border-input px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent">
                                    + New
                                </button>
                            )}
                        </div>
                    </section>
                )}

                {editing && (
                    <Card>
                        <CardHeader className="flex-row items-baseline justify-between space-y-0">
                            <CardTitle>{draft.id ? "Resume" : "New resume"}</CardTitle>
                            {dirty && <span className="text-xs text-muted-foreground">{draft.id ? "Unsaved changes" : "Not saved"}</span>}
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="space-y-1.5">
                                <label htmlFor="resume-name" className="text-sm font-medium leading-none">
                                    Name
                                </label>
                                <Input id="resume-name" value={draft.name} maxLength={80} placeholder="Title" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="resume-text" className="text-sm font-medium leading-none">
                                    Resume text
                                </label>
                                <Textarea id="resume-text" value={draft.text} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} placeholder="Paste your resume here…" className="min-h-[28rem] font-mono text-xs leading-5" />
                                <p className="text-xs text-muted-foreground">{draft.text.length.toLocaleString()} characters. The first 8,000 are used per interview.</p>
                            </div>
                        </CardContent>
                        <div className="flex items-center gap-2 px-6 pb-6">
                            <Button disabled={busy || !dirty} onClick={() => void save()}>
                                {busy ? "Saving…" : draft.id ? "Save" : "Save resume"}
                            </Button>
                            {draft.id ? (
                                <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                                    Delete
                                </Button>
                            ) : (
                                <Button variant="ghost" disabled={busy} onClick={discardDraft}>
                                    {dirty ? "Discard" : "Cancel"}
                                </Button>
                            )}
                        </div>
                    </Card>
                )}
            </div>
        </Page>
    );
}
