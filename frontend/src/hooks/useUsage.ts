import { useEffect, useState } from "react";

import { getUsage, type Usage } from "@/lib/api";

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
