# VOICE (audio + camera)

Settled 2026-09-22, narrowed the same day: the interviewer speaks, the applicant speaks, and Cloudflare
Workers AI carries both on its free daily allocation. There is no second engine. The browser's own
voices and recognition were built, then removed: a stock TTS voice sounds like a screen reader, and an
interviewer that talks like one destroys the illusion the feature exists to create (V1). The camera is
an optional self-view with no processing. `PLAN.md` M19 owns the camera window; this file owns the
decisions and the build order.

**The rule:** voice is I/O around what already exists. The applicant's speech becomes text, the text
goes through `POST /interviews/{id}/chat/stream` exactly as typed text does today, and the
interviewer's reply is read aloud. The transcript stays the graded artifact (`PLAN.md` D16).

That rule kills the tempting shortcut. A vendor realtime session would own the conversation and
bypass the dials, the question-arc budget, the hardcore judge, the move classes, the grader, the
resume injection guard, the per-turn meter and the stored transcript. Two bills, two sources of
truth. Not doing.

## Settled decisions

| #   | Decision                                        | Consequence                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | One engine, and it is not the browser           | Cloudflare Workers AI only. The browser's voices and recognition were tried and removed. Quality decides it: a stock voice is the generic TTS one, and the interviewer is the product. Availability agrees: Chromium on Linux exposes no voice without `--enable-speech-dispatcher` and a loadable `libspeechd`, and Brave refuses recognition outright with an undetectable `network` error |
| V2  | One backend route, no Worker                    | The backend calls Workers AI with an account ID and an API token from `backend/.env`, which is the path every other credential already takes (Infisical, Terraform, the k8s Secret, `envFrom`). No edge deployment and no second secret store                                                                                                                                                |
| V3  | A take is one upload                            | The clip is recorded, uploaded, transcribed and discarded in the same request. A failure is a sentence on screen and leaves the next take unaffected: there is no engine to swap to, and no audio survives the call (PLAN D16 applied to voice)                                                                                                                                              |
| V4  | Nothing renders mid-answer                      | Nothing is transcribed on the client, so the box stays empty until the applicant stops and the words arrive. The level meter and the timer are the whole of the feedback while recording                                                                                                                                                                                                     |
| V5  | Confirm before send                             | The transcript lands in the answer box and the applicant edits or sends it. The scored text is the one they saw                                                                                                                                                                                                                                                                              |
| V6  | Camera is inert                                 | Optional local self-view, off by default, nothing recorded, nothing analyzed, never in the score                                                                                                                                                                                                                                                                                             |
| V7  | The controls admit when the server has no voice | `GET /voice` gates both controls. Unconfigured is a disabled toggle, a disabled mic, and a sentence on screen saying which, never a button that fails on click                                                                                                                                                                                                                               |

Refused outright: realtime vendor sessions, server-side video analysis, stored audio, voice cloning,
avatar interviewers, always-on listening, and anything metered, billed or card-backed.

## The budget: 10,000 neurons a day, shared by the whole account

Cloudflare's free allocation is 10,000 neurons per day per account, reset at 00:00 UTC, and requests
fail once it is gone. Measured 2026-09-23 against the live account:

| Direction     | Model                    | Measured                                                                                           | Cost                                                                                                                                                                  |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcription | `whisper-large-v3-turbo` | 6.8-17.5s for a 112 second clip through our own route (upload included), 10 segments, correct text | The response reports its own spend: **87.26 neurons** for that clip, which is the published 46.63 per audio minute. A 15 minute answer set is therefore ~700          |
| Voice         | `@cf/deepgram/aura-1`    | 0.42-1.03s per sentence, `audio/mpeg`                                                              | 1,363-2,727 neurons per 1k characters, so ~1.4k-3.8k for a run's 1,000-1,400 characters. Estimated, not reported: this model returns raw audio with no usage envelope |

The voice is the scarce resource, not the transcription: about 2 to 7 runs a day, where the answers
would allow 14. `@cf/myshell-ai/melotts` is the model this account cannot run at all: it answers
`AiError: Internal server error` (code 3043) on every request, with or without `lang`, while the same
token drives the other two. That is why the default is Aura, and it is also the better outcome: Aura is
the human voice, MeloTTS is the generic one that got the browser engines deleted (V1).

Past the allocation, voice goes unavailable with a reason on screen: a degraded feature, never a bill.

## Step 1: it speaks (built)

Aura-1 through the backend, one request per line, played as it arrives. One consistent voice on every
machine, which is the point (V1). The voice is cast rather than inherited: Aura-1's own default speaker
is `angus`, an Irish man, so the request names `hera`, Deepgram's smooth, warm, professional adult
American female (`CLOUDFLARE_TTS_SPEAKER`; asteria, luna, athena and stella are all one value away).

The line boundaries are what make it feel live: the streamed reply is buffered and spoken at a sentence
end, or at the last word that fits when a sentence runs long (140 characters for the first line, 320
after it), so the first sentence is heard while the rest is still generating. Each line's audio is then
fetched while the previous one is being heard, so the seam between two sentences is milliseconds rather
than a round trip, and synthesis is keyed on the line's text: a replay costs no neuron the second
time.

The caption is gated on the voice, not the other way round. While the voice is on, a reply is revealed
up to the line being spoken, so the words and the audio land together instead of the text streaming a
whole reply ahead of it. Turning the voice off, replaying a reply, or a line that is not heard releases
the held text immediately: a silent reply still reads normally.

Controls: a mute toggle in the header (off by default, remembered per browser), a replay control per
reply, cancel on unmount, a silent review page, and a finished interview that never reads itself aloud.
Pressing the microphone stops the voice: an interviewer gets interrupted, and a talking one would be
transcribed into the answer (gotcha 7).

## Step 2: it listens (built)

One answer: press to speak (hard 180s cap, visible timer, live level meter), talk, press stop. The clip
is posted to one backend route, the text arrives when Whisper is done (see Latency), lands in the
answer box, and
the existing pipeline runs unchanged. A silent or empty take never reaches the box, so it cannot spend
a chat turn.

The audio is parsed in-request and discarded, the rule `resumes.py` already follows, so nothing is
stored. Whisper turbo returns phrase segments (start/end/text), not per-word timings, and they are
unused today: they are what pace, filler and pause numbers will be built on. Holding a clip for the
session is what would make an answer playable back, which V3 and the refused list rule out.

The microphone never opens while the interviewer is speaking.

## Step 3: the camera window

Not built (`PLAN.md` M19).

One local video element, mirrored, off by default, optional, nothing recorded, nothing analyzed,
nothing uploaded, no cost. It exists so that practice feels like being on camera.

Refused and staying refused: server-side video analysis. Appearance must not sit in the same object
as the score, and the published evidence for automated video scoring is thin and litigated. On-device
face metrics go the same way: unproven value for the complexity, and the same objection.

## Latency

| Stage                    | Measured (2026-09-23)                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text after they stop     | 6.8-17.5s for a 112 second clip, upload included, and it scales with length: Whisper is batch, not streaming. This is the wait that needs a progress hint, not a spinner |
| First token of the reply | `llm.chat.completed.latency_ms` is whole-turn, not time to first token. Measure that first                                                                               |
| Hardcore judge           | Silence before the reply on hardcore runs. Read `llm.chat.*` in Loki for the real number                                                                                 |
| First audio of the reply | One line, 0.4-1.3s measured, and later lines are fetched while the previous one is being heard: the gap between two sentences measured 8ms (2026-09-23)                  |

One turn therefore feels like: stop -> 7-18s -> text appears -> Enter -> 2-3s -> voice. The transcription
wait is the number that decides whether voice answering feels usable, and it is the one thing here I
would redesign before shipping to anyone else.

## Cost

Zero dollars. Both directions run inside the free daily allocation, nothing is card-backed, so a spent
allocation is a disabled control rather than an invoice. That allocation is one shared resource with no
per-owner metering, which is a limit rather than a design: see Limits, and what comes next.

A line is paid for once: synthesized audio is cached on its text (8MB in memory, evicted oldest first),
which covers a replay of a reply. The applicant's speech is never synthesized, so nothing in that cache
is a recording.

## Free alternatives (parked)

The rest of the free register, recorded so nobody re-derives it. Nothing here is planned, and the
figures come from Cloudflare's own pricing page (read 2026-09-22) and Groq's rate-limit docs.

| Free route                                   | What it is                                                                                 | A run costs                | Why it is parked                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers AI, Deepgram Aura-2       | Same price as Aura-1, 1.18-1.97s per sentence against 0.41-1.03s                           | 3,300-6,500 neurons        | Measured slower than Aura-1 for the same money. A drop-in swap: one env var                                                                                                                        |
| Cloudflare Workers AI, `whisper` base        | 41.14 neurons per audio minute                                                             | ~620 neurons               | Cheaper sibling of the turbo model at slightly lower quality                                                                                                                                       |
| Cloudflare Workers AI, Pipecat smart-turn-v2 | 0.51 neurons per audio minute                                                              | negligible                 | Turn detection, for a hands-free mode that is not planned                                                                                                                                          |
| Groq free tier, `whisper-large-v3-turbo`     | OpenAI-compatible, no card, limited by audio seconds per day (see the console limits page) | inside the daily audio cap | A second provider for the same job, and also a shared organization budget                                                                                                                          |
| Self-hosted on our infrastructure            | faster-whisper small int8 or whisper.cpp, and Piper or Kokoro for the voice                | 0, own hardware            | No account, no quota, no vendor. Needs a separate small deployment (the backend is 256Mi on one replica) and CPU inference runs only a few times faster than realtime, so concurrency is the limit |
| Self-hosted in the browser                   | whisper.cpp WASM or transformers.js with WebGPU, model downloads to the client             | 0                          | Nothing leaves the device. Costs a 31-142MB download, battery, accuracy at the sizes a browser can hold, and the same generic-sounding voice V1 rejected                                           |

Every one of these keeps the same turn shape: the text lands in the answer box, the applicant
confirms, the pipeline runs. Only the wait and the voice change.

## Gotchas that cost days

1. Microphone capture needs a secure context. Dev over a LAN IP breaks it; localhost is exempt.
2. Pick the recording format from what the browser reports. Safari does not produce the format Chrome
   and Firefox do, and the backend sniffs the container rather than trusting the header.
3. Permission refused, no microphone, and no support need three different messages.
4. The browser's voice is not a cheap fallback, it is a different product. Measured on this machine
   (Brave 1.93 + NixOS): `speechSynthesis.getVoices()` is empty forever, because Chromium's Linux TTS
   constructor returns early without `--enable-speech-dispatcher` and `libspeechd.so.2` is not on the
   loader path. Recognition is worse: Brave answers every attempt with `network`, and there is no way
   to detect that before trying (brave-browser#2802).
5. The first sound needs a user gesture behind it, and a stale utterance keeps talking after a route
   change unless it is cancelled.
6. iOS Safari is the worst case for recording: the container differs and the first sound needs a
   gesture. Test it or treat iOS as text-plus-voice only.
7. Never open the microphone while the interviewer is speaking, or we transcribe our own voice.
8. A take left running is a held microphone and a bill on the shared budget: hard stop it and show the
   timer.
9. Do not put audio inside the SSE stream. Audio rides its own request, one sentence at a time and
   serialized.
10. Log `voice.stt.completed {bytes, latency_ms, engine, chars, audio_s, language, neurons}`,
    `voice.tts.completed {chars, latency_ms, engine, bytes, speaker, cached}` and `voice.unreachable |
unauthorized | quota_exhausted {status}`. Cost, p95, and how often the cloud engine is down then come
    out of Loki with no new infra. Transcription reports its own neuron spend; the voice does not, so its
    cost stays an estimate from characters.
11. Cap concurrent upstream calls the way `resumes.py` caps parses: one replica means a burst of
    uploads is a burst of base64 held in memory.
12. Read the Workers AI envelope before the result: a refusal arrives as HTTP 200 with
    `success: false`, and reading `result` anyway turns a quota message into a KeyError.
13. A failed take still needs to end the session on the client, whatever the engine does: a recorder
    that keeps a hot microphone after an error is the state a visitor cannot get out of.
14. A background probe that fails is not a verdict. A refused capability check once told the visitor
    their deployment had no voice, which sends them off to fix a problem that is not there.
15. A voice is not a default. `@cf/deepgram/aura-1` answers `angus`, an Irish man, and leaving `speaker`
    out of the body measured byte-for-byte identical to asking for him (2026-09-23). An interviewer's
    voice is a cast decision, so it is named in the body and changeable by one env var.
16. A caption held back until the voice reaches it is a caption hostage to the voice. Both waits are
    bounded: the TTS request times out in 15s, and a line that is not audible within 5s is written off
    and its text released. Without them a stuck media pipeline leaves the reply invisible for good.

## Limits, and what comes next

Ordered by what to do first. The numbers are measured; the moves are not done. Everything here is
survivable today because voice is optional infrastructure behind a capability gate (V7): a dead
provider costs the visitor a feature, never the interview.

| Limit                                              | Evidence                                                                                                                                                                                                                                                                         | Move                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The upload cap is bytes, the bill is audio minutes | 8MB of low bitrate Opus decodes to hours, and Whisper bills per audio minute, so one request could spend most of a day's 10,000 neurons. `audio_s` is only known after the transcription, when the money is gone. Arithmetic, not tested: proving it costs the thing it measures | Cap at 1MB (three minutes of Opus is ~540KB), or verify duration before sending                                        |
| The daily budget is one account, shared with dev   | 10,000 neurons a day on a single token, and nothing meters voice per owner. The chat-turn meter counts turns and is blind to it, so one heavy visitor turns voice off for everyone until 00:00 UTC                                                                               | A token per environment, the owner logged on the voice events, and a per-owner voice budget before this is public      |
| A transient 5xx drops the take                     | The clip is still in memory when the upload fails, so the visitor re-records what we already have                                                                                                                                                                                | Retry once on 5xx, both directions. There is no circuit breaker either                                                 |
| The take cap and the read timeout disagree         | 180s take against a 60s upstream read timeout. At the measured rate a full take is ~28s, and ~56s if the provider halves its speed                                                                                                                                               | Widen the read timeout, or shorten the take                                                                            |
| The wait grows with the answer                     | 6.8-17.5s for a 112 second clip, and Whisper is batch rather than streaming                                                                                                                                                                                                      | A progress affordance, chunked transcription at more neurons, or a shorter take. This is the decision to revisit first |
| Nothing watches voice                              | `llm.chat.*` has a Loki panel and alerts; the `voice.*` events exist with measured neurons and no dashboard                                                                                                                                                                      | One panel and one alert, off events that already ship                                                                  |
| The concurrency cap is per pod                     | The semaphore is 2 per replica; the account budget is not coordinated                                                                                                                                                                                                            | Fine at one replica. Replicas need a shared budget before they need tuning                                             |

## Not doing

- Realtime vendor sessions. They replace the rubric with a vendor's memory of the conversation.
- Storing audio, and any recording kept beyond the session. The resume rule (D16) applied to voice.
- Reading faces, on our servers or on theirs. The score stays a judgement of what was said.
- Voice cloning, avatar interviewers, wake words, always-on listening.
- Anything metered, billed or card-backed. If it cannot fit a free tier or our own hardware, no.
