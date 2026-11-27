import { useState } from "react";

/** Image thumbnail from the server (cached by the browser); shows a placeholder when it cannot be produced. */
export function Thumb({ imageId, alt }: { imageId: number | undefined; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (imageId === undefined || failed) return <div className="thumb placeholder" aria-label={alt} />;
  return <img className="thumb" loading="lazy" decoding="async" fetchPriority="low" alt={alt} src={`/api/v2/images/${imageId}/thumbnail`} onError={() => setFailed(true)} />;
}

/** A small picture of the place an annotation marks, with its outline; a placeholder when there is none (an annotation outside of the image, a label). */
export function AnnotationPreview({ id }: { id: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="thumb placeholder" aria-label="No preview" />;
  return <img className="thumb" loading="lazy" decoding="async" alt="Preview of the annotation" data-testid="annotation-preview" src={`/api/v2/annotations/${id}/preview?size=256`} onError={() => setFailed(true)} />;
}
