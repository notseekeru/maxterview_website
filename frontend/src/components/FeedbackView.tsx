import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Feedback } from "@/lib/api";

export function FeedbackView({ feedback }: { feedback: Feedback }) {
    const dims = Object.entries(feedback.scores ?? {});

    return (
        <div className="space-y-4 p-6">
            <Card>
                <CardHeader>
                    <CardTitle>Feedback</CardTitle>
                    <CardDescription>Your performance summary</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm leading-relaxed">{feedback.verdict}</p>

                    {dims.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-sm font-medium">Scores</p>
                            {dims.map(([key, value]) => (
                                <div key={key} className="flex items-center gap-2">
                                    <span className="w-28 text-sm capitalize">{key}</span>
                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, (value / 10) * 100))}%` }} />
                                    </div>
                                    <span className="w-6 text-right text-sm">{value}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {Array.isArray(feedback.tips) && feedback.tips.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-sm font-medium">Tips</p>
                            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                                {feedback.tips.map((tip) => (
                                    <li key={tip}>{tip}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
