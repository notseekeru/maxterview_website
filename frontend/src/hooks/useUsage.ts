import { useEffect, useState } from "react";

import { getUsage, type Usage } from "@/lib/api";

/** GET /usage, with the failure kept separate from "still loading": a plan card that renders an
 *  empty tier on a failed request reads as "Free", which is a claim the server never made. */
export function useUsage() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        getUsage()
            .then((u) => alive && setUsage(u))
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, []);

    return { usage, failed, loading: !usage && !failed };
}
