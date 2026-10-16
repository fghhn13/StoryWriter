// Talking to the local backend. In the Tauri window the base URL comes from the shell
// (open_project); in a plain browser (npm run web) pass ?api=http://127.0.0.1:4173.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphView } from "./types";

let base = "";
export const setBase = (url: string) => {
  base = url.replace(/\/+$/, "");
};
export const getBase = () => base;

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? r.statusText);
  return data as T;
}

export const get = <T = unknown>(url: string) => call<T>("GET", url);
export const post = <T = unknown>(url: string, body: unknown = {}) => call<T>("POST", url, body);
export const enc = encodeURIComponent;

export interface Job {
  id: number;
  what: string;
  progress: string[];
}

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

/** The graph document (refetched on every file change), running jobs and toasts. */
export function useGraph(ready: boolean) {
  const [view, setView] = useState<GraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const busy = useRef(false);
  const again = useRef(false);
  const seq = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);

  const reload = useCallback(async () => {
    // coalesce bursts of change events into one fetch at a time
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        setView(await get<GraphView>("/api/graph"));
        setError(null);
      } while (again.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void reload();
    const es = new EventSource(base + "/api/events");
    es.addEventListener("hello", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { jobs: string[] };
      setJobs(d.jobs.map((what, i) => ({ id: -1 - i, what, progress: [] })));
    });
    es.addEventListener("change", () => void reload());
    es.addEventListener("job", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { id: number; state: "start" | "end"; what?: string; ok?: boolean; error?: string };
      if (d.state === "start") setJobs((j) => [...j.filter((x) => x.id !== d.id), { id: d.id, what: d.what ?? "", progress: [] }]);
      else {
        setJobs((j) => j.filter((x) => x.id !== d.id));
        if (d.ok === false) toast("error", `${d.what}: ${d.error}`);
        void reload();
      }
    });
    es.addEventListener("progress", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { id: number; msg: string };
      setJobs((j) => j.map((x) => (x.id === d.id ? { ...x, progress: [...x.progress.slice(-4), d.msg] } : x)));
    });
    return () => es.close();
  }, [ready, reload, toast]);

  /** Run an API call; errors become toasts instead of exceptions. */
  const act = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        const r = await fn();
        void reload();
        return r;
      } catch (e) {
        toast("error", (e as Error).message);
        return undefined;
      }
    },
    [reload, toast],
  );

  return { view, error, jobs, toasts, reload, act, toast };
}
