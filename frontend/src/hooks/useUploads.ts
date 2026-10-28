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

/** Uploads files to an image set one after the other (two at a time) with progress; the server answers per file. */
export function useUploads(setId: number, onFinished: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
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
        try {
          const body = JSON.parse(xhr.responseText);
          const item = body.items?.[0];
          if (xhr.status >= 400 || item?.error) patch(key, { state: "error", message: item?.error ?? body.detail ?? `Error ${xhr.status}`, imageId: item?.id > 0 ? item.id : undefined });
          else patch(key, { state: "done", progress: 1, imageId: item?.id });
        } catch {
          patch(key, { state: "error", message: `Error ${xhr.status}` });
        }
        if (!queue.current.length && running.current === 0) onFinished();
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

  const add = useCallback(
    (files: FileList | File[]) => {
      const list = [...files];
      const fresh = list.map((f) => ({ key: next.current++, file: f }));
      setItems((l) => [...l, ...fresh.map(({ key, file }) => ({ key, name: file.name, size: file.size, progress: 0, state: "waiting" as const }))]);
      queue.current.push(...fresh);
      pump();
    },
    [pump],
  );
  const clear = useCallback(() => setItems((l) => l.filter((i) => i.state === "sending" || i.state === "waiting" || i.state === "processing")), []);
  return { items, add, clear, busy: items.some((i) => ["waiting", "sending", "processing"].includes(i.state)) };
}
