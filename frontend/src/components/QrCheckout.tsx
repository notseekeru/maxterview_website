import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { apiDetail, getUsage, startUpgrade } from "@/lib/api";

// QR Ph has no redirect page: `/billing/checkout` answers with a QR and the provider's own expiry, and
// the customer scans it in any PH wallet. The entitlement flips on `payment.paid`, so this hook owns
// the whole leg. A `{"url"}` answer is followed as before, so a redirect rail needs nothing here.
const POLL_MS = 4000;
// Keep polling after the code dies: the payment may have landed just before it did.
const GRACE_MS = 120_000;

/** Seconds until an ISO stamp; 0 when it is absent or already past. */
const secondsLeft = (iso: string) => Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));

export function useQrCheckout() {
    const [qr, setQr] = useState<{ image_url: string; expires_at: string } | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [left, setLeft] = useState(0);

    const start = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const payable = await startUpgrade();
            if (payable.url) {
                window.location.assign(payable.url);
                return;
            }
            // Seed the countdown here, not in the effect: a `left` of 0 means "expired", and the modal
            // renders before the first tick (4 s later) would correct it.
            if (payable.qr) setLeft(secondsLeft(payable.qr.expires_at));
            setQr(payable.qr ?? null);
            setOpen(true);
        } catch (e) {
            // The server's own detail: a 409 says whether a code is still live and for how long.
            setError(apiDetail(e, "Payment is unavailable right now. Try again in a moment."));
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        if (!qr) return;
        // The provider's clock, not a local countdown: a missing deadline reads as already dead, which is
        // the safe direction, so the retry asks for a fresh code.
        const deadline = Date.parse(qr.expires_at) || 0;
        const tick = setInterval(() => {
            setLeft(secondsLeft(qr.expires_at));
            if (Date.now() > deadline + GRACE_MS) {
                clearInterval(tick);
                return;
            }
            // A full reload, not a state patch: the shell's badge, the billing page and this hook all
            // read `/usage` once on mount, and a remount is how they agree without an event bus.
            void getUsage()
                .then((usage) => usage.tier === "premium" && window.location.reload())
                .catch(() => {});
        }, POLL_MS);
        return () => clearInterval(tick);
    }, [qr]);

    // `qr` gates the modal: with no artifact there is nothing to show. Both plan cards mount this hook,
    // so without the gate a stray hidden dialog renders on every billing page.
    const expired = left <= 0;
    const modal = qr && (
        <Modal open={open} onClose={() => setOpen(false)} title="Scan to pay">
            {expired ? (
                <p className="text-muted-foreground">This QR expired. Nothing was charged.</p>
            ) : (
                <>
                    <img src={qr?.image_url} alt="QR Ph code" className="mx-auto h-56 w-56" />
                    <p className="text-muted-foreground">Any QR Ph app works: GCash, Maya, or your bank app.</p>
                    <p className="text-xs text-muted-foreground">
                        Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Waiting for your payment…
                    </p>
                </>
            )}
            {expired && (
                <Button className="w-full" onClick={() => void start()} disabled={busy}>
                    {busy ? "Starting…" : "Get a new QR"}
                </Button>
            )}
        </Modal>
    );

    return { start, busy, error, modal };
}
