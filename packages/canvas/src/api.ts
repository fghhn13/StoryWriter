import { useEffect, useRef, useState } from "react";
import type { View } from "./types";

export async function get<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data as T;
}

export async function post<T = unknown>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data as T;
}

export const enc = encodeURIComponent;

export interface Job {
  id: number;
  what: string;
  progress: string[];
}

/** The project view, refetched whenever the server reports a file change; plus running jobs. */
export function useProject() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const pending = useRef(false);

  const reload = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setView(await get<View>("/api/project"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
    }
  };

  useEffect(() => {
    void reload();
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => void reload());
    es.addEventListener("job", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { id: number; state: string; what?: string };
      setJobs((js) => (d.state === "start" ? [...js, { id: d.id, what: d.what ?? "", progress: [] }] : js.filter((j) => j.id !== d.id)));
      if (d.state === "end") void reload();
    });
    es.addEventListener("progress", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { id: number; msg: string };
      setJobs((js) => js.map((j) => (j.id === d.id ? { ...j, progress: [...j.progress, d.msg] } : j)));
    });
    return () => es.close();
  }, []);

  return { view, error, jobs, reload };
}
