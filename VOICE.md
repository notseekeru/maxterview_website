# VOICE: M16 (audio + camera)

Settled 2026-09-22: the interviewer speaks, the applicant speaks, and Cloudflare Workers AI carries
both on its free daily allocation with the browser's built-in voices and recognition as the fallback.
Zero cost either way. The camera is an optional self-view with no processing. `PLAN.md` M16 owns the
milestone; this file owns the decisions and the build order.

**The rule:** voice is I/O around what already exists. The applicant's speech becomes text, the text
goes through `POST /interviews/{id}/chat/stream` exactly as typed text does today, and the
interviewer's reply is read aloud. The transcript stays the graded artifact (`PLAN.md` M16, D16).

That rule kills the tempting shortcut. A vendor realtime session would own the conversation and
bypass the dials, the question-arc budget, the hardcore judge, the move classes, the grader, the
resume injection guard, the per-turn meter and the stored transcript. Two bills, two sources of
truth. Not doing.

## Settled decisions

| #   | Decision                     | Consequence                                                                                                                                                                                                                                   |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Free routes only             | Primary engine: Cloudflare Workers AI. Fallback engine: the browser's built-in voices and recognition. No meter, no paid tier, nothing card-backed anywhere                                                                                   |
| V2  | One backend route, no Worker | The backend calls Workers AI with an account ID and an API token from `backend/.env`, which is the path every other credential already takes (Infisical, Terraform, the k8s Secret, `envFrom`). No edge deployment and no second secret store |
| V3  | The fallback is per session  | The cloud engine records and uploads, the browser engine listens live, and they cannot swap mid-answer. The engine is chosen before the take, and a mid-session failure switches from the next answer with a visible notice                   |
| V4  | Nothing renders mid-answer   | The cloud engine returns nothing until it is done and the fallback's interim text is held. Either way the box fills in when the applicant stops                                                                                               |
| V5  | Confirm before send          | The transcript is what gets scored, so a mistranscription never enters the rubric silently                                                                                                                                                    |
| V6  | Camera is inert              | Optional local self-view, off by default, nothing recorded, nothing analyzed, never in the score                                                                                                                                              |
| V7  | Order of work                | It speaks, then it listens, then the camera window                                                                                                                                                                                            |

Refused outright: realtime vendor sessions, server-side video analysis, stored audio, voice cloning,
avatar interviewers, always-on listening, and anything metered, billed or card-backed.

## The budget: 10,000 neurons a day, shared by the whole account

Cloudflare's free allocation is 10,000 neurons per day per account, reset at 00:00 UTC, and requests
fail once it is gone. At the published rates (`whisper-large-v3-turbo` 46.63 neurons per audio
minute, MeloTTS 18.63 neurons per audio minute), one run of 10 answers at about 15 minutes of the
applicant's speech and 2.5 minutes of the interviewer's speech costs roughly 700 neurons for the
transcription and 47 for the voice. That is about 14 runs a day for free. Past that the fallback
engine takes over, so the ceiling degrades instead of erroring.

Two things to prove with one curl each before wiring anything: that both models actually run on the
free plan (Cloudflare notes that a few resource-intensive models need a paid billing method), and the
real latency of a 90 second clip.

## Step 1: it speaks

Cloud engine: MeloTTS through the backend, one request per sentence, audio decoded and streamed to
the browser. One consistent voice on every machine for about 47 neurons a run. Fallback: the
visitor's own operating system voice, good on Edge and macOS, rough on Chrome for Linux.

The chunking is the same either way: buffer the streamed reply and speak on a sentence boundary or
140 characters, so the first sentence is heard while the rest is still generating.

Controls: mute, a replay control per bubble, cancel on unmount, a silent review page, and a finished
interview must not read itself aloud. The fallback's rough edges, which only apply when the cloud
voice is unavailable: the voice list loads asynchronously and starts empty, Chrome stalls long
network utterances, the first sound needs a user gesture, and leaving the route must cancel speech.

## Step 2: it listens

One answer: press to speak (hard 180s cap, visible timer), talk, press stop. On the cloud engine the
clip goes up and the text arrives a second or two later. On the fallback engine the text is already
there. Either way it lands in the answer box, the applicant confirms or edits, and the existing
pipeline runs unchanged. A silent or empty take must not spend a chat turn on either engine.

Cloud engine: record with the browser's recorder, post the clip to one backend route that forwards it
to Workers AI and returns the text plus word timings. The audio is parsed in-request and discarded,
the rule `resumes.py` already follows, so nothing is stored. Word timings are what make pace, filler
and pause numbers possible, and holding the clip for the session is what makes an answer playable
back.

Fallback engine: the browser's recognition, held words only (interim text discarded, with a level
meter and a timer shown instead), Chrome, Edge and Safari only, no timings, no playback, and the
audio goes to the browser vendor rather than to us.

Neither engine opens the microphone while the interviewer is speaking.

## Step 3: the camera window

One local video element, mirrored, off by default, optional, nothing recorded, nothing analyzed,
nothing uploaded, no cost. It exists so that practice feels like being on camera.

Refused and staying refused: server-side video analysis. Appearance must not sit in the same object
as the score, and the published evidence for automated video scoring is thin and litigated. On-device
face metrics go the same way: unproven value for the complexity, and the same objection.

## Latency

| Stage                    | What to expect                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Text after they stop     | Cloud: 1-3s for the clip. Fallback: immediate, since the engine was listening the whole time |
| First token of the reply | `llm.chat.completed.latency_ms` is whole-turn, not time to first token. Measure that first   |
| Hardcore judge           | Silence before the reply on hardcore runs. Read `llm.chat.*` in Loki for the real number     |
| First audio of the reply | Cloud: one sentence boundary plus provider time. Fallback: immediate for an OS voice         |

One turn therefore feels like: stop -> text appears -> Enter -> 1-3s -> voice.

## Cost

Zero in both directions. The cloud engine runs inside a free daily allocation that normal use fits,
and the fallback engine costs nothing at all. Nothing is metered because nothing is bought, so the
chat-turn meter is untouched, and no path in this feature can produce a bill.

## Free alternatives (parked)

The rest of the free register, recorded so nobody re-derives it. Nothing here is planned, and the
figures come from Cloudflare's own pricing page (read 2026-09-22) and Groq's rate-limit docs.

| Free route                                      | What it is                                                                                 | A run costs                | Why it is parked                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers AI, Deepgram Aura-1 / Aura-2 | 1,363-2,727 neurons per 1k characters                                                      | 3,300-6,500 neurons        | Nicer voice than MeloTTS, at one to three runs a day                                                                                                                                               |
| Cloudflare Workers AI, `whisper` base           | 41.14 neurons per audio minute                                                             | ~620 neurons               | Cheaper sibling of the turbo model at slightly lower quality                                                                                                                                       |
| Cloudflare Workers AI, Pipecat smart-turn-v2    | 0.51 neurons per audio minute                                                              | negligible                 | Turn detection, for a hands-free mode that is not planned                                                                                                                                          |
| Groq free tier, `whisper-large-v3-turbo`        | OpenAI-compatible, no card, limited by audio seconds per day (see the console limits page) | inside the daily audio cap | A second provider for the same job, and also a shared organization budget                                                                                                                          |
| Self-hosted on our infrastructure               | faster-whisper small int8 or whisper.cpp, and Piper or Kokoro for the voice                | 0, own hardware            | No account, no quota, no vendor. Needs a separate small deployment (the backend is 256Mi on one replica) and CPU inference runs only a few times faster than realtime, so concurrency is the limit |
| Self-hosted in the browser                      | whisper.cpp WASM or transformers.js with WebGPU, model downloads to the client             | 0                          | Nothing leaves the device. Costs a 31-142MB download, battery, and accuracy at the sizes a browser can hold                                                                                        |

Every one of these keeps the same turn shape: the text lands in the answer box, the applicant
confirms, the pipeline runs. Only the wait and the browser coverage change.

## Gotchas that cost days

1. Microphone capture needs a secure context. Dev over a LAN IP breaks it; localhost is exempt.
2. Pick the recording format from what the browser reports. Safari does not produce the format Chrome
   and Firefox do, and the cloud engine needs a file.
3. Permission refused, no microphone, and no support need three different messages.
4. The two engines are one mic consumer each, and Android will not run the recorder and the browser's
   recognition at the same time. That is why the engine is chosen before the take and not after.
5. The first sound needs a user gesture behind it, and a stale utterance keeps talking after a route
   change unless it is cancelled.
6. iOS Safari is the worst case: recognition support varies, the voice list is unreliable, the
   recording format differs, and the first sound needs a gesture. Test it or treat iOS as
   text-plus-voice only.
7. Never open the microphone while the interviewer is speaking, or we transcribe our own voice.
8. A take left running is a bill on the shared budget and a stuck screen: hard stop it and show the
   timer.
9. Do not put audio inside the SSE stream. Audio rides its own request, one sentence at a time and
   serialized.
10. Log `voice.stt.completed {audio_s, latency_ms, engine, chars}`, `voice.tts.completed {chars,
latency_ms, engine}` and `voice.fallback {reason}`. Cost, p95, and how often the fallback is
    actually needed then come out of Loki with no new infra.
11. Cap concurrent transcriptions the way `resumes.py` caps parses: one replica means a burst of
    uploads is a burst of held memory.
12. Report a denied microphone or a dead engine through the existing error beacon, which already
    reaches our logs.
13. Test with fake media (Chromium's fake device and fake audio capture flags), or this becomes the
    only untested path in the app.

## Not doing

- Realtime vendor sessions. They replace the rubric with a vendor's memory of the conversation.
- Storing audio, and any recording kept beyond the session. The resume rule (D16) applied to voice.
- Reading faces, on our servers or on theirs. The score stays a judgement of what was said.
- Voice cloning, avatar interviewers, wake words, always-on listening.
- Anything metered, billed or card-backed. If it cannot fit a free tier or our own hardware, no.
