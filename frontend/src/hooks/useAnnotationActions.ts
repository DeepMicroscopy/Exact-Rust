import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { createAnnotation, deleteAnnotation, patchAnnotation } from "../api/annotations";
import type { Annotation, Vector } from "../api/types";
import { vectorOf, type Pt } from "../viewer-core/geometry";
import { History } from "../viewer-core/history";

/**
 * The annotation edits of one image against the server, with optimistic updates of the cached list and an undo history.
 * Edits are conditional on the last edit time the client saw: when somebody else changed the annotation meanwhile the
 * server answers 409 and the client shows the current state instead of overwriting it.
 */
export function useAnnotationActions(imageId: number, notify: (msg: string) => void, onCreated?: (a: Annotation) => void) {
  const qc = useQueryClient();
  const key = useMemo(() => ["annotations", imageId], [imageId]);
  const history = useRef(new History()).current;

  const list = useCallback(() => qc.getQueryData<Annotation[]>(key) ?? [], [qc, key]);
  const set = useCallback((fn: (l: Annotation[]) => Annotation[]) => qc.setQueryData<Annotation[]>(key, (l) => fn(l ?? [])), [qc, key]);
  const put = useCallback((a: Annotation) => set((l) => (l.some((x) => x.id === a.id) ? l.map((x) => (x.id === a.id ? a : x)) : [...l, a])), [set]);
  const drop = useCallback((id: number) => set((l) => l.filter((x) => x.id !== id)), [set]);
  const current = useCallback((id: number) => list().find((x) => x.id === id), [list]);

  const fail = useCallback(
    (e: unknown, what: string) => {
      if (e instanceof ApiError && e.status === 409) {
        notify("Somebody else changed this annotation; showing their version.");
        void qc.invalidateQueries({ queryKey: key });
      } else {
        notify(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    [notify, qc, key],
  );

  /** PATCH conditional on the last edit time of the cached annotation. */
  const patch = useCallback(
    async (id: number, body: Parameters<typeof patchAnnotation>[1]) => {
      const seen = current(id)?.last_edit_time;
      const out = await patchAnnotation(id, { ...body, ...(seen ? { expected_last_edit_time: seen } : {}) });
      put(out);
      return out;
    },
    [current, put],
  );

  const create = useCallback(
    async (typeId: number, vector: Vector | null) => {
      const tempId = -Date.now();
      const uid = crypto.randomUUID();
      put({ id: tempId, annotation_type: typeId, vector, image: imageId, deleted: false, unique_identifier: uid });
      try {
        let a = await createAnnotation({ image: imageId, annotation_type: typeId, vector, unique_identifier: uid });
        drop(tempId);
        put(a);
        onCreated?.(a);
        history.push({
          label: "create annotation",
          undo: async () => {
            await deleteAnnotation(a.id);
            drop(a.id);
          },
          redo: async () => {
            a = await patchAnnotation(a.id, { deleted: false });
            put(a);
          },
        });
      } catch (e) {
        drop(tempId);
        fail(e, "Could not create the annotation");
      }
    },
    [imageId, put, drop, fail, history, onCreated],
  );

  const update = useCallback(
    async (id: number, vector: Vector) => {
      const before = current(id);
      if (!before) return;
      const old = before.vector;
      put({ ...before, vector });
      try {
        await patch(id, { vector });
        history.push({
          label: "edit annotation",
          undo: async () => void (await patch(id, { vector: old })),
          redo: async () => void (await patch(id, { vector })),
        });
      } catch (e) {
        put(before);
        fail(e, "Could not save the change");
      }
    },
    [current, put, patch, history, fail],
  );

  /**
   * Result of a polygon operation: the first ring replaces the outline of the annotation, every further ring becomes an
   * annotation of the same type (cutting a polygon in two gives two polygons). One undo step takes it all back.
   */
  const replace = useCallback(
    async (id: number, rings: Pt[][]) => {
      const before = current(id);
      if (!before || rings.length === 0) return;
      const old = before.vector;
      const vector = vectorOf(rings[0]);
      put({ ...before, vector });
      const made: Annotation[] = [];
      try {
        await patch(id, { vector });
        for (const ring of rings.slice(1)) {
          const a = await createAnnotation({ image: imageId, annotation_type: before.annotation_type, vector: vectorOf(ring), unique_identifier: crypto.randomUUID() });
          put(a);
          made.push(a);
        }
        history.push({
          label: "edit polygon",
          undo: async () => {
            for (const a of made) {
              await deleteAnnotation(a.id);
              drop(a.id);
            }
            await patch(id, { vector: old });
          },
          redo: async () => {
            for (const a of made) put(await patchAnnotation(a.id, { deleted: false }));
            await patch(id, { vector });
          },
        });
      } catch (e) {
        put(before);
        for (const a of made) drop(a.id);
        fail(e, "Could not save the change");
      }
    },
    [current, put, drop, patch, history, fail, imageId],
  );

  const remove = useCallback(
    async (id: number) => {
      const before = current(id);
      if (!before) return;
      drop(id);
      try {
        await deleteAnnotation(id);
        history.push({
          label: "delete annotation",
          undo: async () => {
            put(await patchAnnotation(id, { deleted: false }));
          },
          redo: async () => {
            await deleteAnnotation(id);
            drop(id);
          },
        });
      } catch (e) {
        put(before);
        fail(e, "Could not delete the annotation");
      }
    },
    [current, drop, put, history, fail],
  );

  /** Changes the class; `vector` also resizes the annotation in the same step (bounding box -> fixed-size box). */
  const changeType = useCallback(
    async (id: number, typeId: number, vector?: Vector) => {
      const before = current(id);
      if (!before || (before.annotation_type === typeId && !vector)) return;
      const old = { type: before.annotation_type, vector: before.vector };
      put({ ...before, annotation_type: typeId, ...(vector ? { vector } : {}) });
      try {
        await patch(id, { annotation_type: typeId, ...(vector ? { vector } : {}) });
        history.push({
          label: "change type",
          undo: async () => void (await patch(id, { annotation_type: old.type, ...(vector ? { vector: old.vector } : {}) })),
          redo: async () => void (await patch(id, { annotation_type: typeId, ...(vector ? { vector } : {}) })),
        });
      } catch (e) {
        put(before);
        fail(e, "Could not change the type");
      }
    },
    [current, put, patch, history, fail],
  );

  // changes of many annotations at once: each goes through the single-annotation action, the history sees one step
  const removeMany = useCallback((ids: number[]) => history.group(`delete ${ids.length} annotations`, async () => void (await Promise.all(ids.map((i) => remove(i))))), [history, remove]);
  const updateMany = useCallback((items: { id: number; vector: Vector }[]) => history.group(`edit ${items.length} annotations`, async () => void (await Promise.all(items.map((i) => update(i.id, i.vector))))), [history, update]);
  const changeTypeMany = useCallback((ids: number[], typeId: number) => history.group(`change type of ${ids.length} annotations`, async () => void (await Promise.all(ids.map((i) => changeType(i, typeId))))), [history, changeType]);
  /** Creates the annotations (pasted copies); answers the ids the server gave them. */
  const createMany = useCallback(
    (items: { typeId: number; vector: Vector }[]) =>
      history.group(`paste ${items.length} annotations`, async () => {
        const ids: number[] = [];
        for (const it of items) {
          const uid = crypto.randomUUID();
          try {
            const a = await createAnnotation({ image: imageId, annotation_type: it.typeId, vector: it.vector, unique_identifier: uid });
            put(a);
            ids.push(a.id);
            let cur = a;
            history.push({
              label: "create annotation",
              undo: async () => {
                await deleteAnnotation(cur.id);
                drop(cur.id);
              },
              redo: async () => {
                cur = await patchAnnotation(cur.id, { deleted: false });
                put(cur);
              },
            });
          } catch (e) {
            fail(e, "Could not paste the annotation");
          }
        }
        return ids;
      }),
    [history, imageId, put, drop, fail],
  );

  const undo = useCallback(() => history.undo().catch((e) => fail(e, "Undo failed")), [history, fail]);
  const redo = useCallback(() => history.redo().catch((e) => fail(e, "Redo failed")), [history, fail]);

  return { history, create, update, replace, remove, changeType, removeMany, updateMany, changeTypeMany, createMany, undo, redo };
}
