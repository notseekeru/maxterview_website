import { strict as assert } from "node:assert";
import { Hono } from "hono";
import { getCurrentUser } from "../auth.ts";
import { fetchrow, sql } from "../db.ts";
import { COMPANY_SIZES, CYNICISM, DIAL_FIELDS } from "../dials.ts";
import { config } from "../env.ts";
import { HttpError, jsonBody as jsonBodyText, validationError } from "../errors.ts";
import { LEVELS, label as levelLabel } from "../levels.ts";
import { type Analytics, type AnalyticsDial, type DashboardDims, type Dials, HIRING_DECISIONS, type Offer, type OfferBenefit, type OfferBenefitStat, type OfferGroup, type OfferMonth, type OfferSummary, type OffersAnalytics, totalComp, VoiceText } from "../models.ts";
import { bandRange, ladder, startDate, TIERS, tier } from "../offer.ts";
import { grade, MOVE_CLASSES } from "../rating.ts";
import { capability, speak, transcribe, VoiceError } from "../voice.ts";

export const voice = new Hono();

voice.get("/voice", async (c) => {
    await getCurrentUser(c);
    return c.json(capability());
});

voice.post("/voice/tts", async (c) => {
    await getCurrentUser(c);
    const body = VoiceText.safeParse(jsonBodyText(await c.req.text()));
    if (!body.success) throw validationError(body.error);
    try {
        const speech = await speak(body.data.text);
        // A copy: the cached clip is a view over a Buffer pool, and the body type wants its own buffer.
        return c.body(new Uint8Array(speech.audio), 200, { "content-type": speech.media_type, "cache-control": "no-store" });
    } catch (error) {
        if (error instanceof VoiceError) throw new HttpError(503, error.message);
        throw error;
    }
});

voice.post("/voice/stt", async (c) => {
    await getCurrentUser(c);
    // A body that is not multipart is the missing upload, as FastAPI read it; it is not a 500.
    const form: Record<string, string | File> = await c.req.parseBody().catch(() => ({}));
    const upload = form.file;
    if (!(upload instanceof File)) throw new HttpError(422, [{ loc: ["body", "file"], msg: "Field required" }]);
    const data = new Uint8Array(await upload.arrayBuffer());
    if (data.length > config.voiceMaxUploadBytes) {
        throw new HttpError(413, `That recording is larger than ${Math.floor(config.voiceMaxUploadBytes / (1024 * 1024))} MB.`);
    }
    try {
        return c.json(await transcribe(data));
    } catch (error) {
        if (error instanceof VoiceError) throw new HttpError(503, error.message);
        throw error;
    }
});

// Dashboard stats: aggregates, not per-row reads. The radar's second series spans the newest rated runs:
// one run's per-dim holes are noise.
const RECENT_WINDOW = 5;
const TREND_DOTS = 20;
const SPARK_DAYS = 14;
const DELTA_WINDOW = 5;

// No `archived_at` filter: the dashboard counts archived runs, so dropping them here would disagree with
// the numbers one route over.
function analyticsQuery(ownerId: string) {
    const hiring = sql`${HIRING_DECISIONS[0]}, ${HIRING_DECISIONS[1]}`;
    return sql`
WITH counts AS MATERIALIZED (
    SELECT m.interview_id, m.role, m.move_class, count(*) AS n
    FROM chat_turns m
    JOIN interviews i ON i.id = m.interview_id
    WHERE i.owner_id = ${ownerId}
    GROUP BY m.interview_id, m.role, m.move_class
), turn_totals AS MATERIALIZED (
    SELECT interview_id, sum(n) AS turns FROM counts WHERE role = 'user' GROUP BY interview_id
), move_totals AS MATERIALIZED (
    SELECT interview_id, jsonb_object_agg(move_class, n) AS moves
    FROM (SELECT interview_id, move_class, sum(n) AS n FROM counts WHERE move_class IS NOT NULL GROUP BY interview_id, move_class) c
    GROUP BY interview_id
), runs AS (
    SELECT i.id::text, i.role, i.level, i.status, i.created_at,
           i.company_size, i.cynicism, i.brutally_honest, i.human_mode, i.hardcore, i.depth,
           f.accuracy, f.decision, f.certainty, f.scores, i.failed_class,
           coalesce(tt.turns, 0) AS turns,
           coalesce(mt.moves, '{}'::jsonb) AS moves
    FROM interviews i
    LEFT JOIN feedback f ON f.interview_id = i.id
    LEFT JOIN turn_totals tt ON tt.interview_id = i.id
    LEFT JOIN move_totals mt ON mt.interview_id = i.id
    WHERE i.owner_id = ${ownerId}
), activity AS (
    SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
           count(*) AS started,
           count(*) FILTER (WHERE status = 'completed') AS completed
    FROM interviews
    WHERE owner_id = ${ownerId} AND created_at >= now() - interval '12 weeks'
    GROUP BY 1
), completed AS (
    SELECT * FROM runs WHERE status = 'completed'
), dials AS (
    SELECT dial, value, count(*) AS runs, count(accuracy) AS rated,
           ROUND(avg(accuracy)::numeric, 1) AS avg_accuracy,
           (100.0 * count(*) FILTER (WHERE decision IN (${hiring})) / nullif(count(decision), 0))::int AS hire_rate
    FROM (
        SELECT 'level' AS dial, level AS value, accuracy, decision FROM completed
        UNION ALL SELECT 'cynicism', cynicism, accuracy, decision FROM completed
        UNION ALL SELECT 'company_size', company_size, accuracy, decision FROM completed
        UNION ALL SELECT 'depth', depth, accuracy, decision FROM completed
        UNION ALL SELECT 'hardcore', CASE WHEN hardcore THEN 'hardcore' ELSE 'standard' END, accuracy, decision FROM completed
        UNION ALL SELECT 'honesty', CASE WHEN brutally_honest THEN 'brutally_honest' ELSE 'diplomatic' END, accuracy, decision FROM completed
        UNION ALL SELECT 'register', CASE WHEN human_mode THEN 'human' ELSE 'corporate' END, accuracy, decision FROM completed
    ) labelled
    GROUP BY dial, value
), offers AS (
    SELECT o.interview_id::text, o.title, o.band, o.base_salary, o.signing_bonus, o.equity, o.performance,
           o.benefits, o.created_at, i.role, i.level, i.failed_class, f.accuracy, f.decision
    FROM offers o
    JOIN interviews i ON i.id = o.interview_id
    LEFT JOIN feedback f ON f.interview_id = o.interview_id
    WHERE i.owner_id = ${ownerId}
), streak AS (
    WITH days AS (
        SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM interviews WHERE owner_id = ${ownerId}
    ), ranked AS (
        SELECT d, (CURRENT_DATE - d) AS gap, row_number() OVER (ORDER BY d DESC) AS rn FROM days
    )
    SELECT count(*) AS days FROM ranked WHERE gap - rn IN (-1, 0)
)
SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]') FROM runs r) AS runs,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.week), '[]') FROM activity a) AS activity,
    (SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]') FROM dials d) AS dials,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC), '[]') FROM offers o) AS offers,
    (SELECT days FROM streak) AS streak_days
`;
}

voice.get("/stats/analytics", async (c) => {
    const user = await getCurrentUser(c);
    // AI HERE: one checkout instead of five. The five CTEs still scan the owner's history; the upgrade is a rollup.
    const row = await fetchrow(analyticsQuery(user.sub));
    assert(row !== undefined);

    const runs: Analytics["runs"] = [];
    const moveClasses: Record<string, number> = Object.fromEntries(MOVE_CLASSES.map((cls) => [cls, 0]));
    let totalTurns = 0;
    let hardcoreFailures = 0;
    for (const r of row.runs) {
        for (const cls of MOVE_CLASSES) moveClasses[cls] += r.moves[cls] ?? 0;
        totalTurns += r.turns;
        hardcoreFailures += r.failed_class ? 1 : 0;
        runs.push({
            id: r.id,
            role: r.role,
            level: r.level,
            status: r.status,
            created_at: r.created_at,
            accuracy: r.accuracy,
            grade: grade(r.accuracy, r.failed_class !== null),
            decision: r.decision,
            certainty: r.certainty,
            failed_class: r.failed_class,
            dials: Object.fromEntries(DIAL_FIELDS.map((field) => [field, r[field]])) as Dials,
            scores: r.scores ?? {},
            turns: r.turns,
            moves: r.moves,
        });
    }

    const payload: Analytics = {
        runs,
        activity: row.activity,
        move_classes: moveClasses,
        dials: dialGroups(row.dials),
        total_turns: totalTurns,
        streak_days: Number(row.streak_days ?? 0),
        hardcore_failures: hardcoreFailures,
        offers: offerBoard(row.offers.map((r: OfferRaw) => offerRow(r))),
    };
    return c.json(payload);
});

// Key -> (value slug -> label), in render order. Vocabularies come from src/dials.ts and src/levels.ts, so
// a new slug shows up before its label does. This table owns ORDER and labels only.
function labelled(slugs: readonly string[], labels: readonly string[]): Record<string, string> {
    assert.equal(slugs.length, labels.length);
    return Object.fromEntries(slugs.map((slug, index) => [slug, labels[index]]));
}

const ANALYTICS_DIALS: [string, Record<string, string>][] = [
    ["level", Object.fromEntries(LEVELS.map((slug) => [slug, levelLabel(slug)]))],
    ["cynicism", labelled(CYNICISM, ["Kind", "Neutral", "Skeptical"])],
    ["company_size", labelled(COMPANY_SIZES, ["Any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+"])],
    ["depth", { screen: "Screen", standard: "Standard", full: "Full loop" }],
    ["hardcore", { hardcore: "Hardcore", standard: "Standard" }],
    ["honesty", { brutally_honest: "Brutally honest", diplomatic: "Diplomatic" }],
    ["register", { human: "Human", corporate: "Corporate" }],
];

type DialRow = { dial: string; value: string; runs: number; rated: number; avg_accuracy: number | null; hire_rate: number | null };

function dialGroups(rows: DialRow[]): Record<string, AnalyticsDial[]> {
    const seen = new Map<string, Map<string, Omit<AnalyticsDial, "key" | "label">>>();
    for (const r of rows) {
        let values = seen.get(r.dial);
        if (values === undefined) {
            values = new Map();
            seen.set(r.dial, values);
        }
        values.set(r.value, { runs: r.runs, rated: r.rated, avg_accuracy: r.avg_accuracy, hire_rate: r.hire_rate });
    }
    const groups: Record<string, AnalyticsDial[]> = {};
    for (const [key, labels] of ANALYTICS_DIALS) {
        const values = seen.get(key) ?? new Map<string, Omit<AnalyticsDial, "key" | "label">>();
        seen.delete(key);
        const rank = new Map(Object.keys(labels).map((value, index) => [value, index]));
        groups[key] = [...values].sort(([a], [b]) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)).map(([value, meta]) => ({ key: value, label: labels[value] ?? value, ...meta }));
    }
    return groups;
}

// The radar in ONE row: two averages (all rated runs, the newest RECENT_WINDOW) plus their counts.
// Finished AND scored only: accuracy lives on feedback, not interviews. ROUND(...,1) matches the UI.
function dashboardQuery(ownerId: string) {
    const hiring = sql`${HIRING_DECISIONS[0]}, ${HIRING_DECISIONS[1]}`;
    return sql`
WITH owned AS (
    SELECT i.created_at, i.status, f.accuracy, f.decision, f.certainty, f.scores
    FROM interviews i
    LEFT JOIN feedback f ON f.interview_id = i.id
    WHERE i.owner_id = ${ownerId}
), rated AS (
    SELECT created_at, accuracy FROM owned WHERE status = 'completed' AND accuracy IS NOT NULL
), decided AS (
    SELECT created_at, decision, certainty FROM owned WHERE status = 'completed' AND decision IS NOT NULL
), aged AS (
    SELECT CURRENT_DATE - (created_at AT TIME ZONE 'UTC')::date AS age, status FROM owned
), ages AS (
    SELECT generate_series(${SPARK_DAYS - 1}::int, 0, -1) AS age
), days AS (
    SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM owned
), ranked AS (
    SELECT (CURRENT_DATE - d) - row_number() OVER (ORDER BY d DESC) AS gap FROM days
), dim_runs AS (
    SELECT created_at, scores FROM owned WHERE status = 'completed' AND accuracy IS NOT NULL
), dim_recent AS (
    SELECT scores FROM dim_runs ORDER BY created_at DESC LIMIT ${RECENT_WINDOW}
)
SELECT
    (SELECT count(*) FROM owned) AS total,
    (SELECT count(*) FROM owned WHERE status = 'completed') AS completed,
    (SELECT count(*) FROM rated) AS rated,
    (SELECT coalesce(avg(accuracy), 0) FROM rated) AS avg_accuracy,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('created_at', t.created_at, 'accuracy', t.accuracy) ORDER BY t.created_at), '[]')
       FROM (SELECT created_at, accuracy FROM rated ORDER BY created_at DESC LIMIT ${TREND_DOTS}) t) AS accuracy_trend,
    (SELECT count(*) FROM decided) AS decided,
    (SELECT count(*) FROM decided WHERE decision IN (${hiring})) AS hiring,
    (SELECT round(avg(certainty)) FROM decided WHERE certainty IS NOT NULL) AS avg_certainty,
    (SELECT count(*) FROM aged WHERE age >= 0 AND age < 7) AS week_runs,
    (SELECT count(*) FROM aged WHERE age >= 7 AND age < 14) AS prior_week_runs,
    (SELECT count(*) FROM aged WHERE status = 'completed' AND age >= 0 AND age < 7) AS week_finished,
    (SELECT count(*) FROM aged WHERE status = 'completed' AND age >= 7 AND age < 14) AS prior_week_finished,
    (SELECT count(*) FROM ranked WHERE gap IN (-1, 0)) AS streak,
    (SELECT min(age) FROM aged) AS last_run_days,
    (SELECT CASE WHEN count(*) >= ${DELTA_WINDOW * 2}
                 THEN avg(accuracy) FILTER (WHERE rn <= ${DELTA_WINDOW}) - avg(accuracy) FILTER (WHERE rn > ${DELTA_WINDOW} AND rn <= ${DELTA_WINDOW * 2}) END
       FROM (SELECT accuracy, row_number() OVER (ORDER BY created_at DESC) AS rn FROM rated) x) AS delta_accuracy,
    (SELECT CASE WHEN count(*) >= ${DELTA_WINDOW * 2}
                 THEN avg(hit) FILTER (WHERE rn <= ${DELTA_WINDOW}) - avg(hit) FILTER (WHERE rn > ${DELTA_WINDOW} AND rn <= ${DELTA_WINDOW * 2}) END
       FROM (SELECT CASE WHEN decision IN (${hiring}) THEN 100.0 ELSE 0.0 END AS hit,
                    row_number() OVER (ORDER BY created_at DESC) AS rn FROM decided) x) AS delta_hire,
    (SELECT coalesce(jsonb_agg(n ORDER BY age DESC), '[]')
       FROM (SELECT a.age, count(o.age) AS n FROM ages a LEFT JOIN aged o ON o.age = a.age GROUP BY a.age) z) AS daily_runs,
    (SELECT coalesce(jsonb_agg(n ORDER BY age DESC), '[]')
       FROM (SELECT a.age, count(o.age) AS n FROM ages a LEFT JOIN aged o ON o.age = a.age AND o.status = 'completed' GROUP BY a.age) z) AS daily_finished,
    (SELECT coalesce(jsonb_agg(100.0 * hits / i ORDER BY i), '[]')
       FROM (SELECT i, sum(hit) OVER (ORDER BY i) AS hits
               FROM (SELECT row_number() OVER (ORDER BY created_at) AS i,
                            CASE WHEN decision IN (${hiring}) THEN 1 ELSE 0 END AS hit FROM decided) d) s
      WHERE i > (SELECT count(*) FROM decided) - ${TREND_DOTS}) AS hire_spark,
    (SELECT count(*) FROM dim_runs) AS count,
    (SELECT least((SELECT count(*) FROM dim_runs), ${RECENT_WINDOW})) AS recent_n,
    (SELECT coalesce(jsonb_object_agg(d, avg_val), '{}'::jsonb)
       FROM (SELECT s.dim AS d, ROUND(avg(s.value::numeric), 1) AS avg_val
               FROM dim_runs, jsonb_each_text(dim_runs.scores) AS s(dim, value)
              GROUP BY s.dim) per_dim) AS averages,
    (SELECT coalesce(jsonb_object_agg(d, avg_val), '{}'::jsonb)
       FROM (SELECT s.dim AS d, ROUND(avg(s.value::numeric), 1) AS avg_val
               FROM dim_recent, jsonb_each_text(dim_recent.scores) AS s(dim, value)
              GROUP BY s.dim) per_dim_recent) AS recent
`;
}

voice.get("/stats/dashboard", async (c) => {
    const user = await getCurrentUser(c);
    const row = await fetchrow(dashboardQuery(user.sub));
    assert(row !== undefined);
    // int8 and numeric reach JS as text, and the model that used to read them took ints and floats:
    // a raw row would put digit strings on the charts.
    const dims: DashboardDims = {
        total: Number(row.total),
        completed: Number(row.completed),
        rated: Number(row.rated),
        avg_accuracy: Number(row.avg_accuracy),
        accuracy_trend: row.accuracy_trend,
        decided: Number(row.decided),
        hiring: Number(row.hiring),
        avg_certainty: row.avg_certainty === null ? null : Number(row.avg_certainty),
        week_runs: Number(row.week_runs),
        prior_week_runs: Number(row.prior_week_runs),
        week_finished: Number(row.week_finished),
        prior_week_finished: Number(row.prior_week_finished),
        streak: Number(row.streak),
        last_run_days: row.last_run_days,
        delta_accuracy: row.delta_accuracy === null ? null : Number(row.delta_accuracy),
        delta_hire: row.delta_hire === null ? null : Number(row.delta_hire),
        daily_runs: row.daily_runs,
        daily_finished: row.daily_finished,
        hire_spark: row.hire_spark,
        count: Number(row.count),
        recent_n: Number(row.recent_n),
        averages: row.averages,
        recent: row.recent,
    };
    return c.json(dims);
});

// One row of the offer aggregate: the letter, its run and its review, joined.
type OfferRaw = {
    interview_id: string;
    title: string;
    band: string;
    base_salary: number;
    signing_bonus: number;
    equity: number;
    performance: number;
    benefits: OfferBenefit[] | null;
    created_at: string;
    role: string;
    level: string;
    failed_class: string | null;
    accuracy: number | null;
    decision: Offer["decision"];
};

function offerRow(r: OfferRaw): Offer {
    const [floor, ceiling] = bandRange(r.band);
    const [tierSlug, tierLabel] = tier(r.performance);
    return {
        interview_id: r.interview_id,
        role: r.role,
        level: r.level,
        title: r.title,
        band: r.band,
        band_low: floor,
        band_high: ceiling,
        base_salary: r.base_salary,
        signing_bonus: r.signing_bonus,
        equity: r.equity,
        performance: r.performance,
        tier: tierSlug,
        tier_label: tierLabel,
        benefits: r.benefits ?? [],
        accuracy: r.accuracy,
        grade: grade(r.accuracy, r.failed_class !== null),
        decision: r.decision,
        created_at: r.created_at,
        starts_on: startDate(new Date(r.created_at)),
        total_comp: totalComp(r),
    };
}

const EMPTY_SUMMARY: OfferSummary = {
    count: 0,
    avg_base: 0,
    median_base: 0,
    low_base: 0,
    high_base: 0,
    avg_total: 0,
    low_total: 0,
    high_total: 0,
    avg_signing: 0,
    avg_equity: 0,
    avg_performance: 0,
    avg_benefits: 0,
    best_id: null,
    worst_id: null,
};

function offerSummary(rows: Offer[]): OfferSummary {
    if (rows.length === 0) return EMPTY_SUMMARY;
    const bases = rows.map((r) => r.base_salary).sort((a, b) => a - b);
    const totals = rows.map((r) => r.total_comp).sort((a, b) => a - b);
    let best = rows[0];
    let worst = rows[0];
    for (const r of rows) {
        if (r.total_comp > best.total_comp) best = r;
        if (r.total_comp < worst.total_comp) worst = r;
    }
    return {
        count: rows.length,
        avg_base: round(fmean(bases)),
        median_base: round(median(bases)),
        low_base: bases[0],
        high_base: bases[bases.length - 1],
        avg_total: round(fmean(totals)),
        low_total: totals[0],
        high_total: totals[totals.length - 1],
        avg_signing: round(fmean(rows.map((r) => r.signing_bonus))),
        avg_equity: round(fmean(rows.map((r) => r.equity))),
        avg_performance: round(fmean(rows.map((r) => r.performance))),
        avg_benefits: round(fmean(rows.map((r) => r.benefits.length)), 1),
        best_id: best.interview_id,
        worst_id: worst.interview_id,
    };
}

function offerGroups(rows: Offer[], buckets: [string, string][], keyOf: (offer: Offer) => string): OfferGroup[] {
    const groups: OfferGroup[] = [];
    for (const [key, label] of buckets) {
        const group = rows.filter((r) => keyOf(r) === key);
        if (group.length === 0) continue;
        const bases = group.map((r) => r.base_salary).sort((a, b) => a - b);
        groups.push({
            key,
            label,
            offers: group.length,
            avg_base: round(fmean(bases)),
            low_base: bases[0],
            high_base: bases[bases.length - 1],
            span: bases[bases.length - 1] - bases[0],
            avg_total: round(fmean(group.map((r) => r.total_comp))),
            avg_performance: round(fmean(group.map((r) => r.performance))),
        });
    }
    return groups;
}

function offerBenefits(rows: Offer[]): OfferBenefitStat[] {
    const counted = new Map<string, number>();
    for (const r of rows) for (const benefit of r.benefits) counted.set(benefit.key, (counted.get(benefit.key) ?? 0) + 1);
    const total = rows.length || 1;
    return ladder().map(([key, label]) => {
        const offers = counted.get(key) ?? 0;
        return { key, label, offers, rate: round((100 * offers) / total) };
    });
}

function offerActivity(rows: Offer[]): OfferMonth[] {
    const months = new Map<string, number[]>();
    for (const r of rows) {
        const month = new Date(r.created_at).toISOString().slice(0, 7);
        const bases = months.get(month);
        if (bases === undefined) months.set(month, [r.base_salary]);
        else bases.push(r.base_salary);
    }
    return [...months.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, bases]) => ({ month, offers: bases.length, avg_base: round(fmean(bases)) }));
}

function offerBoard(rows: Offer[]): OffersAnalytics {
    return {
        summary: offerSummary(rows),
        offers: rows,
        by_level: offerGroups(
            rows,
            LEVELS.map((slug): [string, string] => [slug, levelLabel(slug)]),
            (offer) => offer.band,
        ),
        by_tier: offerGroups(
            rows,
            TIERS.map(([key, , label]): [string, string] => [key, label]),
            (offer) => offer.tier,
        ),
        benefits: offerBenefits(rows),
        activity: offerActivity(rows),
    };
}

// AI HERE: Python's fmean sums with math.fsum and divides once. Every caller here feeds whole numbers,
// where a plain sum is already exact; the upgrade is Kahan summation if a float column ever reaches it.
function fmean(values: Iterable<number>): number {
    let total = 0;
    let count = 0;
    for (const value of values) {
        total += value;
        count += 1;
    }
    return total / count;
}

// Python averages the two middle values on an even count; taking either one is a different metric.
function median(values: number[]): number {
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

// Python's round() reads the double's exact value and breaks a tie to even. Math.round() and a scaled
// product both round a different number, which here is a wrong figure on a chart, not a cosmetic digit.
function round(value: number, digits = 0): number {
    if (!Number.isFinite(value)) return value;
    const magnitude = Math.abs(value);
    // AI HERE: past 2^53 the digit string is no longer exact; no metric in this app is that large.
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, magnitude);
    const high = view.getUint32(0);
    const mantissa = (1n << 52n) | (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));
    const exponent = ((high >>> 20) & 0x7ff) - 1075;
    const scale = 10n ** BigInt(digits);
    let numerator = mantissa * scale;
    let denominator = 1n;
    if (exponent >= 0) numerator *= 1n << BigInt(exponent);
    else denominator = 1n << BigInt(-exponent);
    let whole = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    if (twice > denominator || (twice === denominator && whole % 2n === 1n)) whole += 1n;
    const rounded = Number(whole) / Number(scale);
    return value < 0 ? -rounded : rounded;
}

// AI HERE: the framework-free self-check the Python import ran. A lower-middle median, a half-up round or
// a naive mean passes every type check and puts a wrong number on the analytics page.
assert.equal(median([3, 1, 2, 4]), 2.5);
assert.equal(median([3, 1, 2]), 2);
assert.equal(fmean([1, 2, 4]), 7 / 3);
assert.equal(round(12.5), 12);
assert.equal(round(13.5), 14);
assert.equal(round(125000.5), 125000);
assert.equal(round(1.05, 1), 1.1);
assert.equal(round(2.55, 1), 2.5);
