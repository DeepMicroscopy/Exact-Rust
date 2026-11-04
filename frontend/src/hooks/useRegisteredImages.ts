import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Page } from "../api/client";
import type { Registration } from "../api/types";
import { affineOf, invertAffine, type Affine } from "../viewer-core/overlay";

export interface RegisteredImage {
  id: number;
  name: string;
  width: number;
  height: number;
  /** maps the pixels of this image to the pixels of the current one */
  map: Affine;
}

/** The images registered with an image (in either direction), by name; `map` always goes from the other image to this one. */
export function useRegisteredImages(imageId: number) {
  return useQuery({
    queryKey: ["overlay-registrations", imageId],
    queryFn: async (): Promise<RegisteredImage[]> => {
      const [a, b] = await Promise.all([
        api<Page<Registration>>(
          `/api/v2/registrations?source_image__in=${imageId}&limit=1000`,
        ),
        api<Page<Registration>>(
          `/api/v2/registrations?target_image__in=${imageId}&limit=1000`,
        ),
      ]);
      const ids = [
        ...new Set(
          [...a.items, ...b.items].flatMap((r) => [
            r.source_image,
            r.target_image,
          ]),
        ),
      ].filter((i) => i !== imageId);
      const images = ids.length
        ? (
            await api<Page<Omit<RegisteredImage, "map">>>(
              `/api/v2/images?id__in=${ids.join(",")}&fields=id,name,width,height&limit=1000`,
            )
          ).items
        : [];
      const byId = new Map(images.map((i) => [i.id, i]));
      const out = new Map<number, RegisteredImage>();
      // the registration onto this image is used as it is, the other direction is inverted
      for (const r of [...a.items, ...b.items]) {
        const m = r.transformation_matrix && affineOf(r.transformation_matrix);
        if (!m) continue;
        const direct = r.target_image === imageId;
        const other = byId.get(direct ? r.source_image : r.target_image);
        const map = direct ? m : invertAffine(m);
        if (!other || !map || (!direct && out.has(other.id))) continue;
        out.set(other.id, { ...other, map });
      }
      return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
    },
  });
}
