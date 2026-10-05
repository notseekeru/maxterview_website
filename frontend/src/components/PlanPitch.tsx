import { Icon } from "@/components/AppIcons";
import { chatTurns, type Usage } from "@/lib/api";
import { PLANS } from "@/lib/plans";

type PlanTier = "free" | "premium";

const RUN_TURNS = 9;
const MAX_RUN_TURNS = 15;

function caps(tier: PlanTier, usage: Usage | null): { turns: number; resumes: number } {
    if (usage && usage.tier === tier && !usage.byok && usage.resume_limit) return { turns: chatTurns(usage), resumes: usage.resume_limit };
    return { turns: PLANS[tier].turns, resumes: PLANS[tier].resumes };
}

export function PlanPitch({ tier, usage }: { tier: PlanTier; usage?: Usage | null }) {
    const plan = PLANS[tier];
    const { turns, resumes } = caps(tier, usage ?? null);
    const runs = Math.floor(turns / RUN_TURNS);
    const includes =
        tier === "free"
            ? [`${turns} chat turns a day, about ${runs === 1 ? "one finished run" : `${runs} finished runs`}`, `${resumes} resume slot`, "Review, verdict and analytics on every run"]
            : [`${turns} chat turns a day, about ${runs} finished runs`, `${resumes} resume slots to keep, and swap between`, "Higher BYOK Limits", "Subject to higher quality model"];
    return (
        <div className="flex flex-col gap-5">
            <p className="text-sm leading-relaxed text-muted-foreground">{plan.audience}</p>
            <p className="flex items-baseline gap-2">
                <span className="font-serif text-4xl tabular-nums tracking-[-0.03em] text-foreground">{plan.price}</span>
                <span className="text-sm text-muted-foreground">{plan.term ? `/ ${plan.term}` : "forever"}</span>
            </p>
            <div>
                <p className="text-xs text-muted-foreground">{tier === "free" ? "Get started with:" : `Everything in ${PLANS.free.name}, plus:`}</p>
                <ul className="mt-3 space-y-2.5 text-sm">
                    {includes.map((text) => (
                        <Item key={text} text={text} />
                    ))}
                    {tier === "free" && turns < MAX_RUN_TURNS && <Item text="One run with every question dial maxed" ok={false} />}
                </ul>
            </div>
        </div>
    );
}

function Item({ text, ok = true }: { text: string; ok?: boolean }) {
    return (
        <li className="flex items-start gap-2.5">
            <Icon name={ok ? "complete" : "x"} className={ok ? "mt-0.5 size-4 shrink-0 text-success" : "mt-0.5 size-4 shrink-0 text-muted-foreground"} />
            {/* The glyph is aria-hidden, so the row has to say which list it belongs to out loud. */}
            <span className="sr-only">{ok ? "Included: " : "Not included: "}</span>
            <span className={ok ? undefined : "text-muted-foreground"}>{text}</span>
        </li>
    );
}
