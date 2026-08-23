import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInterview } from "@/lib/api";

interface Props {
    onCreated: (id: string) => void;
}

export function CreateInterviewForm({ onCreated }: Props) {
    const [role, setRole] = useState("");
    const [topic, setTopic] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!role.trim()) {
            setError("Role is required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const interview = await createInterview(role.trim(), topic.trim());
            onCreated(interview.id);
        } catch {
            setError("Failed to create interview. Is the backend running?");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card className="w-full max-w-lg">
            <form onSubmit={submit}>
                <CardHeader>
                    <CardTitle>New interview</CardTitle>
                    <CardDescription>Start a simulated interview with an AI coach.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="role">Role</Label>
                        <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Software Engineer" required />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="topic">Topic (optional)</Label>
                        <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. system design" />
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
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
