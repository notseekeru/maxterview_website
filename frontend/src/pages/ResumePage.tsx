import { useCallback, useEffect, useState } from "react";
import { HighlightedTextarea } from "@/components/HighlightedTextarea";
import { LatexPreview } from "@/components/LatexPreview";
import { Page } from "@/components/PagePrimitives";
import { ResumeReviewView } from "@/components/ResumeReviewView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StateNote } from "@/components/ui/state";
import { apiDetail, createResume, deleteResume, extractResume, getResume, getResumeReview, getUsage, httpStatus, listResumes, type Resume as ResumeRecord, type ResumeReview, type ResumeSummary, retryRewrite, reviewResume, updateResume } from "@/lib/api";
import { isLatex } from "@/lib/latex";
import { replaceLine } from "@/lib/resumeText";
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
    const [review, setReview] = useState<ResumeReview | null>(null);
    const [reviewing, setReviewing] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
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
        const usage = getUsage().catch(() => null);
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
        setLimit((await usage)?.resume_limit ?? null);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const loadReview = useCallback(async (id: string | null) => {
        setReviewError(null);
        setReview(id ? await getResumeReview(id).catch(() => null) : null);
    }, []);

    // Keyed on the id alone: a save rewrites the stored text and the server retires the review on its
    // own, so the refetch after save is what keeps an edited resume from showing the old advice.
    useEffect(() => {
        void loadReview(draft.id);
    }, [draft.id, loadReview]);

    async function reviewCurrent() {
        if (!draft.id) return;
        setReviewing(true);
        setReviewError(null);
        try {
            setReview(await reviewResume(draft.id));
        } catch (e) {
            setReviewError(apiDetail(e, "Could not review this resume."));
        } finally {
            setReviewing(false);
        }
    }

    // Apply rewrites into the editor, not the database: the candidate decides what lands, and a save is
    // still a save. Dismissing or applying drops the row, which the review view owns.
    function applyRewrite(source: string, rewrite: string) {
        setDraft((d) => {
            const next = replaceLine(d.text, source, rewrite);
            return next === null ? d : { ...d, text: next };
        });
    }

    async function retryEdit(source: string) {
        if (!draft.id) return;
        setReviewError(null);
        try {
            setReview(await retryRewrite(draft.id, source));
        } catch (e) {
            setReviewError(apiDetail(e, "Could not retry that edit."));
        }
    }

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
            // An edit keeps the id, so the effect above cannot see it: only a create fires that one.
            if (draft.id) await loadReview(saved.id);
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

    // The drop zone's second door. The draft the user came from stays in `restore`, so a Cancel on the
    // blank card returns to it, unsaved text included. This used to be reachable only when no resume
    // existed yet: with one, the drop zone's only exit was Cancel and a new resume had to be a PDF.
    function pasteInstead() {
        setDraft(EMPTY_DRAFT);
        setPasting(true);
        setImporting(false);
        setError(null);
        setNotice(null);
    }

    function cancelNew() {
        setImporting(false);
        setDraft(restore ?? EMPTY_DRAFT);
        setPasting(false);
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
            // The list lives inside the editor card, so a delete has to open what is left or the card
            // (and with it the only way back to another resume) disappears with the last row.
            const rest = rows.filter((r) => r.id !== draft.id);
            setRows(rest);
            setDraft(EMPTY_DRAFT);
            setPasting(false);
            setImporting(false);
            setRestore(null);
            setNotice(null);
            if (rest.length) await open(rest[0].id);
        } catch (e) {
            fail(e, "Could not delete that resume.");
        } finally {
            setBusy(false);
        }
    }

    const atCap = limit !== null && rows.length >= limit;
    const active = rows.find((r) => r.id === draft.id);
    const dirty = draft.id === null ? !!draft.name.trim() || !!draft.text.trim() : !!active && (active.name !== draft.name || active.chars !== draft.text.length);
    const latex = isLatex(draft.text);

    return (
        <Page title="Resume" wide>
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
                        {/* Disabled while a PDF is being read: the extraction lands last and would overwrite whatever was typed here. */}
                        <div className="flex items-center gap-3">
                            <button type="button" onClick={pasteInstead} disabled={busy} className="text-xs underline underline-offset-2 hover:text-foreground disabled:opacity-50">
                                Paste resume instead
                            </button>
                            {restore && (
                                <button type="button" onClick={() => discardDraft()} disabled={busy} className="text-xs underline underline-offset-2 hover:text-foreground disabled:opacity-50">
                                    Cancel
                                </button>
                            )}
                        </div>
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

                {editing && (
                    // AI HERE: paired panels fit the viewport and scroll inside, so the resume and the review
                    // stay readable side by side. The ceiling is the hard-coded header height in the calc: if
                    // the stack above the grid changes, this offset is wrong. Upgrade path is a measured offset.
                    <div className={cn("grid gap-4", draft.id && !importing && "xl:h-[calc(100dvh-10rem)]", draft.id && !importing && (latex ? "xl:grid-cols-3" : "xl:grid-cols-2"))}>
                        <Card className="flex min-h-0 flex-col">
                            <CardHeader className="flex-row items-baseline justify-between space-y-0">
                                <CardTitle>{draft.id ? "Resume" : "New resume"}</CardTitle>
                                {dirty && <span className="text-xs text-muted-foreground">{draft.id ? "Unsaved changes" : "Not saved"}</span>}
                            </CardHeader>
                            <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
                                {rows.length > 0 && (
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
                                )}
                                <div className="space-y-1.5">
                                    <label htmlFor="resume-name" className="text-sm font-medium leading-none">
                                        Name
                                    </label>
                                    <Input id="resume-name" value={draft.name} maxLength={80} placeholder="Title" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                                </div>
                                <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                                    <label htmlFor="resume-text" className="text-sm font-medium leading-none">
                                        Resume text
                                    </label>
                                    <HighlightedTextarea id="resume-text" value={draft.text} onChange={(text) => setDraft((d) => ({ ...d, text }))} lines={review?.lines ?? []} latex={latex} placeholder="Paste your resume here…" />
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

                        {draft.id && !importing && latex && <LatexPreview text={draft.text} />}

                        {/* Saved text only: the review reads the row, so unsaved edits cannot be what it looks at. A new review is a new key: that is what drops the focused band and the all-levels toggle. */}
                        {draft.id && !importing && <ResumeReviewView key={review?.created_at ?? "none"} review={review} busy={reviewing} error={reviewError} disabled={busy || dirty} onReview={() => void reviewCurrent()} onApply={applyRewrite} onRetry={retryEdit} />}
                    </div>
                )}
            </div>
        </Page>
    );
}
