import { Page } from "@/components/PagePrimitives";

export function DocsPage() {
    return (
        <Page title="Docs" description="Guide & product notes.">
            <div className="space-y-4 text-sm leading-6 text-muted-foreground">
                <p>maxterview is an AI mock-interview coach. Start an interview, practice one question at a time, then get per-question and final feedback plus a score.</p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>Dashboard — start a new interview or see your performance at a glance.</li>
                    <li>Interviews — review, reopen or delete past sessions.</li>
                    <li>Settings → System — appearance theme and future defaults.</li>
                    <li>Settings → Account — your sign-in, plus a Plan summary.</li>
                    <li>Settings → Billing — compare plans and upgrade.</li>
                </ul>
                <p>Your free plan allows unlimited interviews; upgrade to Premium for a larger daily chat credits.</p>
            </div>
        </Page>
    );
}
