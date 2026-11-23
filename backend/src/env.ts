export type Config = {
    appEnv: string;
    logLevel: string;
    otelExporterOtlpEndpoint: string;
    databaseUrl: string;
    dbPoolMax: number;
    port: number;

    clerkEnabled: boolean;
    clerkDomain: string;
    clerkJwksUrl: string;
    clerkAudience: string;
    clerkSecretKey: string;
    clerkApiBase: string;
    devUserSub: string;

    corsAllowOrigins: string[];
    rateLimit: string;

    freeChatTurns: number;
    premiumChatTurns: number;
    devChatTurns: number;
    freeResumes: number;
    premiumResumes: number;
    devResumes: number;
    freeRedos: number;
    premiumRedos: number;
    devRedos: number;

    billingMode: string;
    paymongoSecretKey: string;
    paymongoWebhookSecret: string;
    paymongoPlanId: string;
    paymongoSignatureToleranceS: number;
    premiumPriceCentavos: number;
    premiumPeriodDays: number;
    frontendBaseUrl: string;

    llmBaseUrl: string;
    llmModel: string;
    llmApiKey: string;
    llmGraderBaseUrl: string;
    llmGraderModel: string;
    llmMaxTokens: number;
    llmMaxGraderTokens: number;
    llmMaxFeedbackTokens: number;
    llmMaxClosingTokens: number;
    llmMaxReviewTokens: number;
    llmDisableThinking: boolean;
    llmProBaseUrl: string;
    llmProModel: string;
    llmProApiKey: string;
    resumePromptChars: number;

    latexTimeout: number;
    latexConcurrency: number;
    latexQueueWait: number;
    latexMemoryMb: number;
    path: string;

    resumeMaxBytes: number;
    resumeMaxPages: number;
    resumeMaxChars: number;
    resumeParseConcurrency: number;

    cloudflareAccountId: string;
    cloudflareApiToken: string;
    cloudflareSttModel: string;
    cloudflareTtsModel: string;
    cloudflareTtsSpeaker: string;
    voiceMaxUploadBytes: number;
    voiceMaxTtsChars: number;
    voiceConcurrency: number;
    voiceTtsCacheBytes: number;
};

export type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
    return env[key] ?? fallback;
}

function int(env: Env, key: string, fallback: number): number {
    const parsed = Number.parseInt(env[key] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function float(env: Env, key: string, fallback: number): number {
    const parsed = Number.parseFloat(env[key] ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
    return (env[key] ?? String(fallback)).trim().toLowerCase() === "true";
}

function commaList(env: Env, key: string, fallback: string): string[] {
    return str(env, key, fallback)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

export function readConfig(env: Env = process.env): Config {
    const llmBaseUrl = str(env, "LLM_BASE_URL", "").replace(/\/+$/, "");
    const llmModel = str(env, "LLM_MODEL", "");

    return {
        appEnv: str(env, "APP_ENV", "development"),
        logLevel: str(env, "LOG_LEVEL", "INFO").toUpperCase(),
        otelExporterOtlpEndpoint: str(env, "OTEL_EXPORTER_OTLP_ENDPOINT", "").replace(/\/+$/, ""),
        databaseUrl: str(env, "DATABASE_URL", ""),
        dbPoolMax: int(env, "DB_POOL_MAX", 20),
        // Not a Python env var: uvicorn takes its port from argv, so 8000 is what the deployment maps.
        port: int(env, "PORT", 8000),

        clerkEnabled: bool(env, "CLERK_ENABLED", false),
        clerkDomain: str(env, "CLERK_DOMAIN", ""),
        clerkJwksUrl: str(env, "CLERK_JWKS_URL", ""),
        clerkAudience: str(env, "CLERK_AUDIENCE", ""),
        clerkSecretKey: str(env, "CLERK_SECRET_KEY", ""),
        clerkApiBase: str(env, "CLERK_API_BASE", "https://api.clerk.com"),
        devUserSub: str(env, "DEV_USER_SUB", "dev-user"),

        corsAllowOrigins: commaList(env, "CORS_ALLOW_ORIGINS", ""),
        rateLimit: str(env, "RATE_LIMIT", "120/minute").trim(),

        freeChatTurns: int(env, "FREE_CHAT_TURNS", 30),
        premiumChatTurns: int(env, "PREMIUM_CHAT_TURNS", 300),
        devChatTurns: int(env, "DEV_CHAT_TURNS", 100000000),
        freeResumes: int(env, "FREE_RESUMES", 1),
        premiumResumes: int(env, "PREMIUM_RESUMES", 10),
        devResumes: int(env, "DEV_RESUMES", 10),
        freeRedos: int(env, "FREE_REDOS", 1),
        premiumRedos: int(env, "PREMIUM_REDOS", 10),
        devRedos: int(env, "DEV_REDOS", 10),

        billingMode: str(env, "BILLING_MODE", "period"),
        paymongoSecretKey: str(env, "PAYMONGO_SECRET_KEY", ""),
        paymongoWebhookSecret: str(env, "PAYMONGO_WEBHOOK_SECRET", ""),
        paymongoPlanId: str(env, "PAYMONGO_PLAN_ID", ""),
        paymongoSignatureToleranceS: int(env, "PAYMONGO_SIGNATURE_TOLERANCE_S", 300),
        premiumPriceCentavos: int(env, "PREMIUM_PRICE_CENTAVOS", 9900),
        premiumPeriodDays: int(env, "PREMIUM_PERIOD_DAYS", 30),
        frontendBaseUrl: str(env, "FRONTEND_BASE_URL", "http://localhost:5173"),

        llmBaseUrl,
        llmModel,
        llmApiKey: str(env, "LLM_API_KEY", ""),
        llmGraderBaseUrl: str(env, "LLM_GRADER_BASE_URL", llmBaseUrl).replace(/\/+$/, ""),
        llmGraderModel: str(env, "LLM_GRADER_MODEL", llmModel),
        llmMaxTokens: int(env, "LLM_MAX_TOKENS", 512),
        llmMaxGraderTokens: int(env, "LLM_MAX_GRADER_TOKENS", 1024),
        llmMaxFeedbackTokens: int(env, "LLM_MAX_FEEDBACK_TOKENS", 1024),
        llmMaxClosingTokens: int(env, "LLM_MAX_CLOSING_TOKENS", 160),
        llmMaxReviewTokens: int(env, "LLM_MAX_REVIEW_TOKENS", 2400),
        llmDisableThinking: bool(env, "LLM_DISABLE_THINKING", true),
        llmProBaseUrl: str(env, "LLM_PRO_BASE_URL", "").replace(/\/+$/, ""),
        llmProModel: str(env, "LLM_PRO_MODEL", ""),
        llmProApiKey: str(env, "LLM_PRO_API_KEY", ""),
        resumePromptChars: int(env, "RESUME_PROMPT_CHARS", 8000),

        latexTimeout: float(env, "LATEX_TIMEOUT", 20),
        latexConcurrency: int(env, "LATEX_CONCURRENCY", 2),
        latexQueueWait: float(env, "LATEX_QUEUE_WAIT", 5),
        latexMemoryMb: int(env, "LATEX_MEMORY_MB", 192),
        path: str(env, "PATH", "/usr/bin:/bin"),

        resumeMaxBytes: int(env, "RESUME_MAX_BYTES", 2 * 1024 * 1024),
        resumeMaxPages: int(env, "RESUME_MAX_PAGES", 15),
        resumeMaxChars: int(env, "RESUME_MAX_CHARS", 60000),
        resumeParseConcurrency: int(env, "RESUME_PARSE_CONCURRENCY", 2),

        cloudflareAccountId: str(env, "CLOUDFLARE_ACCOUNT_ID", ""),
        cloudflareApiToken: str(env, "CLOUDFLARE_API_TOKEN", ""),
        cloudflareSttModel: str(env, "CLOUDFLARE_STT_MODEL", "@cf/openai/whisper-large-v3-turbo"),
        cloudflareTtsModel: str(env, "CLOUDFLARE_TTS_MODEL", "@cf/deepgram/aura-1"),
        cloudflareTtsSpeaker: str(env, "CLOUDFLARE_TTS_SPEAKER", "hera"),
        voiceMaxUploadBytes: int(env, "VOICE_MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
        voiceMaxTtsChars: int(env, "VOICE_MAX_TTS_CHARS", 600),
        voiceConcurrency: int(env, "VOICE_CONCURRENCY", 2),
        voiceTtsCacheBytes: int(env, "VOICE_TTS_CACHE_BYTES", 8 * 1024 * 1024),
    };
}

export const config: Config = readConfig();

export function reconfigure(patch: Partial<Config>): void {
    Object.assign(config, patch);
}
