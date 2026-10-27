import { useState } from "react";

/** Image thumbnail from the server (cached by the browser); shows a placeholder when it cannot be produced. */
export function Thumb({ imageId, alt }: { imageId: number | undefined; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (imageId === undefined || failed) return <div className="thumb placeholder" aria-label={alt} />;
  return <img className="thumb" loading="lazy" alt={alt} src={`/api/v2/images/${imageId}/thumbnail`} onError={() => setFailed(true)} />;
}
