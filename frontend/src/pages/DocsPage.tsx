import { Page } from "@/components/PagePrimitives";
import { PLANS } from "@/lib/plans";

export function DocsPage() {
    return (
        <Page title="Docs" description="Guide and product notes.">
            <div className="space-y-4 text-sm leading-6 text-muted-foreground">
                <p>maxterview is an AI mock-interview coach. Start an interview, practice one question at a time, then get per-question and final feedback plus a score.</p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>Dashboard: start a new interview or see your performance at a glance.</li>
                    <li>Interviews: review, reopen or delete past sessions.</li>
                    <li>Resume: keep role-specific resumes so the interviewer asks about your actual background.</li>
                    <li>Analytics: accuracy trend, move breakdown, dial comparisons and your offer letters.</li>
                    <li>Settings → System: theme and your own model key (BYOK).</li>
                    <li>Settings → Account: your sign-in, plus a plan summary.</li>
                    <li>Settings → Billing: compare Free and {PLANS.premium.name} and upgrade.</li>
                </ul>
                <p>
                    Free includes unlimited interviews and {PLANS.free.turns} chat turns a day. {PLANS.premium.name} raises that to {PLANS.premium.turns} turns a day and {PLANS.premium.resumes} resume slots, one payment for {PLANS.premium.term}.
                </p>
            </div>
        </Page>
    );
}
