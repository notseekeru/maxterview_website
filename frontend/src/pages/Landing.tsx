import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { MOVE_CLASSES } from "@/lib/moveClasses";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

const VIDEO_START = 6.25;

const SECTIONS = [
    { id: "grades", label: "Grading" },
    { id: "how", label: "How it works" },
    { id: "pricing", label: "Pricing" },
    { id: "questions", label: "Questions" },
];

const HERO_FACTS = [`${PLANS.free.turns} free turns a day`, "Behavioral, technical and case rounds", "No credit card"];

export function Landing() {
    useDocumentTitle();

    const videoRef = useRef<HTMLVideoElement>(null);

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

    const features = [
        { title: "AI interviewer", body: "One question at a time, chitchat through technical, reacting to the answer you just gave." },
        { title: "Graded, not summarized", body: "Every answer is annotated on its own, and every run ends in a verdict you can act on." },
        { title: "Progress that persists", body: "Replay any transcript with its annotations, and watch accuracy trend across runs." },
    ];

    const steps = [
        { title: "Set the interview", body: "Pick the role, level and company size. Add a topic, or dial how cynical and how brutally honest the interviewer should be.", img: "/assets/landing/step-1-setup.jpg" },
        { title: "Answer in the chat", body: "One question at a time: chitchat, then behavioral, then technical, until the arc is spent.", img: "/assets/landing/step-2-answer.jpg" },
        { title: "Get reviewed", body: "Each answer is annotated on its own, plus whether this run would convert and how much evidence backs that.", img: "/assets/landing/step-3-review.jpg" },
    ];

    const faq = [
        { q: "Is it free?", a: `Yes. Free includes ${PLANS.free.turns} chat turns a day across all your interviews and full feedback on every run. ${PLANS.premium.name} adds ${PLANS.premium.turns} turns a day for ${PLANS.premium.price} per ${PLANS.premium.term}.` },
        { q: "What happens when I run out of turns?", a: "The interview pauses, nothing is deleted and your history stays readable. The counter resets at 00:00 UTC, or you can upgrade for more turns." },
        { q: "Which roles and levels does it cover?", a: "Any role you can name, from intern to staff, across behavioral, technical and case rounds. Save a setup as a preset and replay it whenever you want." },
        { q: "Do you train on my answers?", a: "No. Your transcripts are stored so you can revisit them and are sent to the interview model only to generate your questions and feedback." },
        { q: "Can I use my own model?", a: "Yes. Bring an OpenAI-compatible key (OpenAI, DeepSeek, OpenRouter, a local model) in settings and your turns run on your own account." },
    ];

    return (
        <div className="flex min-h-screen flex-col">
            <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
                <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
                    <Link to="/" className="flex items-center gap-2.5" aria-label="maxterview home">
                        <img src="/M-Inverted.svg" width={500} height={500} alt="" aria-hidden className="size-6 rounded-[0.35rem] ring-1 ring-border" />
                        <span className="text-sm font-semibold tracking-tight">maxterview</span>
                    </Link>
                    <nav className="flex items-center gap-1">
                        {SECTIONS.map((s) => (
                            <a key={s.id} href={`#${s.id}`} className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground md:block">
                                {s.label}
                            </a>
                        ))}
                        <Button variant="ghost" size="sm" asChild>
                            <Link to="/sign-in">Sign in</Link>
                        </Button>
                        <Button size="sm" asChild>
                            <Link to="/sign-up">Start free</Link>
                        </Button>
                    </nav>
                </div>
            </header>

            <main className="flex-1">
                <section className="px-6 pt-14 pb-14 sm:pt-20">
                    <div className="mx-auto w-full max-w-5xl">
                        {/* Staggered on load, never on scroll: the whole hero is above the fold, and a
                            reveal-on-scroll hero fires on a page that already painted. */}
                        <h1 className="animate-rise max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">AI mock interview practice, with real feedback on every answer.</h1>
                        <p className="animate-rise mt-5 max-w-2xl text-lg text-muted-foreground [animation-delay:80ms]">Answer behavioral and technical questions one at a time, get every answer annotated the way a chess engine annotates moves, and watch your accuracy across every run.</p>
                        <div className="animate-rise mt-8 flex flex-wrap items-center gap-3 [animation-delay:140ms]">
                            <Button size="lg" asChild>
                                <Link to="/sign-up">Start practicing free</Link>
                            </Button>
                            <Button size="lg" variant="outline" asChild>
                                <a href="#how">See how it works</a>
                            </Button>
                        </div>
                        <ul className="animate-rise mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground [animation-delay:200ms]">
                            {HERO_FACTS.map((f, i) => (
                                <li key={f} className="flex items-center gap-3">
                                    {i > 0 && <span aria-hidden className="h-3.5 w-px bg-border" />}
                                    {f}
                                </li>
                            ))}
                        </ul>

                        <div className="animate-rise mt-12 overflow-hidden rounded-xl border bg-card shadow-xl shadow-black/5 [animation-delay:260ms] dark:shadow-black/40">
                            <div aria-hidden className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
                                <span className="flex gap-1.5">
                                    {[0, 1, 2].map((i) => (
                                        <span key={i} className="size-2 rounded-full border bg-background" />
                                    ))}
                                </span>
                                <span className="mx-auto flex items-center gap-2 text-xs text-muted-foreground">
                                    <span className="animate-breathe size-1.5 rounded-full bg-foreground" />
                                    recorded run
                                </span>
                            </div>
                            <div className="relative isolate aspect-[8/3]">
                                <img
                                    src="/assets/landing/demo-hero-poster.jpg"
                                    srcSet="/assets/landing/demo-hero-poster-800.jpg 800w, /assets/landing/demo-hero-poster.jpg 1600w"
                                    sizes="100vw"
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
                        </div>

                        {/* One column until lg: at 640-1023 three up gives each value prop a ~230px column,
                            which wraps the one-liners to four lines. Stacked rows read better than that. */}
                        <dl className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-3">
                            {features.map((f) => (
                                <div key={f.title} className="bg-background p-5">
                                    <dt className="text-sm font-medium">{f.title}</dt>
                                    <dd className="mt-1 text-sm text-muted-foreground">{f.body}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </section>

                <section id="grades" className="scroll-mt-20 border-t px-6 py-16">
                    <div className="mx-auto w-full max-w-5xl">
                        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Every answer gets a grade</h2>
                        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Seven classes, the same vocabulary a chess engine annotates moves with. A run then closes on one call: would this convert, and how much evidence stands behind that.</p>
                        <dl className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
                            {MOVE_CLASSES.map((m) => (
                                <div key={m.value} className="flex gap-3 bg-background p-4">
                                    <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-md border text-xs font-semibold", m.tone)}>
                                        {m.glyph}
                                    </span>
                                    <div className="min-w-0">
                                        <dt className="text-sm font-medium">{m.label}</dt>
                                        <dd className="mt-0.5 text-xs text-muted-foreground">{m.hint}</dd>
                                    </div>
                                </div>
                            ))}
                            {/* Eighth cell: a 7-item list leaves the 2-up grid with one gap, and the verdict
                                is the half of the product the seven classes above do not cover. */}
                            <div className="flex gap-3 bg-background p-4">
                                <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md border border-foreground/25 bg-foreground/10 text-xs font-semibold">
                                    %
                                </span>
                                <div className="min-w-0">
                                    <dt className="text-sm font-medium">Run verdict</dt>
                                    <dd className="mt-0.5 text-xs text-muted-foreground">Accuracy, a letter grade, a hire or reject call, and the fixes that would move it.</dd>
                                </div>
                            </div>
                        </dl>
                    </div>
                </section>

                <section id="how" className="scroll-mt-20 border-t px-6 py-16">
                    <div className="mx-auto w-full max-w-5xl">
                        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
                        <ol className="mt-6 divide-y border-y">
                            {steps.map((s, i) => (
                                <li key={s.title} className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:gap-8">
                                    <div className="flex items-center gap-4 sm:w-44 sm:shrink-0">
                                        <span className="text-sm tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                                        <img src={s.img} width={240} height={240} loading="lazy" decoding="async" alt="" aria-hidden className="size-14 rounded-lg border object-cover grayscale" />
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="font-medium">{s.title}</h3>
                                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{s.body}</p>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <section id="pricing" className="scroll-mt-20 border-t px-6 py-16">
                    <div className="mx-auto w-full max-w-5xl">
                        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pricing</h2>
                        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {(["free", "premium"] as const).map((id) => {
                                const plan = PLANS[id];
                                return (
                                    <div key={id} className={cn("flex flex-col gap-4 rounded-lg border p-6", id === "premium" && "border-foreground/30")}>
                                        <div className="flex items-baseline justify-between gap-2">
                                            <h3 className="font-medium">{plan.name}</h3>
                                            <span className="text-2xl font-semibold tabular-nums">
                                                {plan.price}
                                                {plan.term && <span className="text-sm font-normal text-muted-foreground"> / {plan.term}</span>}
                                            </span>
                                        </div>
                                        <ul className="space-y-1.5 text-sm text-muted-foreground">
                                            <li>
                                                {plan.turns} chat turns a day
                                                {id === "premium" && ` (${plan.turns / PLANS.free.turns}x the free plan)`}
                                            </li>
                                            <li>
                                                {plan.resumes} resume {plan.resumes === 1 ? "slot" : "slots"}
                                            </li>
                                            <li>Unlimited interviews, full review on every run</li>
                                        </ul>
                                        <Button asChild variant={id === "premium" ? "default" : "outline"} className="mt-auto">
                                            <Link to={id === "premium" ? "/settings/billing" : "/sign-up"}>{id === "premium" ? `Upgrade to ${plan.name}` : "Start free"}</Link>
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                        {/* Must stay true in both billing modes. */}
                        <p className="mt-4 text-xs text-muted-foreground">Prices in PHP, paid by QR through PayMongo (GCash, Maya, or any bank app). One payment covers {PLANS.premium.term}, no auto-renew.</p>
                    </div>
                </section>

                <section id="questions" className="scroll-mt-20 border-t px-6 py-16">
                    <div className="mx-auto w-full max-w-5xl">
                        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Questions</h2>
                        <dl className="mt-6 divide-y rounded-lg border">
                            {faq.map((item) => (
                                <div key={item.q} className="p-5">
                                    <dt className="font-medium">{item.q}</dt>
                                    <dd className="mt-1 max-w-3xl text-sm text-muted-foreground">{item.a}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </section>

                <section className="border-t px-6 py-16">
                    <div className="mx-auto w-full max-w-5xl">
                        <div className="relative isolate overflow-hidden rounded-xl border">
                            <img
                                src="/assets/landing/cta-desk-night.jpg"
                                srcSet="/assets/landing/cta-desk-night-800.jpg 800w, /assets/landing/cta-desk-night.jpg 1600w"
                                sizes="100vw"
                                width={1600}
                                height={500}
                                loading="lazy"
                                decoding="async"
                                alt=""
                                aria-hidden
                                className="absolute inset-0 -z-10 h-full w-full object-cover object-center"
                            />
                            {/* Vignette rather than a flat wash: the source has its bright spot (laptop glow) in
                                the middle, which is where the centred headline sits, so the middle band has to be
                                the darkest part of the band, not the edges. */}
                            <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/35 via-black/70 to-black/35" />
                            <div className="flex flex-col items-center gap-5 px-6 py-16 text-center text-white sm:py-20">
                                <h2 className="max-w-xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">Your next interview is practice, not the real one.</h2>
                                <Button size="lg" className="bg-white text-black hover:bg-white/90" asChild>
                                    <Link to="/sign-up">Start practicing free</Link>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t px-6 py-8">
                <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>maxterview, AI mock-interview coach.</span>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
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
    );
}
