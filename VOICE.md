# VOICE: M16 (audio + camera)

Settled 2026-09-22, narrowed the same day: the interviewer speaks, the applicant speaks, and Cloudflare
Workers AI carries both on its free daily allocation. There is no second engine. The browser's own
voices and recognition were built, then removed: a stock TTS voice sounds like a screen reader, and an
interviewer that talks like one destroys the illusion the feature exists to create (V1). The camera is
an optional self-view with no processing. `PLAN.md` M16 owns the milestone; this file owns the
decisions and the build order.

**The rule:** voice is I/O around what already exists. The applicant's speech becomes text, the text
goes through `POST /interviews/{id}/chat/stream` exactly as typed text does today, and the
interviewer's reply is read aloud. The transcript stays the graded artifact (`PLAN.md` M16, D16).

That rule kills the tempting shortcut. A vendor realtime session would own the conversation and
bypass the dials, the question-arc budget, the hardcore judge, the move classes, the grader, the
resume injection guard, the per-turn meter and the stored transcript. Two bills, two sources of
truth. Not doing.

## Settled decisions

| #   | Decision                     | Consequence                                                                                                                                                                                                                                        |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1  | One engine, and it is not the browser | Cloudflare Workers AI only. The browser's voices and recognition were tried and removed. Quality decides it: a stock voice is the generic TTS one, and the interviewer is the product. Availability agrees: Chromium on Linux exposes no voice without `--enable-speech-dispatcher` and a loadable `libspeechd`, and Brave refuses recognition outright with an undetectable `network` error |
| V2  | One backend route, no Worker | The backend calls Workers AI with an account ID and an API token from `backend/.env`, which is the path every other credential already takes (Infisical, Terraform, the k8s Secret, `envFrom`). No edge deployment and no second secret store |
| V3  | A take is one upload         | The clip is recorded, uploaded, transcribed and discarded in the same request. A failure is a sentence on screen and leaves the next take unaffected: there is no engine to swap to, and no audio survives the call (PLAN D16 applied to voice) |
| V4  | Nothing renders mid-answer   | Nothing is transcribed on the client, so the box stays empty until the applicant stops and the words arrive. The level meter and the timer are the whole of the feedback while recording |
| V5  | Confirm before send          | The transcript lands in the answer box and the applicant edits or sends it. The scored text is the one they saw |
| V6  | Camera is inert              | Optional local self-view, off by default, nothing recorded, nothing analyzed, never in the score |
| V7  | The controls admit when the server has no voice | `GET /voice` gates both controls. Unconfigured is a disabled toggle, a disabled mic, and a sentence on screen saying which, never a button that fails on click |

Refused outright: realtime vendor sessions, server-side video analysis, stored audio, voice cloning,
avatar interviewers, always-on listening, and anything metered, billed or card-backed.

## The budget: 10,000 neurons a day, shared by the whole account

Cloudflare's free allocation is 10,000 neurons per day per account, reset at 00:00 UTC, and requests
fail once it is gone. Measured 2026-09-23 against the live account:

| Direction | Model | Measured | Cost |
| --------- | ----- | -------- | ---- |
| Transcription | `whisper-large-v3-turbo` | 17.5s for a 90 second clip, 10 segments, correct text | 46.63 neurons/audio-minute, so ~70 for a 90s take and ~700 for a 15 minute answer set |
| Voice | `@cf/deepgram/aura-1` | 0.41-1.03s per sentence, `audio/mpeg` | 1,363-2,727 neurons per 1k characters, so ~1.4k-3.8k for a run's 1,000-1,400 characters |

The voice is the scarce resource, not the transcription: about 2 to 7 runs a day, where the answers
would allow 14. `@cf/myshell-ai/melotts` is the model this account cannot run at all: it answers
`AiError: Internal server error` (code 3043) on every request, with or without `lang`, while the same
token drives the other two. That is why the default is Aura, and it is also the better outcome: Aura is
the human voice, MeloTTS is the generic one that got the browser engines deleted (V1).

Past the allocation, voice goes unavailable with a reason on screen: a degraded feature, never a bill.

## Step 1: it speaks (built)

Aura-1 through the backend, one request per sentence, played as it arrives. One consistent voice on
every machine, which is the point (V1). The chunking is what makes it feel live: the streamed reply is
buffered and spoken on a sentence boundary or 140 characters, so the first sentence is heard while the
rest is still generating. The model is one env var (`CLOUDFLARE_TTS_MODEL`).

Controls: a mute toggle in the header (off by default, remembered per browser), a replay control per
reply, cancel on unmount, a silent review page, and a finished interview that never reads itself aloud.

## Step 2: it listens (built)

One answer: press to speak (hard 180s cap, visible timer, live level meter), talk, press stop. The clip
is posted to one backend route, the text arrives a second or two later, lands in the answer box, and
the existing pipeline runs unchanged. A silent or empty take never reaches the box, so it cannot spend
a chat turn.

The audio is parsed in-request and discarded, the rule `resumes.py` already follows, so nothing is
stored. Whisper turbo returns phrase segments (start/end/text), not per-word timings, and they are
unused today: they are what pace, filler and pause numbers will be built on. Holding a clip for the
session is what would make an answer playable back, which V3 and the refused list rule out.

The microphone never opens while the interviewer is speaking.

## Step 3: the camera window

One local video element, mirrored, off by default, optional, nothing recorded, nothing analyzed,
nothing uploaded, no cost. It exists so that practice feels like being on camera.

Refused and staying refused: server-side video analysis. Appearance must not sit in the same object
as the score, and the published evidence for automated video scoring is thin and litigated. On-device
face metrics go the same way: unproven value for the complexity, and the same objection.

## Latency

| Stage                    | Measured (2026-09-23)                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Text after they stop     | 17.5s for a 90 second clip, and it scales with length: Whisper is batch, not streaming. This is the wait that needs a progress hint, not a spinner |
| First token of the reply | `llm.chat.completed.latency_ms` is whole-turn, not time to first token. Measure that first     |
| Hardcore judge           | Silence before the reply on hardcore runs. Read `llm.chat.*` in Loki for the real number       |
| First audio of the reply | 0.4-1.0s per sentence, so the first audible gap is one chunk plus one round trip                |

One turn therefore feels like: stop -> 17s -> text appears -> Enter -> 2-3s -> voice. The transcription
wait is the number that decides whether voice answering feels usable, and it is the one thing here I
would redesign before shipping to anyone else.

## Cost

Zero. Both directions run inside the free daily allocation, nothing is metered because nothing is
bought, so the chat-turn meter is untouched. A spent allocation is a disabled control, not an invoice.

## Free alternatives (parked)

The rest of the free register, recorded so nobody re-derives it. Nothing here is planned, and the
figures come from Cloudflare's own pricing page (read 2026-09-22) and Groq's rate-limit docs.

| Free route                                      | What it is                                                                                 | A run costs                | Why it is parked                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers AI, Deepgram Aura-2 | Same price as Aura-1, 1.18-1.97s per sentence against 0.41-1.03s        | 3,300-6,500 neurons        | Measured slower than Aura-1 for the same money. A drop-in swap: one env var |
| Cloudflare Workers AI, `whisper` base           | 41.14 neurons per audio minute                                                             | ~620 neurons               | Cheaper sibling of the turbo model at slightly lower quality                                                                                                                                       |
| Cloudflare Workers AI, Pipecat smart-turn-v2    | 0.51 neurons per audio minute                                                              | negligible                 | Turn detection, for a hands-free mode that is not planned                                                                                                                                          |
| Groq free tier, `whisper-large-v3-turbo`        | OpenAI-compatible, no card, limited by audio seconds per day (see the console limits page) | inside the daily audio cap | A second provider for the same job, and also a shared organization budget                                                                                                                          |
| Self-hosted on our infrastructure               | faster-whisper small int8 or whisper.cpp, and Piper or Kokoro for the voice                | 0, own hardware            | No account, no quota, no vendor. Needs a separate small deployment (the backend is 256Mi on one replica) and CPU inference runs only a few times faster than realtime, so concurrency is the limit |
| Self-hosted in the browser                      | whisper.cpp WASM or transformers.js with WebGPU, model downloads to the client             | 0                          | Nothing leaves the device. Costs a 31-142MB download, battery, accuracy at the sizes a browser can hold, and the same generic-sounding voice V1 rejected                                             |

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
10. Log `voice.stt.completed {bytes, latency_ms, engine, chars}`, `voice.tts.completed {chars,
latency_ms, engine, bytes}` and `voice.unreachable | unauthorized | quota_exhausted {status}`. Cost,
p95, and how often the cloud engine is down then come out of Loki with no new infra.
11. Cap concurrent upstream calls the way `resumes.py` caps parses: one replica means a burst of
    uploads is a burst of base64 held in memory.
12. Read the Workers AI envelope before the result: a refusal arrives as HTTP 200 with
    `success: false`, and reading `result` anyway turns a quota message into a KeyError.
13. A failed take still needs to end the session on the client, whatever the engine does: a recorder
    that keeps a hot microphone after an error is the state a visitor cannot get out of.

## Not doing

- Realtime vendor sessions. They replace the rubric with a vendor's memory of the conversation.
- Storing audio, and any recording kept beyond the session. The resume rule (D16) applied to voice.
- Reading faces, on our servers or on theirs. The score stays a judgement of what was said.
- Voice cloning, avatar interviewers, wake words, always-on listening.
- Anything metered, billed or card-backed. If it cannot fit a free tier or our own hardware, no.
