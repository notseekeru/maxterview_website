import { domAnimation, LazyMotion, MotionConfig, m, useScroll } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { MoveClass } from "@/lib/api";
import { gradeTone, MOVE_CLASSES, moveClassMeta } from "@/lib/moveClasses";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

const VIDEO_START = 6.25;

// One curve for every entrance. `m` animates transform, which the CSS reduced-motion block in
// index.css cannot reach, so <MotionConfig reducedMotion="user"> below is what honours the OS
// switch for everything driven from here. domAnimation is the small feature bundle: it carries
// whileInView, which is the only entrance trigger this page uses.
const GLIDE = [0.22, 1, 0.36, 1] as const;
const VIEWPORT = { once: true, margin: "-80px 0px -80px 0px" } as const;

const SECTIONS = [
    { id: "grades", label: "Grading" },
    { id: "how", label: "How it works" },
    { id: "pricing", label: "Pricing" },
    { id: "questions", label: "Questions" },
];

const HERO_FACTS = [`${PLANS.free.turns} free turns a day`, "Behavioral, technical and case rounds", "No credit card"];

const FEATURES = [
    { title: "AI interviewer", body: "One question at a time, chitchat through technical, reacting to the answer you just gave." },
    { title: "Graded, not summarized", body: "Every answer is annotated on its own, and every run ends in a verdict you can act on." },
    { title: "Progress that persists", body: "Replay any transcript with its annotations, and watch accuracy trend across runs." },
];

// Specimen, not a real transcript: three turns is enough to show what an annotation looks like on
// the page, and `note` is typed as MoveClass so a row can never name a class the grader does not
// have and render an empty glyph. Labelled SPECIMEN in the figure head for exactly that reason.
const TURN_LOG: { turn: string; answer: string; note: MoveClass; delta: string }[] = [
    { turn: "04", answer: "Two years on the billing service, mostly Go.", note: "good", delta: "+6" },
    { turn: "05", answer: "We sharded on tenant id, then backfilled in batches.", note: "great", delta: "+11" },
    { turn: "06", answer: "Kafka, because it scales.", note: "blunder", delta: "−9" },
];

// Specimen dashboard. Same four headline numbers the real dashboard shows, so the page cannot
// promise a metric the product does not compute. Accuracies are whole numbers from 0-100 because
// the API sends the derived integer (rating.accuracy), not a 1-10 average.
const ANALYTICS_STATS = [
    { label: "Interviews", value: "14" },
    { label: "Finished", value: "12" },
    { label: "Avg accuracy", value: "74%", hint: "from 12 of 12 rated" },
    { label: "Hire rate", value: "58%", hint: "7 of 12 decided" },
];

const TREND: number[] = [41, 48, 44, 57, 63, 59, 68, 71, 66, 74, 74];

const TREND_PATH = (() => {
    const step = 100 / (TREND.length - 1);
    return TREND.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)} ${(32 - (v / 100) * 32).toFixed(2)}`).join(" ");
})();

// Specimen run log. Mirrors the analytics table: one row per finished run, with the grade and the
// hiring call the API stores on the row. The F row is a hardcore failure: its accuracy is still the
// number the earlier answers averaged to, and only the letter is forced to F by the turn that ended
// the run. That mechanic appears nowhere else on this page.
const RUN_LOG: { date: string; role: string; accuracy: string; grade: "S" | "A" | "B" | "C" | "D" | "F"; decision: string }[] = [
    { date: "02/14", role: "Backend engineer", accuracy: "74%", grade: "B", decision: "Lean hire" },
    { date: "02/11", role: "Platform engineer", accuracy: "66%", grade: "C", decision: "Lean hire" },
    { date: "02/09", role: "Backend engineer", accuracy: "52%", grade: "F", decision: "Reject" },
    { date: "02/06", role: "Backend engineer", accuracy: "71%", grade: "B", decision: "Lean hire" },
];

const STEPS = [
    { title: "Set the interview", body: "Pick the role, level and company size. Add a topic, or dial how cynical and how brutally honest the interviewer should be." },
    { title: "Answer in the chat", body: "One question at a time: chitchat, then behavioral, then technical, until the arc is spent." },
    { title: "Get reviewed", body: "Each answer is annotated on its own, plus whether this run would convert and how much evidence backs that." },
];

const FAQ = [
    { q: "Is it free?", a: `Yes. Free includes ${PLANS.free.turns} chat turns a day across all your interviews and full feedback on every run. ${PLANS.premium.name} adds ${PLANS.premium.turns} turns a day for ${PLANS.premium.price} per ${PLANS.premium.term}.` },
    { q: "What happens when I run out of turns?", a: "The interview pauses, nothing is deleted and your history stays readable. The counter resets at 00:00 UTC, or you can upgrade for more turns." },
    { q: "Which roles and levels does it cover?", a: "Any role you can name, from intern to staff, across behavioral, technical and case rounds. Save a setup as a preset and replay it whenever you want." },
    { q: "Do you train on my answers?", a: "No. Your transcripts are stored so you can revisit them and are sent to the interview model only to generate your questions and feedback." },
    { q: "Can I use my own model?", a: "Yes. Bring an OpenAI-compatible key (OpenAI, DeepSeek, OpenRouter, a local model) in settings and your turns run on your own account." },
];

// Mono, not the serif: every label on this page is furniture (a folio, a column head, a unit), and
// furniture is what a mono is for. The serif only ever sets a title or a sentence. Set at 70% of
// --foreground rather than --muted-foreground because these run at 10.4px, where the secondary
// token measures 4.43:1 on the light palette and 4.35:1 once a --muted fill sits behind it.
const LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.18em] text-foreground/70";
const SHELL = "mx-auto w-full max-w-[76rem] px-6 sm:px-8 lg:px-10";
// Section spacing has one owner: leading padding here, nothing trailing, so two adjacent sections
// cannot stack their gaps into a dead band.
const SECTION = "pt-24 sm:pt-32 lg:pt-40";

/** Scroll entrance. Renders the element itself rather than a wrapper, so a caller can drop it on a
 *  grid row or a `dl` child without inserting a box that breaks layout or markup. */
function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
    return (
        <m.div className={className} initial={{ opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={VIEWPORT} transition={{ duration: 0.7, ease: GLIDE, delay }}>
            {children}
        </m.div>
    );
}

function Folio({ n, label }: { n: string; label: string }) {
    return (
        <div className="flex items-baseline justify-between gap-6 border-t pt-3">
            <span className={LABEL}>{label}</span>
            <span className={cn(LABEL, "tabular-nums")}>{n}</span>
        </div>
    );
}

export function Landing() {
    useDocumentTitle();

    const videoRef = useRef<HTMLVideoElement>(null);
    const { scrollYProgress } = useScroll();

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (!window.matchMedia("(min-width: 1024px)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;

        video.currentTime = VIDEO_START;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) void video.play().catch(() => {});
                else video.pause();
            },
            { threshold: 0.25 },
        );
        observer.observe(video);
        return () => observer.disconnect();
    }, []);

    return (
        <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
                <div className="flex min-h-screen flex-col overflow-x-clip">
                    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
                        <div className={cn(SHELL, "flex items-center justify-between gap-4 py-3")}>
                            <Link to="/" className="flex items-center gap-2.5" aria-label="maxterview home">
                                <img src="/M-Inverted.svg" width={500} height={500} alt="" aria-hidden className="size-6 rounded-[0.35rem] ring-1 ring-border" />
                                <span className="text-sm font-semibold tracking-tight">maxterview</span>
                            </Link>
                            <nav aria-label="Sections" className="flex items-center gap-1">
                                {SECTIONS.map((s) => (
                                    <a
                                        key={s.id}
                                        href={`#${s.id}`}
                                        className="relative hidden px-2.5 py-1.5 text-sm text-muted-foreground transition-colors after:absolute after:inset-x-2.5 after:bottom-0.5 after:h-px after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-300 after:ease-glide hover:text-foreground hover:after:scale-x-100 md:block"
                                    >
                                        {s.label}
                                    </a>
                                ))}
                                <Button variant="ghost" size="sm" className="rounded-full" asChild>
                                    <Link to="/sign-in">Sign in</Link>
                                </Button>
                                <Button size="sm" className="rounded-full" asChild>
                                    <Link to="/sign-up">Start free</Link>
                                </Button>
                            </nav>
                        </div>
                        <m.span aria-hidden style={{ scaleX: scrollYProgress }} className="absolute inset-x-0 bottom-0 h-px origin-left bg-foreground" />
                    </header>

                    <main className="flex-1">
                        <section className="relative isolate overflow-hidden pt-20 sm:pt-24">
                            {/* Dot grid faded out on all four sides by a radial mask, so the pattern reads as a
                                surface the page sits on rather than as a texture across the whole page. */}
                            <div aria-hidden className="dotgrid pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(120%_80%_at_50%_0%,#000_20%,transparent_75%)]" />
                            <m.div initial="hidden" animate="shown" className={SHELL}>
                                <m.p variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0, transition: { duration: 0.6, ease: GLIDE } } }} className={cn(LABEL, "inline-flex items-center gap-2 rounded-full border px-3 py-1.5")}>
                                    <span className="animate-breathe size-1.5 rounded-full bg-foreground" />
                                    AI mock interviews
                                </m.p>
                                {/* rem, not `ch`: the display size lives on the masked child, so a `ch` cap here
                                    would resolve against this element's inherited 16px and clip the headline
                                    against the overflow-hidden mask. Must stay font-size independent. */}
                                <h1 className="mt-6 max-w-[46rem]">
                                    {/* The mask is the wrapper and the padding lives on the moving child: the
                                        child has to stay at least as tall as its own descenders or the clip
                                        guillotines the p/y/q in the headline, and the mask's negative margin
                                        cancels the room that padding opens up below it. */}
                                    <span className="block -mb-[0.16em] overflow-hidden">
                                        <m.span variants={{ hidden: { y: "112%" }, shown: { y: "0%", transition: { duration: 1.05, ease: GLIDE, delay: 0.06 } } }} className="block pb-[0.16em] font-serif text-[clamp(2.75rem,6vw,5rem)] leading-[1.03] tracking-[-0.03em] text-balance">
                                            AI mock interview practice, with real feedback on every answer.
                                        </m.span>
                                    </span>
                                </h1>
                                <m.p variants={{ hidden: { opacity: 0, y: 14 }, shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease: GLIDE, delay: 0.3 } } }} className="mt-7 max-w-[54ch] text-[1.05rem] leading-[1.75] text-muted-foreground">
                                    Answer behavioral and technical questions one at a time, get every answer annotated the way a chess engine annotates moves, and watch your accuracy across every run.
                                </m.p>
                                <m.div variants={{ hidden: { opacity: 0, y: 14 }, shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease: GLIDE, delay: 0.42 } } }} className="mt-9 flex flex-wrap items-center gap-3">
                                    <Button size="lg" className="rounded-full" asChild>
                                        <Link to="/sign-up">Start practicing free</Link>
                                    </Button>
                                    <Button size="lg" variant="outline" className="rounded-full" asChild>
                                        <a href="#how">See how it works</a>
                                    </Button>
                                </m.div>
                                <m.ul variants={{ hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0.8, delay: 0.56, staggerChildren: 0.07 } } }} className="mt-8 flex flex-wrap gap-2">
                                    {HERO_FACTS.map((f) => (
                                        <m.li key={f} variants={{ hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: GLIDE } } }} className={cn(LABEL, "rounded-full border px-3 py-1.5")}>
                                            {f}
                                        </m.li>
                                    ))}
                                </m.ul>
                            </m.div>

                            <m.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, ease: GLIDE, delay: 0.68 }} className={cn(SHELL, "mt-16")}>
                                <figure className="overflow-hidden rounded-xl border bg-card shadow-xl shadow-black/5 dark:shadow-black/50">
                                    {/* figcaption has to be a direct child of figure, and it has to stay out of
                                        the aria-hidden group: the traffic lights are decoration, the label is the
                                        figure's accessible name. */}
                                    <figcaption className={cn(LABEL, "flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5")}>
                                        <span aria-hidden className="flex gap-1.5">
                                            {[0, 1, 2].map((i) => (
                                                <span key={i} className="size-2 rounded-full border bg-background" />
                                            ))}
                                        </span>
                                        <span className="mx-auto flex items-center gap-2">
                                            <span aria-hidden className="animate-breathe size-1.5 rounded-full bg-foreground" />
                                            recorded run
                                        </span>
                                    </figcaption>
                                    <div className="relative isolate aspect-[8/3]">
                                        <img
                                            src="/assets/landing/demo-hero-poster.jpg"
                                            srcSet="/assets/landing/demo-hero-poster-800.jpg 800w, /assets/landing/demo-hero-poster.jpg 1600w"
                                            sizes="(min-width: 1216px) 1216px, 100vw"
                                            width={1600}
                                            height={600}
                                            fetchPriority="high"
                                            decoding="async"
                                            alt=""
                                            aria-hidden
                                            className="absolute inset-0 h-full w-full object-cover object-center"
                                        />
                                        {/* No poster attribute: the <img> above already is the poster, with a real srcset. */}
                                        <video ref={videoRef} src="/assets/landing/demo-hero.mp4" muted playsInline loop preload="none" aria-label="Screen recording of a practice interview: questions, answers and the review" className="absolute inset-0 h-full w-full object-cover object-center" />
                                    </div>
                                </figure>
                            </m.div>

                            <ul className={cn(SHELL, "mt-16 grid gap-px border-y bg-border md:grid-cols-3")}>
                                {FEATURES.map((f, i) => (
                                    <Reveal key={f.title} delay={i * 0.08} className="bg-background px-6 py-8">
                                        <h3 className="font-serif text-xl tracking-[-0.015em]">{f.title}</h3>
                                        <p className="mt-3 max-w-[42ch] text-sm leading-[1.75] text-muted-foreground">{f.body}</p>
                                    </Reveal>
                                ))}
                            </ul>
                        </section>

                        <section id="grades" className={cn(SHELL, SECTION, "scroll-mt-24")}>
                            <Reveal>
                                <Folio n="01" label="Grading" />
                                <h2 className="mt-10 max-w-[24ch] font-serif text-[clamp(1.9rem,3.4vw,3.25rem)] leading-[1.06] tracking-[-0.025em] text-balance">Every answer gets a grade</h2>
                                <p className="mt-5 max-w-[52ch] text-[0.975rem] leading-[1.8] text-muted-foreground">Seven classes, the same vocabulary a chess engine annotates moves with. A run then closes on one call: would this convert, and how much evidence stands behind that.</p>
                            </Reveal>

                            {/* The product artifact this page was missing. Everything above it is prose about the
                                grader; this is the grader's actual output shape, in the product's own vocabulary. */}
                            <Reveal delay={0.1} className="mt-14">
                                <figure className="overflow-hidden rounded-xl border">
                                    <div className="flex items-baseline justify-between gap-6 border-b bg-muted/40 px-3 py-3 sm:px-5">
                                        <span className={LABEL}>Turn log</span>
                                        <span className={cn(LABEL, "opacity-70")}>Specimen</span>
                                    </div>
                                    <table className="w-full border-collapse text-sm">
                                        <thead>
                                            <tr className="border-b">
                                                {["Turn", "Answer", "Class", "Delta"].map((h, i) => (
                                                    <th key={h} scope="col" className={cn(LABEL, "px-3 py-3 font-normal sm:px-5", i === 2 || i === 3 ? "text-right" : "text-left")}>
                                                        {h}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {TURN_LOG.map((row) => {
                                                const meta = moveClassMeta(row.note);
                                                return (
                                                    <tr key={row.turn} className="border-b last:border-b-0">
                                                        <td className={cn("px-3 py-4 font-mono text-xs tabular-nums text-muted-foreground sm:px-5")}>{row.turn}</td>
                                                        <td className="px-3 py-4 font-serif text-base tracking-[-0.01em] sm:px-5">{row.answer}</td>
                                                        <td className="px-3 py-4 text-right sm:px-5">
                                                            <span className={cn("inline-flex size-7 items-center justify-center rounded-md border text-[0.7rem] font-semibold", meta?.tone)}>{meta?.glyph}</span>
                                                        </td>
                                                        <td className={cn("px-3 py-4 text-right font-mono text-xs tabular-nums sm:px-5", row.delta.startsWith("+") ? "text-foreground" : "text-muted-foreground")}>{row.delta}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </figure>
                            </Reveal>

                            {/* Specimen, like the turn log above it. The analytics half of the product had no
                                artifact on this page: four headline numbers and the trend are what the dashboard
                                actually renders after a few runs. */}
                            <Reveal delay={0.1} className="mt-14">
                                <figure className="overflow-hidden rounded-xl border">
                                    <div className="flex items-baseline justify-between gap-6 border-b bg-muted/40 px-3 py-3 sm:px-5">
                                        <span className={LABEL}>Progress</span>
                                        <span className={cn(LABEL, "opacity-70")}>Specimen</span>
                                    </div>
                                    <dl className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
                                        {ANALYTICS_STATS.map((s) => (
                                            <div key={s.label} className="bg-background px-4 py-5 sm:px-5">
                                                <dt className={cn(LABEL, "opacity-70")}>{s.label}</dt>
                                                <dd className="mt-3 font-serif text-4xl leading-none tracking-[-0.03em] tabular-nums">{s.value}</dd>
                                                {s.hint && <p className="mt-2 font-mono text-[0.6rem] tabular-nums text-muted-foreground">{s.hint}</p>}
                                            </div>
                                        ))}
                                    </dl>
                                    <div className="border-t px-4 py-5 sm:px-5">
                                        <div className="flex items-baseline justify-between gap-4">
                                            <span className={cn(LABEL, "opacity-70")}>Accuracy trend</span>
                                            <span className="font-mono text-[0.6rem] tabular-nums text-muted-foreground">last {TREND.length} rated runs</span>
                                        </div>
                                        <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={`Accuracy across the last ${TREND.length} rated runs, from ${TREND[0]}% to ${TREND[TREND.length - 1]}%`} className="mt-4 h-16 w-full">
                                            <path d={`${TREND_PATH} L100 32 L0 32 Z`} fill="var(--chart-1)" fillOpacity={0.08} />
                                            {/* The 100-wide viewBox is stretched to the card, so strokeWidth 0.6
                                                would scale with it. vectorEffect pins the stroke to one
                                                device-space hairline at any width. */}
                                            <path d={TREND_PATH} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                                        </svg>
                                    </div>
                                    <table className="w-full border-collapse border-t text-sm">
                                        <thead>
                                            <tr className="border-b">
                                                {["Run", "Role", "Accuracy", "Grade", "Call"].map((h, i) => (
                                                    <th key={h} scope="col" className={cn(LABEL, "px-3 py-3 font-normal sm:px-5", i >= 2 ? "text-right" : "text-left")}>
                                                        {h}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {RUN_LOG.map((r) => (
                                                <tr key={r.date} className="border-b last:border-b-0">
                                                    <td className="px-3 py-3.5 font-mono text-xs tabular-nums text-muted-foreground sm:px-5">{r.date}</td>
                                                    <td className="px-3 py-3.5 font-serif text-base tracking-[-0.01em] sm:px-5">{r.role}</td>
                                                    <td className="px-3 py-3.5 text-right font-mono text-xs tabular-nums sm:px-5">{r.accuracy}</td>
                                                    <td className="px-3 py-3.5 text-right sm:px-5">
                                                        <span className={cn("inline-flex size-7 items-center justify-center rounded-md border text-[0.7rem] font-semibold", gradeTone(r.grade))}>{r.grade}</span>
                                                    </td>
                                                    <td className="px-3 py-3.5 text-right text-xs text-muted-foreground sm:px-5">{r.decision}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </figure>
                            </Reveal>

                            <ul className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
                                {MOVE_CLASSES.map((m, i) => (
                                    <Reveal key={m.value} delay={(i % 4) * 0.05} className="group bg-background p-5">
                                        <span aria-hidden className={cn("flex size-10 items-center justify-center rounded-md border text-xs font-semibold transition-transform duration-300 ease-glide group-hover:scale-110", m.tone)}>
                                            {m.glyph}
                                        </span>
                                        <h3 className="mt-4 font-serif text-lg tracking-[-0.015em]">{m.label}</h3>
                                        <p className="mt-1.5 text-xs leading-[1.7] text-muted-foreground">{m.hint}</p>
                                    </Reveal>
                                ))}
                                {/* Eighth cell: a 7-item list leaves the grid with one gap, and the verdict is the
                                    half of the product the seven classes above do not cover. */}
                                <Reveal className="bg-background p-5">
                                    <span aria-hidden className="flex size-10 items-center justify-center rounded-md border border-foreground/25 bg-foreground/10 text-xs font-semibold">
                                        %
                                    </span>
                                    <h3 className="mt-4 font-serif text-lg tracking-[-0.015em]">Run verdict</h3>
                                    <p className="mt-1.5 text-xs leading-[1.7] text-muted-foreground">Accuracy, a letter grade, a hire or reject call, and the fixes that would move it.</p>
                                </Reveal>
                            </ul>
                        </section>

                        <section id="how" className={cn(SHELL, SECTION, "scroll-mt-24")}>
                            <Reveal>
                                <Folio n="02" label="How it works" />
                                <h2 className="mt-10 max-w-[24ch] font-serif text-[clamp(1.9rem,3.4vw,3.25rem)] leading-[1.06] tracking-[-0.025em] text-balance">How it works</h2>
                            </Reveal>
                            <ol className="mt-14 grid gap-px border-y bg-border md:grid-cols-3">
                                {STEPS.map((s, i) => (
                                    <m.li key={s.title} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={VIEWPORT} transition={{ duration: 0.7, ease: GLIDE, delay: i * 0.1 }} className="bg-background px-6 py-10">
                                        <span aria-hidden className={cn(LABEL, "font-serif text-5xl tabular-nums leading-none tracking-[-0.03em] text-foreground")}>
                                            {String(i + 1).padStart(2, "0")}
                                        </span>
                                        <h3 className="mt-8 font-serif text-xl tracking-[-0.015em]">{s.title}</h3>
                                        <p className="mt-3 max-w-[42ch] text-sm leading-[1.8] text-muted-foreground">{s.body}</p>
                                    </m.li>
                                ))}
                            </ol>
                        </section>

                        {/* The lexicon, run edge to edge on the one dark band. This is the page's single full-bleed
                            moment and it carries the product's actual vocabulary, glyph by glyph, rather than a
                            photograph of somebody at a desk. */}
                        <div className="relative mt-24 border-y bg-[#111111] text-white sm:mt-32 lg:mt-40">
                            <div aria-hidden className="dotgrid absolute inset-0 opacity-40 [mask-image:radial-gradient(90%_140%_at_50%_50%,#000_10%,transparent_80%)]" />
                            <div className={cn(SHELL, "relative py-16 sm:py-20")}>
                                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-white/50">The grading vocabulary</p>
                                <ul className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/15 bg-white/15 sm:grid-cols-4 lg:grid-cols-8">
                                    {MOVE_CLASSES.map((m) => (
                                        <li key={m.value} className="flex flex-col items-center gap-3 bg-[#111111] px-3 py-6">
                                            <span aria-hidden className="font-serif text-2xl leading-none tracking-[-0.02em]">
                                                {m.glyph}
                                            </span>
                                            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-white/60">{m.label}</span>
                                        </li>
                                    ))}
                                    <li className="flex flex-col items-center gap-3 bg-[#111111] px-3 py-6">
                                        <span aria-hidden className="font-serif text-2xl leading-none tracking-[-0.02em]">
                                            %
                                        </span>
                                        <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-white/60">Verdict</span>
                                    </li>
                                </ul>
                            </div>
                        </div>

                        <section id="pricing" className={cn(SHELL, SECTION, "scroll-mt-24")}>
                            <Reveal>
                                <Folio n="03" label="Pricing" />
                                <h2 className="mt-10 max-w-[24ch] font-serif text-[clamp(1.9rem,3.4vw,3.25rem)] leading-[1.06] tracking-[-0.025em] text-balance">Pricing</h2>
                            </Reveal>
                            {/* Uneven split: the paid plan gets the width. Emphasis is the border, not a fill:
                                a 3% tint behind the plan's own --muted-foreground items measures 4.43:1, under
                                AA, while the same text on plain white is 4.74:1. */}
                            <div className="mt-14 grid grid-cols-1 gap-4 lg:grid-cols-12">
                                {(["free", "premium"] as const).map((id, i) => {
                                    const plan = PLANS[id];
                                    const premium = id === "premium";
                                    return (
                                        <Reveal key={id} delay={i * 0.08} className={cn("flex flex-col gap-6 rounded-xl border p-8", premium ? "lg:col-span-7 lg:border-foreground/40 lg:p-10" : "lg:col-span-5")}>
                                            <div className="flex items-baseline justify-between gap-3 border-b pb-6">
                                                <h3 className={LABEL}>{plan.name}</h3>
                                                <span className={cn("font-serif tabular-nums tracking-[-0.03em]", premium ? "text-5xl" : "text-4xl")}>
                                                    {plan.price}
                                                    {plan.term && <span className="ml-2 text-sm tracking-normal text-muted-foreground">/ {plan.term}</span>}
                                                </span>
                                            </div>
                                            <ul className="divide-y text-sm text-muted-foreground">
                                                <li className="py-3">
                                                    {plan.turns} chat turns a day
                                                    {premium && ` (${plan.turns / PLANS.free.turns}x the free plan)`}
                                                </li>
                                                <li className="py-3">
                                                    {plan.resumes} resume {plan.resumes === 1 ? "slot" : "slots"}
                                                </li>
                                                <li className="py-3">Unlimited interviews, full review on every run</li>
                                            </ul>
                                            <Button asChild variant={premium ? "default" : "outline"} className="mt-auto rounded-full">
                                                <Link to={premium ? "/settings/billing" : "/sign-up"}>{premium ? `Upgrade to ${plan.name}` : "Start free"}</Link>
                                            </Button>
                                        </Reveal>
                                    );
                                })}
                            </div>
                            {/* Must stay true in both billing modes. */}
                            <p className="mt-6 font-mono text-[0.65rem] leading-[1.9] tracking-[0.04em] text-muted-foreground">Prices in PHP, paid by QR through PayMongo (GCash, Maya, or any bank app). One payment covers {PLANS.premium.term}, no auto-renew.</p>
                        </section>

                        <section id="questions" className={cn(SHELL, SECTION, "scroll-mt-24")}>
                            <Reveal>
                                <Folio n="04" label="Questions" />
                                <h2 className="mt-10 max-w-[24ch] font-serif text-[clamp(1.9rem,3.4vw,3.25rem)] leading-[1.06] tracking-[-0.025em] text-balance">Questions</h2>
                            </Reveal>
                            <dl className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-2">
                                {FAQ.map((item, i) => (
                                    <Reveal key={item.q} delay={(i % 2) * 0.06} className="bg-background p-6">
                                        <dt className="flex items-baseline gap-4">
                                            <span aria-hidden className={cn(LABEL, "tabular-nums")}>
                                                {String(i + 1).padStart(2, "0")}
                                            </span>
                                            <span className="font-serif text-lg tracking-[-0.015em]">{item.q}</span>
                                        </dt>
                                        <dd className="mt-3 max-w-[52ch] text-sm leading-[1.8] text-muted-foreground">{item.a}</dd>
                                    </Reveal>
                                ))}
                            </dl>
                        </section>

                        <section className="pb-24 sm:pb-32 lg:pb-40">
                            <div className="relative isolate overflow-hidden border-y bg-[#111111] text-white">
                                <div aria-hidden className="dotgrid absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(70%_120%_at_50%_50%,#000_5%,transparent_70%)]" />
                                <div aria-hidden className="absolute top-1/2 left-1/2 -z-10 size-[46rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.06] blur-3xl" />
                                <m.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={VIEWPORT} transition={{ duration: 0.85, ease: GLIDE }} className={cn(SHELL, "flex flex-col items-center gap-8 py-24 text-center sm:py-32")}>
                                    <h2 className="max-w-[22ch] font-serif text-[clamp(2rem,4.2vw,3.75rem)] leading-[1.05] tracking-[-0.03em] text-balance">Your next interview is practice, not the real one.</h2>
                                    <Button size="lg" className="rounded-full bg-white text-black hover:bg-white/90" asChild>
                                        <Link to="/sign-up">Start practicing free</Link>
                                    </Button>
                                </m.div>
                            </div>
                        </section>
                    </main>

                    <footer className="border-t">
                        <div className={cn(SHELL, "flex flex-wrap items-center justify-between gap-4 py-10 text-sm text-muted-foreground")}>
                            <span className="font-serif text-base tracking-[-0.01em] text-foreground">maxterview</span>
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                                {SECTIONS.map((s) => (
                                    <a key={s.id} href={`#${s.id}`} className="transition-colors hover:text-foreground">
                                        {s.label}
                                    </a>
                                ))}
                                <Link to="/sign-in" className="transition-colors hover:text-foreground">
                                    Sign in
                                </Link>
                                <Link to="/dashboard" className="transition-colors hover:text-foreground">
                                    Dashboard
                                </Link>
                            </div>
                        </div>
                    </footer>
                </div>
            </MotionConfig>
        </LazyMotion>
    );
}
