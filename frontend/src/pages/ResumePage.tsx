import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/AppIcons";
import { Page } from "@/components/PagePrimitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, createResume, deleteResume, extractResume, getResume, getUsage, httpStatus, listResumes, type Resume as ResumeRecord, type ResumeSummary, updateResume } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The draft the editor holds: `id` null = not saved yet (a paste, or a PDF that was never confirmed). */
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
    // Locked behind the free plan's wall (a 402 from the server): the message IS the upsell.
    const [capped, setCapped] = useState(false);
    const menuRef = useRef<HTMLDetailsElement>(null);
    // The drop panel's own hover state: the highlight has to survive crossing the panel's own
    // children (each of which fires a dragleave as the cursor moves over it).
    const [dropping, setDropping] = useState(false);

    // Same open/close contract as RowMenu: <details> gives the toggle, these two listeners make it
    // behave like a menu. AI HERE: no focus trap / arrow keys — the panel holds one label.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const el = menuRef.current;
            if (el?.open && !el.contains(e.target as Node)) el.open = false;
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && menuRef.current) menuRef.current.open = false;
        };
        // A drag that MISSES the panel is the browser's own "open the PDF" navigation, and the
        // unsaved editor text goes with it. Cancel that default for as long as the panel is open.
        const onDrop = (e: DragEvent) => {
            if (menuRef.current?.open && !menuRef.current.contains(e.target as Node)) e.preventDefault();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        document.addEventListener("drop", onDrop);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("drop", onDrop);
        };
    }, []);

    const load = useCallback(async () => {
        try {
            setRows(await listResumes());
        } catch {
            setError("Could not load your resumes.");
        }
        // The cap is a tier number the library page has to show; a failure here must not hide the list.
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

    /** One entry point for the picker and the drop: a dropped file skips the `accept` attribute's
     *  filter, so this is the only place that gets to decide what a resume file is. */
    function pick(file: File | undefined) {
        if (!file) return;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
            // Rejected files leave the panel open: the retry belongs where the cursor already is.
            setError("That isn't a PDF — import a PDF, or paste the text instead.");
            setNotice(null);
            setCapped(false);
            return;
        }
        if (menuRef.current) menuRef.current.open = false;
        void importPdf(file);
    }

    async function importPdf(file: File) {
        setBusy(true);
        setError(null);
        setCapped(false);
        setNotice(null);
        try {
            // Extract is stateless: the PDF is parsed and discarded, and only the TEXT is kept. Nothing
            // to clean up if the parse is rejected.
            const got = await extractResume(file);
            const saved = await createResume({ name: file.name, text: got.text });
            setRows((list) => [saved, ...list]);
            setDraft({ id: saved.id, name: saved.name, text: saved.text });
            setNotice(got.truncated ? `Imported the first ${got.pages} pages — check the text below and edit anything missing.` : null);
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
            setNotice(null);
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
        if (draft.id === id) return;
        try {
            const full: ResumeRecord = await getResume(id);
            setDraft({ id: full.id, name: full.name, text: full.text });
        } catch (e) {
            fail(e, "Could not open that resume.");
        }
    }

    async function remove() {
        if (!draft.id || !confirm(`Delete "${draft.name}"? Interviews already created keep their transcript.`)) return;
        setBusy(true);
        setError(null);
        try {
            await deleteResume(draft.id);
            setRows((list) => list.filter((r) => r.id !== draft.id));
            setDraft(EMPTY_DRAFT);
            setNotice(null);
        } catch (e) {
            fail(e, "Could not delete that resume.");
        } finally {
            setBusy(false);
        }
    }

    const atCap = limit !== null && rows.length >= limit;

    return (
        <Page
            title="Resume"
            description="Import a resume so interviews are tailored to your actual projects — and so feedback can hold you to what it claims."
            actions={
                <>
                    {/* A dropdown rather than a plain button: browsing and dropping are the same
                        intent, and the panel is where that instruction fits without shouting it on
                        the page. `<details>` again, for the reasons RowMenu documents. */}
                    <details ref={menuRef} className="relative">
                        <summary className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none [&::-webkit-details-marker]:hidden", busy && "pointer-events-none opacity-50")}>Import PDF</summary>
                        <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border bg-popover p-2 shadow-md">
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
                                className={cn("flex cursor-pointer flex-col items-center gap-1.5 rounded-md border border-dashed px-3 py-6 text-center text-xs transition-colors", dropping ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
                            >
                                <Icon name="file" className="h-5 w-5" />
                                <span>{dropping ? "Drop it" : "Drop a PDF here, or click to browse"}</span>
                                <input
                                    type="file"
                                    accept="application/pdf,.pdf"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        // Reset first: picking the SAME file twice must fire again.
                                        e.target.value = "";
                                        pick(file);
                                    }}
                                />
                            </label>
                        </div>
                    </details>
                    <Button
                        disabled={busy}
                        onClick={() => {
                            setDraft(EMPTY_DRAFT);
                            setError(null);
                            setNotice("Paste your resume below, then save.");
                            setCapped(false);
                        }}
                    >
                        Paste text
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium leading-none">Your resumes</span>
                        {limit !== null && (
                            <span className="text-xs text-muted-foreground">
                                {rows.length} of {limit}
                                {limit === 1 && " — premium keeps 5"}
                            </span>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        {rows.map((r) => (
                            <button key={r.id} type="button" onClick={() => void open(r.id)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", draft.id === r.id ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}>
                                {r.name}
                                <span className="ml-1.5 text-[10px] text-muted-foreground">{r.chars.toLocaleString()} chars</span>
                            </button>
                        ))}
                        {rows.length === 0 && <span className="text-xs text-muted-foreground">Nothing imported yet.</span>}
                    </div>
                </div>

                {(error || notice || (capped && atCap)) && (
                    <div className="space-y-1 text-sm">
                        {error && <p className="text-destructive">{error}</p>}
                        {notice && !error && <p className="text-muted-foreground">{notice}</p>}
                        {capped && (
                            <a href="/app/settings/billing" className="text-xs text-muted-foreground underline underline-offset-2">
                                See plans
                            </a>
                        )}
                    </div>
                )}

                <Card>
                    <CardHeader>
                        <CardTitle>{draft.id ? "Edit resume" : "New resume"}</CardTitle>
                        <CardDescription>The text below is what the interviewer and the reviewer read. Fix anything the PDF export mangled — the interview uses this, not the file.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="space-y-1.5">
                            <label htmlFor="resume-name" className="text-sm font-medium leading-none">
                                Name
                            </label>
                            <Input id="resume-name" value={draft.name} maxLength={80} placeholder="Backend CV" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="resume-text" className="text-sm font-medium leading-none">
                                Resume text
                            </label>
                            <Textarea id="resume-text" value={draft.text} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} placeholder="Paste your resume here…" className="min-h-[24rem] font-mono text-xs leading-5" />
                            <p className="text-xs text-muted-foreground">{draft.text.length.toLocaleString()} characters — the first 8,000 are used per interview.</p>
                        </div>
                    </CardContent>
                    <div className="flex items-center gap-2 px-6 pb-6">
                        <Button disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={() => void save()}>
                            {busy ? "Saving…" : draft.id ? "Save changes" : "Save resume"}
                        </Button>
                        {draft.id && (
                            <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                                Delete
                            </Button>
                        )}
                    </div>
                </Card>

                <p className="text-xs text-muted-foreground">The PDF itself is never stored — only the text above. Attach a resume to an interview from the New interview form.</p>
            </div>
        </Page>
    );
}
