import { Page, SectionHeading } from "@/components/PagePrimitives";
import { PLANS } from "@/lib/plans";

export function DocsPage() {
    return (
        <Page title="Docs" description="Guide and product notes.">
            <section className="space-y-3">
                <SectionHeading title="Where things live" />
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                    <li>Dashboard: start a new interview or see your performance at a glance.</li>
                    <li>Interviews: review, reopen or delete past sessions.</li>
                    <li>Resume: keep role-specific resumes so the interviewer asks about your actual background.</li>
                    <li>Analytics: accuracy trend, move breakdown, dial comparisons and your offer letters.</li>
                    <li>Settings → System: theme and your own model key (BYOK), which raises the daily ceiling.</li>
                    <li>Settings → Account: your sign-in, plus a plan summary.</li>
                    <li>Settings → Billing: compare Free and {PLANS.premium.name} and upgrade.</li>
                </ul>
            </section>

            <section className="space-y-3">
                <SectionHeading title="Plans" />
                <p className="text-sm leading-6 text-muted-foreground">
                    Free includes unlimited interviews and {PLANS.free.turns} chat turns a day. {PLANS.premium.name} raises that to {PLANS.premium.turns} turns a day and {PLANS.premium.resumes} resume slots, one payment for {PLANS.premium.term}.
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                    Reviewing a finished run again costs one redo: {PLANS.free.redos} per run on Free, {PLANS.premium.redos} on {PLANS.premium.name}.
                </p>
            </section>
        </Page>
    );
}
