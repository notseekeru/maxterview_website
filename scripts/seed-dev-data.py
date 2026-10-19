from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO = __file__.rsplit("/", 2)[0]
sys.path.insert(0, REPO + "/backend/src")


def app_modules():
    from app import dials, levels, llm, offer, rating

    return llm, rating, dials, levels, offer


def _dials():
    return app_modules()[2]


def _levels():
    return app_modules()[3]


def _offer():
    return app_modules()[4]


CANDIDATES = (
    {
        "role": "Backend Engineer",
        "level": "mid",
        "topic": "payments and event-driven services",
        "opening": "Sure. 5 years backend, mostly Go and Python. At Kitomba I owned the billing service - Stripe and PayMongo integrations, then a rewrite that moved invoice generation to an event-driven worker. Cut p99 invoice generation from 40s to 900ms and dropped duplicate-charge incidents to zero over two quarters. Before that, two years on a Django monolith doing booking APIs.",
        "answers": (
            "The strongest disagreement I had was with our head of support over auto-refunds. She wanted every failed webhook to auto-refund within an hour; I argued that silent refunds hide the underlying bug and we would keep shipping the same failure. We compromised: auto-refund only for duplicate-charge cases, everything else paged a human. I instrumented the webhook handler so each case was labelled, and after six weeks the data showed 8 of 9 refunds were genuine duplicates, so I stopped arguing and moved the rest to auto too.",
            "I broke prod on Black Friday. I had added a filter to the queue consumer without checking what the legacy producer emitted, so it silently dropped 12% of payment events. I found it 40 minutes in from a support spike, not a metric - that was the real failure. I fixed the filter, replayed the dropped events from the DLQ, then wrote a contract test between producer and consumer and added a DLQ-depth alarm, since the alarm existing and not firing was the actual gap.",
            "I took hard feedback about my code reviews. My staff engineer told me my comments were technically right and useless - I would say 'this is racy' and stop, so people had to guess the fix. She asked me to write the fix or ask a question instead. First two weeks it slowed me down a lot. Six months on my review turnaround halved and two junior engineers told me my reviews were the most useful they got.",
            "I owned our move off a single Postgres box. I made the call to stay on Postgres longer than the team wanted and use logical replication to a read replica first, because the alternative was a Cassandra migration nobody on the team had run before. I wrote the replication runbook, ran the cutover at 3am myself, and stayed for the rollback decision. Read load went from 100% on primary to 70/30, and we deferred the migration by a year.",
            "Idempotency. A retried write has to land exactly once, so the request carries a key, the server stores the key with the result in the same transaction as the write, and a replay returns the stored result instead of redoing the work. The failure modes are the interesting part: the key has to expire or the table grows forever, and if the response is lost after commit the client must be able to poll the key rather than retry blindly. We used that for charge creation and it is why duplicate charges went to zero.",
            "Design a payment reconciliation system where the provider's ledger and ours disagree. I would start by bounding the problem: how often, how much money, and is it a timing skew or a real divergence. The obvious approach - a nightly full diff - is what I would not do, because a day of drift at our volume was millions of rows. Instead I would reconcile per-settlement-window on the provider's own identifiers, treat anything that matches as done, and only then fan out a diff on the remainder, which is small. Divergences get classified as timing, rounding or genuine, and only the last one pages anyone.",
            "The incident I would change before rollout was a config flag. We shipped a retry-policy change behind an env var, which is not a rollout - it is a coin flip at deploy time. It worked in staging, then in prod half the fleet picked up the old value because the config was cached at boot. I would put it behind a remote-config flag with a per-instance read and a metric on which value each instance is running, so rollback is a toggle and not a redeploy.",
            "When I check my own work I write the failing test first, and if I cannot make it fail for the right reason I do not trust the feature. The one that still stings: I shipped a pagination cursor that was fine in tests because the fixture had unique timestamps, and duplicated rows in prod where two records shared a timestamp. If it broke for a user, I would look at the query plan before the logs - most of our page-level bugs were ordering, not data.",
        ),
    },
    {
        "role": "Senior Product Manager",
        "level": "senior",
        "topic": "B2B SaaS roadmap and pricing",
        "opening": "I have been a PM for eight years, the last four at a 60-person B2B SaaS company doing workforce scheduling. I own the scheduling and compliance surface - roughly 40% of ARR. I ran the repricing that moved us from seat-based to usage-based for API customers, which added 18% net revenue retention in three quarters without a single logo churning over it.",
        "answers": (
            "The biggest conflict was with our head of sales over a custom enterprise feature. He had a six-figure deal contingent on a scheduling rule only that customer needed; I said building it would fork the product and we would maintain it for one logo. I lost the first round. What changed it was asking for the deal broken out by ARR and by how many of the next ten prospects would need the same rule - one of ten. We shipped it as a configurable rule with a paid add-on instead, and the customer signed.",
            "The mistake I own is our mobile launch. I let a loud internal stakeholder convince me the field supervisors needed a native app, so we spent a quarter on it. Actual usage was 6% of supervisors; everyone else used the mobile web we already had. I had the qualitative feedback and skipped the quantitative check because the stakeholder was senior. After that I added a rule for myself: any feature over a sprint's worth of work needs a measurable behavioural hypothesis written down before it starts.",
            "I owned our SOC 2 readiness end to end. I decided we would do the security work ourselves rather than buy a compliance platform, because we had two engineers who had been through it and the platform cost more than the eng time. I scoped the controls, negotiated the audit window with the auditor, and made the call to delay a customer-facing feature by three weeks to hit it. We passed with no exceptions, and it unblocked three enterprise deals that were stuck on the questionnaire.",
            "The hardest feedback I got was that I was a bottleneck on decisions. My VP told me that every design doc in my area waited on me, and that being right was not worth the queue. She asked me to name a default decision and let teams proceed unless they disagreed. I hated it and it worked: decision latency dropped from days to hours and two of my team's better calls were ones I would have overridden.",
            "Retention measured properly is whether the behaviour the product exists to produce keeps happening. For us that is supervisors publishing schedules before the weekly deadline. A login is not retention and neither is a seat renewal. So I would define the habit event, measure the share of accounts hitting it weekly, and then look at what separates the accounts that hit it from those that do not before touching any pricing or onboarding lever.",
            "An ambiguous pricing problem: we suspected we were leaving money on the table with small teams but had no idea where the ceiling was. I would not start with a survey, because stated willingness to pay is fiction. I would start by segmenting current accounts on actual usage and finding the accounts that are clearly underpaying for the value they get, then run a paid pilot on a new tier with a small cohort, and treat their renewal behaviour as the only real read.",
            "The decision I would revisit is a hiring one rather than a product one. I hired a designer with a strong consumer portfolio into a B2B compliance product and it did not work - not the person's fault, the context was wrong and I knew it during the loop and talked myself past it. I would have run a paid two-week project instead. It cost us about four months of velocity and hurt someone's career.",
            "I learn fastest when I can see the failure up close. When we launched the usage-based pricing I sat on support calls for the first month because I had to hear the confusion in customers' own words. Two of the three biggest friction points in the new pricing came from those calls and were not on our radar. I would rather spend a week in someone else's queue than a month reading dashboards about it.",
        ),
    },
    {
        "role": "Frontend Engineer",
        "level": "junior",
        "topic": "React and accessibility",
        "opening": "I have about a year and a half of experience. I did a bootcamp, then joined a small agency where I built React interfaces for three client projects - a booking flow, an internal admin dashboard and a marketing site. I work in TypeScript and I have been doing the accessibility work on our components because a client needed WCAG AA.",
        "answers": (
            "I had a disagreement with a senior dev about state management. I wanted to add Redux to our booking flow and he said we should use what React gives us. I argued for a while. He asked me to write down what was actually shared between components, and when I did that it was two values that could live in a parent. I dropped the PR and we used context. I think he was right and the exercise is why.",
            "I made a mistake in a release where I changed a shared button component and broke the disabled styling on the checkout form. I had checked the component in isolation and not on any page that used it. A client reported it the next morning. I fixed it in ten minutes but what I changed after was running a search for every usage before changing a shared component, and adding a visual check to the PR template.",
            "In my last project I owned the whole client onboarding flow - the form, the validation and the API calls. It was a three-week build. I decided to do the validation on the client for the fast cases and also send it to the server for the real rules, because I did not want to duplicate the rules in two places and be wrong in one. It shipped and the error rate on submissions went down compared to the previous project.",
            "My mentor told me my pull requests were too big. I was bundling the feature, the tests and a refactor together, and nobody could review them, so they sat for days. He asked me to split them so each one does one thing. I still find it hard but my reviews now come back the same day. The first one I split was four PRs and two of them were wrong in ways the review caught, which would not have happened before.",
            "For accessibility I would start with the keyboard, because it is the cheapest check and it catches the most: tab through the whole flow and see whether focus goes somewhere sensible, whether it is visible, and whether you can escape anything you enter. Then the semantics - real buttons, labels tied to inputs, headings in order. Screen reader testing comes after, and I use a browser extension for contrast and a real screen reader for one pass before release.",
            "Learning something new: I had never used a component library or a design system when I joined. I read the library's docs for about two days and then rebuilt our existing booking page with its components in a branch so I would hit the real problems. That took a week and it taught me more than reading. The branch got thrown away, which was the point of it.",
            "I check my own work by writing the test that fails first, and I still forget. Honestly the thing that catches the most is asking someone else to try to break it. On the booking flow I asked a colleague to book something and she immediately did something I had not thought of - going back a step after the payment page. If it broke for a user I would look at the network tab first, and the error boundary after.",
        ),
    },
    {
        "role": "Data Platform Lead",
        "level": "principal",
        "topic": "warehouse migration and data contracts",
        "opening": "I lead a data platform team of nine. Fifteen years in the space, the last six at a marketplace where I own the warehouse, the ingestion layer and the analytics contract with the product teams. I led the migration from a self-managed Spark cluster to Snowflake and a dbt-based transformation layer, and I introduced the data contracts programme that took our pipeline incident count down from about forty a quarter to under five.",
        "answers": (
            "The conflict was with our ML leads over feature freshness. They wanted a real-time feature store; I argued that half their features were computed from data that only landed daily, so streaming them would buy latency we could not use while making the failure modes much worse. That landed badly. What resolved it was measuring it: we instrumented how stale the upstream events actually were and found a p50 of nine hours, at which point they agreed to a daily materialisation with an intra-day refresh for the four features that genuinely needed it.",
            "I own a two-day analytics outage. We had deprecated a column and I approved the final drop without enumerating consumers, because the contract list was manual and out of date. Three dashboards and one pricing model went dark. The fix was restoring from a clone in an hour; the real change was making the contract list a generated artefact - every consumer declares its columns in config and CI fails on a drop that anything still reads. That took a quarter and it is the highest-value thing my team has built.",
            "I own the decision to keep the warehouse in SQL rather than adopt a lakehouse. I judged that our bottleneck was modelling discipline, not storage cost, and that a new engine would consume a year of team capacity without fixing the thing that was actually breaking. I wrote the position, got it reviewed by two staff engineers who disagreed, and set a re-evaluation date a year out. Storage cost did become a problem in the second year, and we moved cold data to object storage then - a smaller change than a platform swap.",
            "My CTO told me I was solving my team's problems instead of the company's. I was proud of our platform hygiene and the product teams were shipping analytics that did not answer their questions. I sat with three product teams for a week, watched what they were actually measuring, and rewrote the roadmap around their decisions rather than our stack. I lost two quarters of platform work I cared about and the next year's incident rate was still the lowest we had.",
            "A data contract is an interface with a schema, a freshness guarantee, an owner and a set of declared consumers, enforced in CI rather than in a wiki. The point is not the schema - it is the enforcement and the owner. If a producer cannot break a consumer without a build failing and a named human being paged, the contract is real. If it lives in a doc, it is a wish. We also version contracts rather than treating every change as breaking, because a programme that blocks all change gets bypassed within a month.",
            "The ambiguous problem I would take on is whether our warehouse should serve the operational systems at all. The obvious answer is no - read replicas exist, and putting analytics load on an operational path is how you cause an outage. But three of our internal tools now read from warehouse tables with a couple of hours of lag and the product teams are fine with it, so the real question is where the boundary should sit and who owns the freshness promise on those tables. I would map the actual read paths and the cost of staleness per path before answering.",
            "The thing I would change before rollout is almost always the backfill. On the warehouse migration we validated the dual-write path and the cutover, and then ran a six-week backfill that failed twice on volume - once on warehouse credits and once on a source-system lock we had not asked about. I would run the backfill against a truncated window first, in prod, at real volume, before committing to a cutover date.",
            "I learn by writing the thing down and having it attacked. When I changed our modelling approach to contracts I wrote a two-page proposal, circulated it to the staff group, and got back a page of objections, two of which were fatal to my original design. I rewrote it. I also keep a running note of every decision I got wrong and what the signal was that I ignored - that file is the only reason I caught the pricing-model dependency before this last migration.",
        ),
    },
    {
        "role": "DevOps Engineer",
        "level": "mid",
        "topic": "CI/CD, Kubernetes and incident response",
        "opening": "Four years in platform and DevOps. I run the CI/CD platform for about 60 engineers at a logistics company - GitHub Actions to Argo CD on EKS, ~200 deploys a week. I did the migration off Jenkins, which cut build times from 22 minutes to 6 and got our change failure rate from 18% to about 6%.",
        "answers": (
            "A senior developer and I disagreed about the deploy pipeline: he wanted every merge to deploy straight to prod, I wanted a manual gate on anything touching the payment service. He said the gate was just fear. I asked him to pull the incident data with me, and it showed every one of our last four Sev-2s came from a one-line config change in that service. We kept the gate for that service only and made it auto-approve once canary metrics were green. Nobody has asked to remove it since.",
            "I broke staging for a week and I own it. I was cleaning up an old Terraform state file and ran an apply with the workspace still pointed at staging instead of my branch. It destroyed the ingress and the DB subnet. We rebuilt from code in about a day, but the week of lost staging use cost two teams their integration testing. After that I made state operations go through a wrapper that prints the workspace and requires the name typed out.",
            "I own our on-call rotation end to end. I decided we would do weekly rotations with a hard handover doc instead of the two-day rotation people wanted, because I judged that two days is not enough to own an incident through to its follow-ups and it burns everyone. I also made the rule that whoever is paged owns the follow-up ticket, not a separate team. Page volume went from 40 a week to 9, and two engineers told me it was the first rotation they had not wanted to quit over.",
            "My manager told me I was unblocking people by doing their work for them. Whenever a team got stuck on a pipeline I would just fix it myself, so they never learned it and I was the bottleneck. She asked me to pair instead of take over. It was slower for a month. Six months later the number of pipeline tickets coming to my team had halved and two developers had started contributing upstream fixes themselves.",
            "A good deploy pipeline is one where the fast path is also the safe path: if the correct way to ship is the annoying way, people will route around it. Concretely I want a build that caches hard, a canary or blue-green step that fails on error rate rather than on a human watching a graph, and an automatic rollback that nobody has to think about at 3am. The gate has to be a metric, not a person, because a person approving means a person awake.",
            "Design a deploy pipeline for a service where the obvious answer is ruled out: no blue-green, no second environment, single region, and the database migration is not backwards compatible. I would stop treating it as one deploy. I would first split the migration into expand and contract - add the new column, dual-write, backfill, switch reads, then drop the old one release later - which removes the irreversible step from the deploy itself. Then ship the code behind a flag, canary the flag, and the rollback is a flag flip plus a forward-only forward fix, which is the only rollback you actually have without a second environment.",
            "The incident I would change before rollout is a Kubernetes resource limit. We set memory limits from a staging profile and shipped, and in prod the pods OOM-killed in a loop under real traffic - the failure looked like a network problem for two hours because the restarts were masked by the deployment. I would have run a load test at prod shape before the rollout, and I would have alerted on restart count, which is the metric that would have told us in a minute.",
            "I check my own work by running the change against a rebuilt-from-scratch environment, because the main thing I get wrong is assuming state that only exists on my machine. If it broke for a user, I go to the metric that says how bad before the logs that say why - blast radius first, then cause. The last one I missed was an ingress annotation that only mattered behind our CDN, which is why the from-scratch check is the habit now.",
        ),
    },
    {
        "role": "Cloud Engineer",
        "level": "senior",
        "topic": "AWS landing zones, cost and IAM",
        "opening": "Seven years on cloud infrastructure, the last three as the senior cloud engineer at a fintech. I own the AWS landing zone - about 90 accounts under Control Tower - plus the network, the IAM baseline and most of the cost work. I led the consolidation from 90 loosely governed accounts to an org with SCPs and a shared network, and cut the monthly bill 31% without a single headcount or performance change.",
        "answers": (
            "The conflict was with our security lead over how much IAM we centralise. She wanted every role defined in one repo with no per-team exceptions, I argued that would make teams wait on us for every new service. We were both defending our own queue. What broke it was agreeing on a measurement: we tracked lead time for a new service getting its first permission and the number of roles that were cross-account. Her model was 6 days and 4 roles, mine was 1 day and 40. We landed on a baseline of generated roles per team plus a fast exception path with a 24-hour SLA, and the audit findings went to zero.",
            "I cost us about 40,000 dollars in one month and it was my call. I enabled S3 Intelligent-Tiering on a bucket with hundreds of millions of tiny objects, having read the storage savings and skimmed the request charges - monitoring and GET requests on small objects meant the transition cost more than the storage it saved. I found it in the bill review, not an alarm, which was the worse part. I reverted it, added per-service cost anomaly alerts at a much lower threshold, and now I model request cost before touching a storage class.",
            "I owned the decision to stay on EC2 with our own Kubernetes rather than move to EKS. I judged that our team had deep operational knowledge of the EC2 setup and that the control-plane saving did not pay for the migration risk in a year where we had a compliance deadline. I wrote it up, got two staff engineers to attack it, and set a review six months out. We did move to EKS the following year - the review date is what made that a decision rather than a drift.",
            "My director told me I was optimizing infrastructure instead of the business. I had just finished a 31% cost reduction and I wanted to keep going after the last few points, and she pointed out those points were worth less than the feature work I was blocking by hogging the platform team's quarter. I stopped the cost programme at the point of diminishing returns and documented why, which was harder than continuing it. Cost per transaction kept improving anyway from the work already in flight.",
            "A landing zone is the set of defaults an engineer gets without asking: accounts that are provisioned rather than created by hand, a network that is peered and firewalled by policy, an IAM baseline where the dangerous permissions are denied rather than granted-then-audited, and logging and guardrails that are on from account creation. The test I use is whether a new team can be productive in a week without touching the root account. If they need an exception from day one, the defaults are wrong.",
            "The hard problem I would take on is multi-region for a workload where the obvious answer - active-active - is ruled out because the database cannot be written to in two places without a conflict model nobody wants. I would separate the tiers instead of the whole system: static assets and read paths go active-active at the edge because they are cheap and stateless, the write path stays single-region with a warm standby, and I would define an explicit RTO and RPO before designing any of it, because without those numbers the design is just expensive guessing.",
            "What I would change before rollout is the IAM change, always. On a network segmentation project we validated routing and firewall rules in staging for weeks, then applied the production IAM tightening and locked our own break-glass role out of the account for about twenty minutes. I would have tested the break-glass path explicitly, from a fresh session, as its own step before anything else in prod.",
            "I learn by building the smallest real version. When I took over the landing zone I did not read the runbooks first, I provisioned a scratch account through our own pipeline and documented every place it broke. That list of breaks was the actual backlog. I still do it that way - the docs tell you what someone believed, the pipeline tells you what is true.",
        ),
    },
    {
        "role": "DevOps / Cloud Hybrid Engineer",
        "level": "staff",
        "topic": "platform engineering across CI and cloud",
        "opening": "Eleven years across ops and cloud, currently staff platform engineer at a marketplace. I own the developer platform end to end - the CI system, the Terraform module library and the EKS clusters underneath both. My last big piece of work was a golden-path service template that took a new service from two weeks of setup to about a day, and the module library behind it that most of our 70 services now build on.",
        "answers": (
            "The conflict was with a product director over our platform roadmap. He wanted self-service databases, I wanted to fix the deploy pipeline everyone complained about. I said self-service was a feature and the pipeline was a tax on every team, every day. He asked me for numbers and I did not have them, which was the real problem. I went and measured deploy frequency and lead time per team, brought it back, and we did the pipeline first - and the numbers turned the argument into a plan instead of a fight.",
            "I own a full-day CI outage. I upgraded the runner fleet's container runtime version in one go, because the release notes said it was backwards compatible, and it was - except for one job type that pulled an image with an old manifest format. Every build failed for six hours and it was the day of a customer release. I did not stage the rollout across the fleet. Since then upgrades go to 10% of runners, then half, then all, with a day between steps, and that is now enforced by the tooling rather than by my memory.",
            "I own the decision to keep our Terraform module library in-house rather than adopt a newer framework. I judged that the module library was the platform's actual interface and that a rewrite would spend two quarters buying us a different syntax and worse escaping hatch situations. I wrote the position down, deliberately chose the parts we would steal rather than adopt, and set a review date. It has been right so far, and the review date is what will make it a decision again rather than inertia.",
            "A tech lead told me I wrote the platform for the platform team. Our golden path had every best practice in it: structured logging, health checks, sensible resource limits, the works - and teams were not adopting it because it took a day to understand. He told me to watch one team use it and count how many times they had to ask us a question. That number was 14. We cut the template to the things that were genuinely hard to retrofit and made the rest opt-in, and adoption went from four services to about fifty.",
            "The golden path is the set of choices a team gets for free, and its value is entirely in what it takes OFF their plate - not in what it teaches them. Practically that means a template that produces a service that deploys, logs, alerts and scales on day one with no platform ticket, and a documented escape hatch for everything else. The failure mode I actively avoid is the platform that is well-architected and slow to use, because teams will leave it and build their own thing next to it.",
            "The ambiguous problem I would take on is whether our platform should own the team's cloud accounts or just their pipelines. The obvious answer - platform owns the pipeline, teams own their infrastructure - sounds clean and is what we have, but our IAM sprawl and the four different Terraform states per team suggest the boundary is in the wrong place. I would map who is actually making subnet and IAM decisions today and what it costs them in lead time before picking where to move the line.",
            "The change I would make before rollout is the module upgrade path. We shipped a major Terraform module version with a breaking variable rename, told everyone to migrate, and about half re-pinned to the old version and forked their own copies instead. The release was fine; the migration was not. I would ship the new variable alongside the old, deprecate with a warning, and delete on a schedule - the boring path is the one that actually completes.",
            "I learn by watching someone else use the thing. When we built the first version of the golden path I sat next to two teams while they onboarded a service, and every time they had to stop and ask me something I wrote it down instead of answering. Two thirds of my answers turned into template changes. I do not trust my own reading of a developer experience I designed.",
        ),
    },
    {
        "role": "QA / Test Automation Engineer",
        "level": "junior",
        "topic": "test automation and release verification",
        "opening": "About two years in QA. I started in manual testing at a health-tech company and moved into automation six months ago - I write Playwright tests for our patient portal and I maintain the regression suite that runs on every pull request. We are at about 240 end-to-end tests and I got the flaky ones from around 20 down to 3.",
        "answers": (
            "A developer and I disagreed about whether a bug was a bug. A form let you submit with a future date of birth and he said the API validation would catch it so the UI did not matter. I said the user finds out by getting an error and I think that is a real bug. He was not moved by my argument. What worked was showing him the support tickets where the same pattern appeared - users do not read API errors. We added UI validation and I started bringing ticket evidence to those conversations instead of opinions.",
            "I made a mistake where I signed off a release that broke the appointment list for about 200 users. I had tested it on a login with a small number of appointments and did not think about accounts with hundreds - the list paginated wrong above 50. The dev fixed it the same day. What I changed was adding boundary cases to my checklist for anything with a list or a count, and I rewrote the test so it seeds 200 records.",
            "I own the regression suite and the release verification for the portal. I decided we would not add more end-to-end tests and instead move the coverage that could be tested below the UI into API tests, because the end-to-end ones took 25 minutes and were the flaky ones. That took about a month and the suite went from 25 minutes to 7 with better coverage. My manager was sceptical about deleting tests until she saw the flaky rate drop.",
            "My lead told me my bug reports were not actionable - I was writing 'the form is broken' with a screenshot and no steps, so devs had to come ask me. She asked me to write the report so that someone who had never seen the app could reproduce it. I started writing exact steps with test data included. The number of times a dev came back to ask me a question dropped a lot and I got faster at finding the real cause because writing the steps forced me to check.",
            "A good automated test is one that fails for exactly one reason and says which. Practically that means it sets up its own data instead of depending on a state someone left, it asserts on something specific rather than on the page being up, and it fails with a message that points at the cause. A flaky test is worse than no test, because people learn to ignore red - and once they ignore red the whole suite is decoration.",
            "Learning something new: I had never written Playwright or used a test framework before this role. I learned by taking our three worst manual regression scripts and converting them one at a time, starting with the one I hated doing most. I broke things constantly for the first two weeks. The helper functions I ended up with came out of the repetition, and I do not think reading the docs first would have got me there.",
            "When I check my own work I run the test I just wrote against the unfixed code first, because a test that passes before the fix is not testing the fix. If something broke for a user, I go to the reproduction first - get it happening on demand - and only then start looking at cause. Most of my wasted time was guessing at causes for a bug I had not reproduced properly.",
        ),
    },
    {
        "role": "Data Engineer",
        "level": "mid",
        "topic": "pipeline reliability and streaming",
        "opening": "Five years as a data engineer. I own the ingestion layer for a retail analytics team - Kafka into Postgres and S3, dbt for the transformations, roughly 40 pipelines. I rebuilt our order-events pipeline after it had been silently dropping about 2% of events for months, and it now reconciles to the source system with a daily check.",
        "answers": (
            "The disagreement was with an analyst who owned the main revenue dashboard. My pipeline change was going to shift some numbers by a few percent because the old one had been double-counting refunds, and she did not want the dashboard to move mid-quarter. I thought that was hiding a bug to protect a number. We escalated it and our lead split the difference, which satisfied neither of us. What I would do differently is bring the reconciliation evidence first and give her a version of the dashboard both ways, so it was her call with the facts rather than my call about her reporting.",
            "I own a silent data loss bug. I added a filter to a consumer without checking the schema of the legacy producer, and it dropped about 2% of order events for months because the field it filtered on was null in the old format. Nobody noticed because the pipeline was green and the totals drifted slowly. I found it by accident during an unrelated reconciliation. I rebuilt the pipeline with a reconciliation check that compares counts to the source daily, and an alert on the delta, which is what would have caught it in a day.",
            "I owned the move from a nightly batch load to streaming for the order events. I chose Kafka with a Postgres sink and idempotent upserts rather than a full CDC setup with Debezium, because CDC would have needed access to the production database that our DBA would not give us and I did not want to spend a quarter negotiating. It worked and gave us about a 20-minute freshness instead of 24 hours. It does not scale past the current volume and I documented that.",
            "My tech lead told me my pipelines were clever and unmaintainable. I had written a transformation with window functions nested three deep that nobody else could read, and I was proud of it. He said he could not review it and would not be able to fix it at 2am. I rewrote it as a chain of smaller CTEs with comments on the tricky part. It ran slower and it was the right trade - I have since been the person debugging my own clever SQL at 2am.",
            "Idempotency and provenance. Every write has to be safe to run twice, so I use an upsert on a natural key with the batch id recorded, which means a rerun overwrites rather than duplicates. And every row carries where it came from and when it landed, so when a number looks wrong I can tell whether the source was wrong or my transformation was. Without those two, a bug shows up as a dashboard that is quietly wrong and nobody can tell you for how long.",
            "A pipeline design where the obvious answer is ruled out: the source system can only give you a full dump once a day, but the business wants near-real-time numbers, and there is no change-data-capture access. I would not try to fake streaming from a daily dump - that is how you produce numbers that are confidently stale. I would find the one or two tables where freshness actually changes a decision, get event-level data for just those from the application team as a separate feed, and keep the rest on the daily dump with the refresh time shown on the dashboard.",
            "The thing I would change before rollout is the backfill. On a schema change we validated the new pipeline on a day of data, cut over, and then the backfill of two years hit a source system lock that took the whole thing down for four hours. I would have run the backfill against a short window in production first, at real volume, before committing to the cutover date.",
            "I check my own work by reconciling the output against a number I can get independently - the source system, a finance report, anything that was not produced by my pipeline. A green pipeline proves it ran, not that it is right, and the double-counting bug I inherited is the proof. If it broke for a user I check the freshness timestamp before the data, because half our incidents were a pipeline that had stopped rather than a pipeline that was wrong.",
        ),
    },
)

WEAK_ANSWERS = (
    "I mean we just did it, you know? Like everyone kind of agreed and we moved on. I don't really remember the details but it worked out fine.",
    "I would say I'm a very hard worker and I pick things up quickly. I think that's probably my best answer - I always give it 100%.",
    "There was this one time something broke and we fixed it. It was a while ago. I think it was a database thing maybe, and someone on the team handled the actual fix.",
    "I don't really know, I'd have to look that up. I know the general idea of it but I wouldn't want to say something wrong.",
    "Yeah so my strategy is to just make sure everything is good and there are no problems. If it's not broken then it's fine.",
)

TECH_ROLES = frozenset(
    {
        "DevOps Engineer",
        "Cloud Engineer",
        "DevOps / Cloud Hybrid Engineer",
        "QA / Test Automation Engineer",
        "Data Engineer",
    }
)

ROLE_WEIGHT = 2.0

STRENGTH_MIX: tuple[tuple[float, float, float], ...] = (
    (0.12, 0.05, 0.30),
    (0.30, 0.30, 0.55),
    (0.38, 0.55, 0.80),
    (0.20, 0.80, 1.00),
)

LEVEL_WEIGHTS: tuple[tuple[str, int], ...] = (
    ("any", 4),
    ("intern", 3),
    ("junior", 14),
    ("mid", 30),
    ("senior", 28),
    ("staff", 16),
    ("principal", 5),
)

HOURS: tuple[int, ...] = tuple(range(7, 23))
HOUR_WEIGHTS: tuple[int, ...] = (2, 4, 6, 8, 6, 5, 6, 5, 5, 8, 12, 14, 10, 6, 4, 3)

HISTORY_DAYS = 90
WEEKEND_WEIGHT = 0.35

WEAK_OPENING = "I don't have my resume with me right now but I can summarize - I've worked in a few companies doing software type work. I can tell you more as we go."


def build_specs(rng: random.Random, n: int = 40) -> list[dict]:
    weights = role_weights()
    assert len(weights) == len(CANDIDATES) and len({c["role"] for c in CANDIDATES}) == len(CANDIDATES)
    assert {slug for slug, _ in LEVEL_WEIGHTS} == set(_levels().LEVELS), "a level with no weight never gets seeded"
    levels_ = [slug for slug, _ in LEVEL_WEIGHTS]
    level_weights = [w for _, w in LEVEL_WEIGHTS]

    specs: list[dict] = []
    for when in practice_when(rng, n):
        c = rng.choices(CANDIDATES, weights=weights, k=1)[0]
        strength = draw_strength(rng)
        status = rng.choices(("completed", "in_progress", "pending"), weights=(78, 14, 8), k=1)[0]
        spec = {
            **person(c),
            "level": rng.choices(levels_, weights=level_weights, k=1)[0],
            "when": when,
            "status": status,
            "strength": strength,
            **dials(rng),
        }
        if status == "pending":
            spec["answers"] = []
        elif strength < 0.30 and rng.random() < 0.6:
            spec["answers"] = [WEAK_OPENING, *WEAK_ANSWERS]
        if status == "completed" and rng.random() < 0.12:
            spec["archived"] = True
        if rng.random() < 0.12:
            spec["hardcore"] = True
            spec["cynicism"] = "skeptical"
            if status == "completed" and rng.random() < 0.5:
                spec["fail_at"] = rng.randrange(0, max(1, min(len(spec["answers"]), planned_questions(spec))))
        specs.append(spec)
    return specs


def role_weights() -> list[float]:
    return [ROLE_WEIGHT if c["role"] in TECH_ROLES else 1.0 for c in CANDIDATES]


def draw_strength(rng: random.Random) -> float:
    _, low, high = rng.choices(STRENGTH_MIX, weights=[w for w, _, _ in STRENGTH_MIX], k=1)[0]
    return rng.uniform(low, high)


def practice_when(rng: random.Random, count: int) -> list[datetime]:
    now = datetime.now(UTC)
    offsets = list(range(HISTORY_DAYS))
    weights = [(0.35 + 0.65 * (1 - off / (HISTORY_DAYS - 1)) ** 2) * (WEEKEND_WEIGHT if (now - timedelta(days=off)).weekday() >= 5 else 1.0) for off in offsets]
    streak = rng.randint(3, 7)
    picked = list(range(streak)) + rng.choices(offsets, weights=weights, k=max(0, count - streak))
    return sorted(
        (now - timedelta(days=off)).replace(
            hour=rng.choices(HOURS, weights=HOUR_WEIGHTS, k=1)[0],
            minute=rng.randrange(60),
            second=rng.randrange(60),
            microsecond=0,
        )
        for off in picked
    )


def dials(rng: random.Random) -> dict:
    mix = [rng.randrange(_dials().MIX_MAX + 1) for _ in range(3)]
    if not any(mix):
        mix[rng.randrange(3)] = 2
    skeptical = rng.random() < 0.35
    return {
        "company_size": rng.choices(_dials().COMPANY_SIZES, weights=(6, 9, 11, 9, 6, 5, 4), k=1)[0],
        "cynicism": rng.choices(_dials().CYNICISM, weights=(2, 3, 6) if skeptical else (4, 5, 3), k=1)[0],
        "brutally_honest": skeptical and rng.random() < 0.55,
        "human_mode": rng.random() < 0.82,
        "mix_chitchat": mix[0],
        "mix_behavioural": mix[1],
        "mix_technical": mix[2],
    }


def run_rng(spec: dict, salt: str) -> random.Random:
    return random.Random(f"{salt}|{spec['role']}|{spec['level']}|{spec['when'].isoformat()}|{spec['strength']:.3f}")


def person(c: dict) -> dict:
    return {
        "role": c["role"],
        "level": c["level"],
        "topic": c["topic"],
        "opening": c["opening"],
        "answers": list(c["answers"]),
        "strength": 0.8,
    }


def planned_questions(spec: dict) -> int:
    return spec.get("mix_chitchat", 0) + 1 + spec.get("mix_behavioural", 2) + spec.get("mix_technical", 4)

MOVE_BANDS: tuple[tuple[float, tuple[tuple[str, int], ...]], ...] = (
    (0.90, (("brilliant", 4), ("great", 4), ("good", 2))),
    (0.78, (("great", 3), ("good", 4), ("book", 2))),
    (0.62, (("good", 4), ("book", 3), ("inaccuracy", 2))),
    (0.42, (("book", 3), ("inaccuracy", 4), ("mistake", 1))),
    (0.22, (("inaccuracy", 3), ("mistake", 3), ("book", 1))),
    (0.00, (("mistake", 4), ("blunder", 3), ("inaccuracy", 1))),
)


def turn_classes(spec: dict, turns: int) -> list[str]:
    rng = run_rng(spec, "moves")
    rating = app_modules()[1]
    band = next(classes for floor, classes in MOVE_BANDS if spec["strength"] >= floor)
    classes = rng.choices([c for c, _ in band], weights=[w for _, w in band], k=turns)
    if spec.get("fail_at") is not None:
        classes = classes[: spec["fail_at"] + 1]
        classes[spec["fail_at"]] = "mistake"
    assert all(c in rating.MOVE_POINTS for c in classes)
    return classes


def scores_for(spec: dict, classes: list[str]) -> dict:
    rng = run_rng(spec, "scores")
    llm = app_modules()[0]
    base = 4 + spec["strength"] * 5.5
    if spec.get("fail_at") is not None:
        base = min(base, 4.5)
    out = {}
    for dim in llm.FEEDBACK_DIMS:
        if dim == "technical_depth" and not spec.get("mix_technical", 4):
            continue
        if dim in ("ownership", "collaboration", "growth_potential") and not spec.get("mix_behavioural", 2):
            continue
        out[dim] = float(min(10, max(1, round(base + rng.uniform(-1.2, 1.2), 1))))
    return out or {"clarity": float(min(10, max(1, round(base, 1))))}


DECISIONS_BY_GRADE = {
    "S": "hire",
    "A": "lean_hire",
    "B": "lean_hire",
    "C": "lean_reject",
    "D": "lean_reject",
    "F": "reject",
}
VERDICTS = {
    "S": "An unusually strong run: the answers came with concrete numbers, named trade-offs and a clear account of what the candidate themselves decided. Nothing in the transcript reads as rehearsed, and the ops answers show judgement rather than recall.",
    "A": "A strong interview with real evidence behind it - specific systems, specific failures, and a clear sense of what the candidate owned. The weaker spots are partly in the answers and partly in how narrow the questioning got.",
    "B": "A solid, credible run. The candidate knows their material and gave genuine examples, but several answers stayed at the level of what was done rather than why the choice beat the alternatives.",
    "C": "Mixed. There is real experience here, but too much of it was described without specifics - no numbers, no alternatives considered, and little evidence of the candidate's own decisions versus the team's.",
    "D": "The transcript does not give enough to support the claims made. Answers stayed general and avoided the harder follow-ups, and the few concrete details given were not connected to an outcome.",
    "F": "RUN OVER. THE ANSWER THAT ENDED THIS RUN WAS A MISTAKE AND IN HARDCORE MODE THAT IS THE WHOLE RUN. NO SECOND CHANCES.",
}
TIPS = (
    ["Put a number on the outcome - latency, money, incident count - even a rough one beats 'it got better'.", "Name the alternative you rejected and why, so the choice reads as a decision rather than a default.", "Say what YOU decided, not what the team did; unpack 'we' into your own part."],
    ["Use STAR: situation, task, action, result - the result is the part that is usually missing.", "When you do not know something, say how you would find out rather than stopping at 'I'd look it up'.", "Keep the answer to the question asked before widening it."],
)


def build_sql(specs: list[dict], owner: str) -> str:
    if owner != "dev-user":
        raise SystemExit("this seeder writes the DEV_USER identity; another owner needs Clerk")
    stmts: list[str] = []
    for spec in specs:
        answers = spec["answers"]
        wanted = planned_questions(spec)
        turns = 0 if spec["status"] == "pending" else (len(answers) if spec["status"] == "completed" else max(1, min(len(answers), wanted // 2)))
        classes = turn_classes(spec, turns) if turns else []
        failed = spec.get("fail_at")
        turns = len(classes)
        iv_id = str(uuid.uuid4())
        stmts.append(
            "INSERT INTO interviews (id, owner_id, role, level, topic, company_size, cynicism, brutally_honest, human_mode, hardcore, mix_chitchat, mix_behavioural, mix_technical, status, created_at, updated_at, archived_at, failed_turn, failed_class) VALUES ("
            + ", ".join(
                [
                    q_(iv_id), q_(owner), q_(spec["role"]), q_(spec["level"]), q_(spec["topic"]),
                    q_(spec.get("company_size", "any")), q_(spec.get("cynicism", "neutral")),
                    str(spec.get("brutally_honest", False)).lower(), str(spec.get("human_mode", True)).lower(), str(spec.get("hardcore", False)).lower(),
                    str(spec.get("mix_chitchat", 0)), str(spec.get("mix_behavioural", 2)), str(spec.get("mix_technical", 4)),
                    q_(spec["status"]), q_(spec["when"].isoformat()), q_(spec["when"].isoformat()),
                    q_(spec["when"].isoformat()) if spec.get("archived") else "NULL",
                    str(failed + 1) if failed is not None else "NULL", q_(classes[failed]) if failed is not None else "NULL",
                ]
            )
            + ");"
        )
        if turns:
            stmts.append(_messages_sql(spec, turns, classes, iv_id))
        if spec["status"] == "completed":
            stmts.append(_feedback_sql(spec, classes, iv_id))
            stmts.append(_offer_sql(spec, classes, iv_id))
    return "\n".join(stmts)


def _messages_sql(spec: dict, turns: int, classes: list[str], iv_id: str) -> str:
    rows: list[str] = []
    t = spec["when"]
    notes = app_modules()[1].STUB_MOVE_NOTES
    for n in range(turns):
        at = t + timedelta(minutes=n * 3)
        cls = classes[n] if n < len(classes) else None
        rows.append(f"({q_(iv_id)}, 'user', {q_(spec['answers'][n % len(spec['answers'])])}, {q_(cls) if cls else 'NULL'}, {q_(notes[cls]) if cls else 'NULL'}, {q_(at.isoformat())})")
        if n < turns - 1:
            rows.append(f"({q_(iv_id)}, 'assistant', {q_(question(spec, n))}, NULL, NULL, {q_((at + timedelta(seconds=45)).isoformat())})")
    llm = app_modules()[0]
    closing = llm.FAIL_MESSAGE.format(cls=classes[-1].upper()) if spec.get("fail_at") is not None else llm.CLOSING_MESSAGE
    rows.append(f"({q_(iv_id)}, 'assistant', {q_(closing)}, NULL, NULL, {q_((t + timedelta(minutes=turns * 3)).isoformat())})")
    return "INSERT INTO messages (interview_id, role, content, move_class, comment, created_at) VALUES\n  " + ",\n  ".join(rows) + ";\n"


def question(spec: dict, n: int) -> str:
    role, level = spec["role"], spec["level"]
    chitchat = ["Before we dive in - how's your week going? What are you working on at the moment?", "And whereabouts are you based? How did you get into this line of work?"]
    behavioural = [
        "Let's start with something you've actually been through. Tell me about a time you and a colleague disagreed about the right approach - how did it resolve, and who conceded?",
        "Tell me about a mistake that was genuinely yours. What did you change in how you work afterwards?",
        "Describe an outcome you owned end to end. What did YOU decide, specifically?",
        "Tell me about a time you took hard feedback, or had to get up to speed on something far faster than expected.",
    ]
    technical = [
        f"Let's get into the work itself. For a {level} {role.lower()}, what would you say is the single most important thing to get right, and how do you know when it's right?",
        "Walk me through a problem you hadn't seen before - how you scoped it, what you traded off, and what you deliberately did not do.",
        "Tell me about something you shipped that broke. How did you find it, and what did you change before the next rollout?",
        "Give me a design question where the obvious approach is ruled out - what would you do instead?",
    ]
    plan = [
        *chitchat[: spec.get("mix_chitchat", 0)],
        "Before we begin - could you share your resume / background so I can interview you specifically on it?",
        "Thanks. Now tell me about yourself - what you do now, and how you got here.",
        *behavioural[: spec.get("mix_behavioural", 2)],
        *technical[: spec.get("mix_technical", 4)],
    ]
    return plan[min(n, len(plan) - 1)]


def decision_for(spec: dict, grade: str) -> str:
    return "reject" if spec.get("hardcore") else DECISIONS_BY_GRADE.get(grade)


def _feedback_sql(spec: dict, classes: list[str], iv_id: str) -> str:
    rating = app_modules()[1]
    acc = rating.accuracy(classes)
    grade = rating.grade(acc, failed=spec.get("fail_at") is not None)
    decision = decision_for(spec, grade)
    scores = scores_for(spec, classes)
    certainty = min(40 + 8 * len(classes), int(45 + spec["strength"] * 45))
    if spec.get("fail_at") is not None:
        certainty = 100
    verdict = VERDICTS.get(grade, VERDICTS["B"])
    if spec.get("fail_at") is not None:
        verdict = f"RUN OVER. TURN {spec['fail_at'] + 1} WAS A MISTAKE AND IN HARDCORE MODE THAT IS THE WHOLE RUN. NO SECOND CHANCES."
    tips = TIPS[0] if (acc or 0) >= 70 else TIPS[1]
    at = spec["when"] + timedelta(minutes=len(classes) * 3 + 2)
    assert acc is None or 0 <= acc <= 100
    return (
        "INSERT INTO feedback (interview_id, scores, verdict, tips, decision, certainty, accuracy, created_at) VALUES ("
        f"{q_(iv_id)}, {q_(json.dumps(scores))}::jsonb, {q_(verdict)}, {q_(json.dumps(tips))}::jsonb, {q_(decision)}, {certainty}, {acc if acc is not None else 'NULL'}, {q_(at.isoformat())});\n"
    )


def _offer_sql(spec: dict, classes: list[str], iv_id: str) -> str:
    from app.models import HIRING_DECISIONS

    if spec["status"] != "completed":
        return ""
    rating = app_modules()[1]
    accuracy = rating.accuracy(classes)
    if decision_for(spec, rating.grade(accuracy, failed=spec.get("fail_at") is not None)) not in HIRING_DECISIONS:
        return ""
    priced = _offer().terms(spec["role"], spec["level"], scores_for(spec, classes), accuracy)
    if priced is None:
        return ""
    at = spec["when"] + timedelta(minutes=len(classes) * 3 + 2)
    return (
        "INSERT INTO offers (interview_id, title, band, base_salary, signing_bonus, equity, performance, benefits, created_at) VALUES ("
        f"{q_(iv_id)}, {q_(priced.title)}, {q_(priced.band)}, {priced.base_salary}, {priced.signing_bonus}, {priced.equity}, {priced.performance}, "
        f"{q_(json.dumps(priced.benefits))}::jsonb, {q_(at.isoformat())});\n"
    )


def q_(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return f"$seed${value}$seed$"


def compose() -> list[str]:
    return ["docker", "compose", "-p", "maxterview-dev", "-f", "compose.yml", "-f", "compose.dev.yml"]


def relaunch_in_backend() -> None:
    argv = sys.argv[1:]
    src = Path(__file__).read_text()
    cmd = [*compose(), "exec", "-T", "-e", "SEED_IN_BACKEND=1", "backend", "uv", "run", "python", "-", "--sql", *[a for a in argv if a not in ("--wipe",)]]
    proc = subprocess.run(cmd, input=src, text=True, capture_output=True, cwd=REPO)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip()[:3000])
    owner = argv[argv.index("--owner") + 1] if "--owner" in argv else "dev-user"
    if "--dry-run" in argv:
        return
    sql = ("DELETE FROM interviews WHERE owner_id = $seed$" + owner + "$seed$;\n" if "--wipe" in argv else "") + proc.stdout
    run_sql("BEGIN;\n" + sql + "\nCOMMIT;")
    show_results(owner)


def run_sql(sql: str) -> str:
    cmd = [*compose(), "run", "--rm", "--no-deps", "-T", "psql", "-v", "ON_ERROR_STOP=1", "-q"]
    proc = subprocess.run(cmd, input=sql, capture_output=True, text=True, cwd=REPO)
    if proc.returncode != 0:
        raise SystemExit(f"psql failed:\n{proc.stderr.strip()[:2000]}")
    return proc.stdout


def show_results(owner: str) -> None:
    scope = f"i.owner_id = $seed${owner}$seed$"
    print(run_sql(f"SELECT i.status, count(*) AS runs, count(f.accuracy) AS graded, count(i.failed_turn) AS failed FROM interviews i LEFT JOIN feedback f ON f.interview_id = i.id WHERE {scope} GROUP BY i.status ORDER BY 1;").strip())
    print(
        run_sql(
            "SELECT count(*) AS offers, min(base_salary) AS low, round(avg(base_salary)) AS avg, max(base_salary) AS high, "
            "count(DISTINCT band) AS bands, round(avg(jsonb_array_length(benefits)), 1) AS benefits, count(DISTINCT performance / 25) AS tiers "
            f"FROM offers o JOIN interviews i ON i.id = o.interview_id WHERE {scope};"
        ).strip()
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--wipe", action="store_true")
    ap.add_argument("--owner", default="dev-user")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sql", action="store_true")
    args = ap.parse_args()

    if not os.environ.get("SEED_IN_BACKEND"):
        try:
            app_modules()
        except ImportError:
            return relaunch_in_backend() or 0

    rng = random.Random(args.seed)
    specs = build_specs(rng, n=args.runs)
    if args.sql:
        print(build_sql(specs, args.owner))
        return 0
    if args.dry_run:
        for s in specs:
            print(f"{s['when'].isoformat()[:16]}  {s['status']:<11} {s['role']:<32} lvl={s['level']:<9} q={planned_questions(s):<2} hard={int(bool(s.get('hardcore')))} arch={int(bool(s.get('archived')))}")
        print(f"{len(specs)} runs")
        return 0

    sql = ("DELETE FROM interviews WHERE owner_id = $seed$" + args.owner + "$seed$;\n" if args.wipe else "") + build_sql(specs, args.owner)
    run_sql("BEGIN;\n" + sql + "\nCOMMIT;")
    print(f"seeded {len(specs)} runs for {args.owner!r}" + (" (after wipe)" if args.wipe else " (additive)"))
    show_results(args.owner)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
