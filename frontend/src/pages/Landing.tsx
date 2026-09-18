import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { PLANS } from "@/lib/plans";

// / — public marketing landing. It is the only crawlable route (everything under /dashboard is behind
// auth), which is why the copy is plain HTML with no auth or chart code anywhere near it: the
// Clerk SDK and recharts are in lazy chunks this route never fetches.
// Navigation here must stay <Link>/<a href>: an onClick handler is a <button>, which is not a
// link and passes nothing to a crawler.
export function Landing() {
    useDocumentTitle();

    const features = [
        { title: "AI interviewer", body: "A simulated coach that asks real questions, one at a time, and reacts to your answers." },
        { title: "Feedback + review", body: "Every answer is graded like a chess engine would grade a move — brilliant through blunder — and the run ends in an accuracy score, a letter grade, a hire/reject call and tips you can act on." },
        { title: "Progress that persists", body: "Every interview is saved — replay the transcript with its annotations, watch your accuracy trend, improve over time." },
    ];

    const steps = [
        { title: "Set the interview", body: "Pick the role, level and company size. Add a topic, or dial how cynical and brutally honest the interviewer should be." },
        { title: "Answer in the chat", body: "One question at a time — chitchat, then behavioural, then technical, until the arc is spent." },
        { title: "Get reviewed", body: "Each answer is annotated on its own, plus whether this run would convert and how much evidence backs that." },
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
                        <Link to="/dashboard">Sign in</Link>
                    </Button>
                    <Button asChild>
                        <Link to="/dashboard">Start free</Link>
                    </Button>
                </nav>
            </header>

            <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-12">
                <section className="flex flex-col items-center gap-8 text-center">
                    <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Practice interviews with an AI coach that gives real feedback.</h1>
                    <p className="max-w-xl text-lg text-muted-foreground">Answer questions one at a time, get every answer annotated like a chess engine annotates moves, and track your accuracy across every practice run.</p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                        <Button size="lg" asChild>
                            <Link to="/dashboard">Start practicing free</Link>
                        </Button>
                        <Button size="lg" variant="outline" asChild>
                            <Link to="/dashboard">Sign in</Link>
                        </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">No credit card · {PLANS.free.turns} free turns a day · Cancel anytime</p>
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
                            <li key={s.title} className="rounded-lg border p-5">
                                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Step {i + 1}</span>
                                <h3 className="mt-1 font-medium">{s.title}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
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
                                        <Link to="/dashboard">{id === "premium" ? `Upgrade · ${plan.monthly}` : "Start free"}</Link>
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

                <section className="flex flex-col items-center gap-3 rounded-lg border p-8 text-center">
                    <h2 className="text-xl font-semibold tracking-tight">Your next interview is practice, not the real one.</h2>
                    <Button size="lg" asChild>
                        <Link to="/dashboard">Start practicing free</Link>
                    </Button>
                </section>
            </main>

            <footer className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 pb-10 text-sm text-muted-foreground">
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>maxterview — AI mock-interview coach.</span>
                    <div className="flex items-center gap-4">
                        <Link to="/dashboard" className="underline underline-offset-2 hover:text-foreground">
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
