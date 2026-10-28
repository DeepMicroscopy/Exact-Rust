import { useCallback, useRef, useState } from "react";
import { getCsrfToken } from "../api/client";

export interface UploadItem {
  key: number;
  name: string;
  size: number;
  /** 0..1 while sending */
  progress: number;
  state: "waiting" | "sending" | "processing" | "done" | "error";
  message?: string;
  imageId?: number;
}

/** A file whose name is taken in the image set (or by an earlier file of the same drop): rename it or leave it out. */
export interface NameConflict {
  file: File;
  /** a suggestion that is free */
  suggestion: string;
}

/** `name (2).ext` for `name.ext`, the first one that is not in `taken`. */
export function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Uploads files to an image set one after the other (two at a time) with progress; the server answers per file. Files whose
 * name exists in the set (`existing()`) wait for a decision (`conflict`, `resolve`) before they are sent.
 */
export function useUploads(setId: number, onFinished: () => void, existing: () => string[] = () => []) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [conflicts, setConflicts] = useState<NameConflict[]>([]);
  const waiting = useRef<File[]>([]);
  const next = useRef(0);
  const running = useRef(0);
  const queue = useRef<{ key: number; file: File }[]>([]);

  const patch = useCallback((key: number, p: Partial<UploadItem>) => setItems((l) => l.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const pump = useCallback(() => {
    while (running.current < 2 && queue.current.length) {
      const { key, file } = queue.current.shift()!;
      running.current++;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/v2/image-sets/${setId}/images`);
      const csrf = getCsrfToken();
      if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) patch(key, { progress: e.loaded / e.total, state: e.loaded >= e.total ? "processing" : "sending" });
      };
      xhr.onload = () => {
        running.current--;
        let ok = false;
        try {
          const body = JSON.parse(xhr.responseText);
          const item = body.items?.[0];
          if (xhr.status >= 400 || item?.error) patch(key, { state: "error", message: item?.error ?? body.detail ?? `Error ${xhr.status}`, imageId: item?.id > 0 ? item.id : undefined });
          else {
            patch(key, { state: "done", progress: 1, imageId: item?.id });
            ok = true;
          }
        } catch {
          patch(key, { state: "error", message: `Error ${xhr.status}` });
        }
        if (ok) onFinished(); // the image shows up in the grid at once
        pump();
      };
      xhr.onerror = () => {
        running.current--;
        patch(key, { state: "error", message: "The connection failed." });
        pump();
      };
      const fd = new FormData();
      fd.append("file", file, file.name);
      patch(key, { state: "sending" });
      xhr.send(fd);
    }
  }, [setId, patch, onFinished]);

  const enqueue = useCallback(
    (files: File[]) => {
      const fresh = files.map((f) => ({ key: next.current++, file: f }));
      setItems((l) => [...l, ...fresh.map(({ key, file }) => ({ key, name: file.name, size: file.size, progress: 0, state: "waiting" as const }))]);
      queue.current.push(...fresh);
      pump();
    },
    [pump],
  );

  const taken = useRef<Set<string>>(new Set());
  /** Looks at the next file that has not been checked; stops at the first conflict. */
  const check = useCallback(() => {
    const ok: File[] = [];
    while (waiting.current.length) {
      const f = waiting.current.shift()!;
      if (taken.current.has(f.name)) {
        setConflicts((c) => [...c, { file: f, suggestion: freeName(f.name, taken.current) }]);
        break;
      }
      taken.current.add(f.name);
      ok.push(f);
    }
    if (ok.length) enqueue(ok);
  }, [enqueue]);

  const add = useCallback(
    (files: FileList | File[]) => {
      if (!waiting.current.length) taken.current = new Set([...existing(), ...items.map((i) => i.name)]);
      waiting.current.push(...files);
      check();
    },
    [check, existing, items],
  );
  /** `name` = send it under this name, null = leave it out. */
  const resolve = useCallback(
    (name: string | null) => {
      const [first] = conflicts;
      if (!first) return;
      setConflicts((c) => c.slice(1));
      if (name === null) check();
      else if (taken.current.has(name)) {
        // still taken: ask again with a free suggestion
        waiting.current.unshift(new File([first.file], name, { type: first.file.type }));
        check();
      } else {
        taken.current.add(name);
        enqueue([new File([first.file], name, { type: first.file.type })]);
        check();
      }
    },
    [conflicts, check, enqueue],
  );
  const dismiss = useCallback((key: number) => setItems((l) => l.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems((l) => l.filter((i) => i.state === "sending" || i.state === "waiting" || i.state === "processing")), []);
  return { items, add, clear, dismiss, conflict: conflicts[0] ?? null, resolve, busy: items.some((i) => ["waiting", "sending", "processing"].includes(i.state)) };
}
