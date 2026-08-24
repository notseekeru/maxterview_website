import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// / — public marketing landing (M12). Black/white aesthetic.
export function Landing() {
    const navigate = useNavigate();

    const features = [
        { title: "AI interviewer", body: "A simulated coach that asks real questions, one at a time, and reacts to your answers." },
        { title: "Feedback + scoring", body: "Per-question and end-of-interview feedback across clarity, relevance, structure, and confidence." },
        { title: "Progress that persists", body: "Every interview is saved — replay the transcript, watch your scores trend, and improve over time." },
    ];

    return (
        <div className="flex min-h-screen flex-col">
            <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 py-6">
                <span className="text-xl font-semibold tracking-tight">maxterview</span>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => navigate("/app")}>
                        Sign in
                    </Button>
                    <Button onClick={() => navigate("/app")}>Get started</Button>
                </div>
            </header>

            <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-8 px-6 py-16 text-center">
                <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Practice interviews with an AI coach that gives real feedback.</h1>
                <p className="max-w-xl text-lg text-muted-foreground">Answer questions one at a time, get scored on clarity, relevance, structure, and confidence, and track your progress across every practice run.</p>
                <div className="flex items-center gap-3">
                    <Button size="lg" onClick={() => navigate("/app")}>
                        Start practicing
                    </Button>
                    <Button size="lg" variant="outline" onClick={() => navigate("/app")}>
                        Try it free
                    </Button>
                </div>
            </main>

            <section className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 px-6 pb-16 sm:grid-cols-3">
                {features.map((f) => (
                    <div key={f.title} className="rounded-lg border p-5 text-left">
                        <h3 className="font-medium">{f.title}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
                    </div>
                ))}
            </section>

            <footer className="mx-auto flex w-full max-w-4xl flex-col items-center gap-2 px-6 pb-8 text-sm text-muted-foreground">
                <Separator />
                <span>maxterview — free and premium practice interviews.</span>
            </footer>
        </div>
    );
}
