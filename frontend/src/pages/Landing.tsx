import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { MOVE_CLASSES } from "@/lib/moveClasses";
import { PLANS } from "@/lib/plans";

// / — public marketing landing. It is the only crawlable route (everything under /dashboard is behind
// auth), which is why the copy is plain HTML with no auth or chart code anywhere near it: the
// Clerk SDK and recharts are in lazy chunks this route never fetches.
// Navigation here must stay <Link>/<a href>: an onClick handler is a <button>, which is not a
// link and passes nothing to a crawler. Auth-intent CTAs point at /sign-in and /sign-up, which
// render Clerk's own form in a lazy chunk; nothing on this route imports the auth SDK.
// The five backdrop photos live in public/assets/landing (pre-cropped grayscale JPEGs, provenance
// in CREDITS.txt). Brightness and gradient live in CSS, not in the files, so the same asset can be
// re-graded without a re-render pass. Every one of them is decorative: alt="" + aria-hidden.
// Subject rule for these photos: one person at a screen, or an empty desk. Never a candidate facing
// an interviewer — that reads as a human-led interview, which is the one thing this product is not.
//
// The hero still is demo-hero-poster.jpg — frame 25 (t=6.25s) of the demo recording, cut to the
// band with the most detail. It is the LCP element and the only thing phones ever see: the video on
// top of it is desktop-only (a UI recording is unreadable at phone width) and only fetched once the
// panel is on screen. Because the poster is the frame the video starts on (VIDEO_START), playback
// begins on the exact image already painted, so there is no cut from still to motion.
const VIDEO_START = 6.25;

export function Landing() {
    useDocumentTitle();

    const videoRef = useRef<HTMLVideoElement>(null);

    // Play only while the hero is on screen, and only on a wide, non-data-saver, motion-tolerant
    // client. A 1.2MB autoplaying loop is not worth it on a phone, and swapping the file in on
    // rotation is worse than never starting it, so the width check is one-shot.
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
        { title: "AI interviewer", body: "A simulated coach that asks real questions, one at a time, and reacts to your answers." },
        { title: "Feedback + review", body: "Every answer is graded like a chess engine would grade a move — brilliant through blunder — and the run ends in an accuracy score, a letter grade, a hire/reject call and tips you can act on." },
        { title: "Progress that persists", body: "Every interview is saved — replay the transcript with its annotations, watch your accuracy trend, improve over time." },
    ];

    const steps = [
        { title: "Set the interview", body: "Pick the role, level and company size. Add a topic, or dial how cynical and brutally honest the interviewer should be.", img: "/assets/landing/step-1-setup.jpg" },
        { title: "Answer in the chat", body: "One question at a time — chitchat, then behavioural, then technical, until the arc is spent.", img: "/assets/landing/step-2-answer.jpg" },
        { title: "Get reviewed", body: "Each answer is annotated on its own, plus whether this run would convert and how much evidence backs that.", img: "/assets/landing/step-3-review.jpg" },
    ];

    const faq = [
        { q: "Is it free?", a: `Yes. The free plan includes ${PLANS.free.turns} chat turns a day across all your interviews and full feedback on every run. Premium adds a bigger daily allowance for ${PLANS.premium.monthly}.` },
        { q: "What happens when I run out of turns?", a: "The interview pauses, nothing is deleted and your history stays readable. The counter resets at 00:00 UTC, or you can upgrade for more turns." },
        { q: "Do you train on my answers?", a: "No. Your transcripts are stored so you can revisit them and are sent to the interview model only to generate your questions and feedback." },
        { q: "Can I use my own model?", a: "Yes — bring an OpenAI-compatible key (OpenAI, DeepSeek, OpenRouter, a local model) in settings, and your turns run on your own account." },
    ];

    return (
        <div className="flex min-h-screen flex-col">
            <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
                <span className="text-xl font-semibold tracking-tight">maxterview</span>
                <nav className="flex items-center gap-2">
                    <Button variant="ghost" asChild>
                        <Link to="/sign-in">Sign in</Link>
                    </Button>
                    <Button asChild>
                        <Link to="/sign-up">Start free</Link>
                    </Button>
                </nav>
            </header>

            <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-12">
                <section className="relative isolate overflow-hidden rounded-xl border">
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
                        className="absolute inset-0 -z-10 h-full w-full object-cover object-center brightness-[.75] contrast-[1.05]"
                    />
                    {/* Same grade as the still underneath, so the swap to motion is invisible. No
                        poster attribute: the <img> above already is the poster, with a real srcset. */}
                    <video ref={videoRef} src="/assets/landing/demo-hero.mp4" muted playsInline loop preload="none" aria-label="Screen recording of a practice interview: questions, answers and the review" className="absolute inset-0 -z-10 h-full w-full object-cover object-center brightness-[.75] contrast-[1.05]" />
                    {/* Two washes, not one, and the split is at lg because that is where the panel gets
                        wider than the copy column (max-w-2xl = 672px): below lg the copy spans the whole
                        panel, so the wash has to be flat-dark; at lg the right third is text-free and can
                        keep photo detail (the via-70% stop is what holds the left of it dark). */}
                    <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/80 via-black/85 to-black/70 lg:hidden" />
                    <div aria-hidden className="absolute inset-0 -z-10 hidden bg-gradient-to-r from-black/95 from-0% via-black/85 via-70% to-black/25 lg:block" />
                    <div className="flex max-w-2xl flex-col gap-6 px-6 py-14 text-white sm:px-10 sm:py-20">
                        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Practice interviews with an AI coach that gives real feedback.</h1>
                        <p className="text-lg text-white/80">Answer questions one at a time, get every answer annotated like a chess engine annotates moves, and track your accuracy across every practice run.</p>
                        <div className="flex flex-wrap items-center gap-3">
                            <Button size="lg" className="bg-white text-black hover:bg-white/90" asChild>
                                <Link to="/sign-up">Start practicing free</Link>
                            </Button>
                            <Button size="lg" variant="outline" className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white" asChild>
                                <Link to="/sign-in">Sign in</Link>
                            </Button>
                        </div>
                        {/* The scale the reviewer actually grades on. It is the product's own vocabulary
                            (lib/moveClasses), rendered read-only: the hint is the tooltip. */}
                        <ul aria-label="How answers are graded" className="flex flex-wrap items-center gap-2 text-xs text-white/70">
                            {MOVE_CLASSES.map((m) => (
                                <li key={m.value} title={m.hint} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1">
                                    <span aria-hidden className="font-semibold text-white/90">
                                        {m.glyph}
                                    </span>
                                    {m.label}
                                </li>
                            ))}
                        </ul>
                        <p className="text-sm text-white/70">No credit card · {PLANS.free.turns} free turns a day · Cancel anytime</p>
                    </div>
                </section>

                <section aria-label="What you get" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {features.map((f) => (
                        <div key={f.title} className="rounded-lg border p-5">
                            <h2 className="font-medium">{f.title}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
                        </div>
                    ))}
                </section>

                <section aria-label="How it works" className="space-y-4">
                    <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
                    <ol className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        {steps.map((s, i) => (
                            <li key={s.title} className="overflow-hidden rounded-lg border">
                                <img src={s.img} width={240} height={240} loading="lazy" decoding="async" alt="" aria-hidden className="h-24 w-full object-cover grayscale opacity-60" />
                                <div className="p-5">
                                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Step {i + 1}</span>
                                    <h3 className="mt-1 font-medium">{s.title}</h3>
                                    <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>

                <section aria-label="Pricing" className="space-y-4">
                    <h2 className="text-2xl font-semibold tracking-tight">Pricing</h2>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {(["free", "premium"] as const).map((id) => {
                            const plan = PLANS[id];
                            return (
                                <div key={id} className="flex flex-col gap-3 rounded-lg border p-5">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <h3 className="font-medium">{plan.name}</h3>
                                        <span className="text-lg font-semibold">{plan.monthly}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                        {plan.turns} chat turns per day · {plan.pitch}
                                    </p>
                                    <ul className="space-y-1.5 text-sm text-muted-foreground">
                                        <li>Unlimited interviews — no interview cap</li>
                                        <li>Full answer-by-answer review and hire/reject verdict</li>
                                        <li>Bring your own model key if you prefer</li>
                                    </ul>
                                    <Button asChild variant={id === "premium" ? "default" : "outline"} className="mt-auto">
                                        <Link to={id === "premium" ? "/settings/billing" : "/sign-up"}>{id === "premium" ? `Upgrade · ${plan.monthly}` : "Start free"}</Link>
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                    {/* Must stay true in both billing modes. */}
                    <p className="text-xs text-muted-foreground">Prices in PHP, charged through PayMongo (Maya). You keep Premium until the end of the period you paid for.</p>
                </section>

                <section aria-label="Frequently asked questions" className="space-y-3">
                    <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
                    <dl className="divide-y rounded-lg border">
                        {faq.map((item) => (
                            <div key={item.q} className="p-4">
                                <dt className="font-medium">{item.q}</dt>
                                <dd className="mt-1 text-sm text-muted-foreground">{item.a}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className="relative isolate overflow-hidden rounded-xl border">
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
                        className="absolute inset-0 -z-10 h-full w-full object-cover object-center brightness-[.75] contrast-[1.05]"
                    />
                    {/* Vignette rather than a flat wash: the source has its bright spot (laptop glow) in the
                        middle, which is where the centred headline sits, so the middle band has to be the
                        darkest part of the band, not the edges. */}
                    <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/30 via-black/65 to-black/30" />
                    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center text-white sm:py-20">
                        <h2 className="max-w-xl text-xl font-semibold tracking-tight sm:text-2xl">Your next interview is practice, not the real one.</h2>
                        <Button size="lg" className="bg-white text-black hover:bg-white/90" asChild>
                            <Link to="/sign-up">Start practicing free</Link>
                        </Button>
                    </div>
                </section>
            </main>

            <footer className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 pb-10 text-sm text-muted-foreground">
                <div aria-hidden className="h-px w-full shrink-0 bg-border" />
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>maxterview — AI mock-interview coach.</span>
                    <div className="flex items-center gap-4">
                        <Link to="/sign-in" className="underline underline-offset-2 hover:text-foreground">
                            Sign in
                        </Link>
                        <Link to="/dashboard" className="underline underline-offset-2 hover:text-foreground">
                            Dashboard
                        </Link>
                    </div>
                </div>
            </footer>
        </div>
    );
}
