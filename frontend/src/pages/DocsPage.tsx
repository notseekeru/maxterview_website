import { Page, SectionHeading } from "@/components/PagePrimitives";
import { PLANS } from "@/lib/plans";

// /settings/docs — the in-app manual. Short on purpose: the nav labels and the form itself are the
// documentation for everything that is self-evident.
export function DocsPage() {
    return (
        <Page title="Docs" description="What a run gives you, where each thing lives, and what the plans include.">
            <section className="space-y-3">
                <SectionHeading title="How a run works" />
                <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                    <li>Start an interview: role, target level, question mix and interviewer stance. Presets and resumes are optional and remembered.</li>
                    <li>Answer one question at a time. The interviewer keeps the thread of what you already said.</li>
                    <li>Finish for a per-answer annotation, a 0-100 accuracy score with a letter grade, a hire or reject call with its certainty, and the offer letter that score would earn.</li>
                </ol>
            </section>

            <section className="space-y-3">
                <SectionHeading title="Where things live" />
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                    <li>Dashboard: your numbers at a glance, and the form for the next run.</li>
                    <li>Interviews: every run, with the actions that open, rescore, archive or delete one.</li>
                    <li>Resume: the text the interviewer reads, so follow-ups land on your actual background.</li>
                    <li>Analytics: accuracy over time, answer quality, dial comparisons, the run log and your offer letters.</li>
                    <li>Settings → System: theme, and your own model key (BYOK).</li>
                    <li>Settings → Account: your sign-in, and the plan you are on.</li>
                    <li>Settings → Billing: Free and {PLANS.premium.name} side by side, and the upgrade.</li>
                </ul>
            </section>

            <section className="space-y-3">
                <SectionHeading title="Plans" />
                <p className="text-sm leading-6 text-muted-foreground">
                    Interviews themselves are unlimited on both plans; the meter is on chat turns, which every question and follow-up spends. Free gives {PLANS.free.turns} turns a day, or {PLANS.free.byokTurns} on your own provider key. {PLANS.premium.name} raises that to {PLANS.premium.turns} a day (
                    {PLANS.premium.byokTurns} on your own key) and {PLANS.premium.resumes} saved resumes, for {PLANS.premium.price} per {PLANS.premium.term}. Turns reset at 00:00 UTC.
                </p>
            </section>
        </Page>
    );
}
