import { ComingSoon, Page } from "@/components/PagePrimitives";

// Placeholder routes whose backend work isn't built yet. Kept in one module so
// adding the real page later is a drop-in rename; each still gets its own <Page>
// title + empty-state (AI HERE: the only “logic” today is the nav entry landing).

export function AnalyticsPage() {
    return (
        <Page title="Analytics" description="Trends across your practice sessions.">
            {/* AI HERE: build on top of GET /interviews' completed runs (score trend). The
                Dashboard already draws a small trend; enrich it here with per-dimension
                history once a chart slice (or reuse recharts like ScoreTrendChart) lands. */}
            <ComingSoon icon="chart" title="Analytics coming soon" description="Your score-by-dimension history and progress chart will live here." />
        </Page>
    );
}

export function ResumePage() {
    return (
        <Page title="Resume" description="Upload and role practice against it.">
            {/* AI HERE: resume parsing/upload is a designed-but-not-built section (PRD). The
                interviewer already asks for resume text in the opening turn today. */}
            <ComingSoon icon="file" title="Resume scoring coming soon" description="Bring a PDF or pasted resume so interviews are tailored to it." />
        </Page>
    );
}

export function ManageAccountsPage() {
    return (
        <Page title="Managed Accounts" description="Admins only — list the accounts on a team/org.">
            {/* AI HERE: real multi-account support requires widening D4's single-owner
                scoping + the backend "accounts" model. Single-owner accounts are out of
                scope for MVP; see PRD Future notes. */}
            <ComingSoon icon="users" title="Managed accounts coming soon" description="Manage org roles/usage once team accounts exist." />
        </Page>
    );
}

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
                <p>Your free plan allows unlimited interviews; upgrade to Premium for more chat turns per interview.</p>
            </div>
        </Page>
    );
}
