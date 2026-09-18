import { useEffect, useState } from "react";

import { frontendAuthProblem, onAuthGate } from "@/lib/authHealth";

export function AuthMisconfigBanner() {
    const staticProblem = frontendAuthProblem();
    const [runtimeGate, setRuntimeGate] = useState(false);

    useEffect(() => {
        const unsub = onAuthGate(setRuntimeGate);
        return unsub;
    }, []);

    if (!staticProblem && !runtimeGate) return null;

    return (
        <div role="alert" className="border-b border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs text-amber-700">
            {staticProblem ?? "Clerk auth config mismatch: the backend is demanding a session (401) but this build has no usable publishable key (pk_). The app can’t sign in until the Clerk env vars agree."}
        </div>
    );
}
