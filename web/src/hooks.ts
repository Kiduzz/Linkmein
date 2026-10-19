import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Media } from "./api";
import { onTranscribed } from "./media/transcriber";

/** The user's media library. Refreshes when a transcript lands, and slowly while any are pending (another tab may finish them). */
export function useMediaLibrary() {
  const [media, setMedia] = useState<Media[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const list = await api.media();
    setMedia(list);
    setLoaded(true);
    if (timer.current) clearTimeout(timer.current);
    if (list.some((m) => m.status === "processing")) timer.current = setTimeout(refresh, 10_000);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = onTranscribed(() => void refresh());
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  return { media, loaded, refresh, setMedia };
}

/** Runs an async action, tracking busy state and the last error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
