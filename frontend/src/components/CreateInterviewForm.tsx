import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInterview, isQuotaError } from "@/lib/api";
import { LEVELS, ROLE_PRESETS } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
import { UpgradeNotice } from "./UsageBadge";

type Variant = "compact" | "featured";

interface Props {
    onCreated: (id: string) => void;
    variant?: Variant;
    className?: string;
}

export function CreateInterviewForm({ onCreated, variant = "compact", className }: Props) {
    // "featured" sheds the width cap and lets Role + Topic span both columns.
    const featured = variant === "featured";
    const [role, setRole] = useState("");
    const [level, setLevel] = useState("any");
    const [topic, setTopic] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [quotaLocked, setQuotaLocked] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!role.trim()) {
            setError("Role is required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const interview = await createInterview(role.trim(), topic.trim(), level);
            onCreated(interview.id);
        } catch (e) {
            if (isQuotaError(e)) setQuotaLocked(true);
            else setError("Failed to create interview. Is the backend running?");
            setBusy(false);
        }
    }

    return (
        <Card className={cn(featured ? "w-full" : "w-full max-w-lg", className)}>
            <form onSubmit={submit}>
                <CardHeader>
                    <CardTitle>New interview</CardTitle>
                    <CardDescription>Start a simulated interview with an AI coach.</CardDescription>
                </CardHeader>
                <CardContent className={featured ? "grid gap-x-4 gap-y-4 sm:grid-cols-2" : "space-y-4"}>
                    <div className={cn("space-y-1.5", featured && "sm:col-span-2")}>
                        <Label htmlFor="role">Role</Label>
                        <div className="flex flex-wrap gap-1.5">
                            {ROLE_PRESETS.slice(0, 6).map((preset) => (
                                <button
                                    key={preset}
                                    type="button"
                                    onClick={() => {
                                        setError(null);
                                        setRole(preset);
                                    }}
                                    className={cn("rounded-full border px-3 py-1 text-xs transition-colors", role === preset ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-accent")}
                                >
                                    {preset}
                                </button>
                            ))}
                        </div>
                        <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Software Engineer — or pick a preset above" required />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="level">Level {level === "any" && <span className="text-xs font-normal text-muted-foreground">· AI adapts to you</span>}</Label>
                        <select id="level" value={level} onChange={(e) => setLevel(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                            {LEVELS.map((l) => (
                                <option key={l.value} value={l.value}>
                                    {l.label}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="topic">Topic (optional)</Label>
                        <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. system design" />
                    </div>
                    {(error || quotaLocked) && (
                        <div className={cn("space-y-2", featured && "sm:col-span-2")}>
                            {error && <p className="text-sm text-destructive">{error}</p>}
                            {quotaLocked && <UpgradeNotice reason="your free daily interview quota ran out." />}
                        </div>
                    )}
                </CardContent>
                <CardFooter>
                    <Button type="submit" disabled={busy}>
                        {busy ? "Creating..." : "Start interview"}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}
