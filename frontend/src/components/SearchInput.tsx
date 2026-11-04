import { useId, useState, type InputHTMLAttributes } from "react";

const KEEP = 8;

function load(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(`exact.search.${key}`) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

/** A search field that remembers the last few terms entered (per field, in this browser) and offers them as suggestions. */
export function SearchInput({ history, value, onChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "list"> & { history: string; value: string; onChange(v: string): void }) {
  const listId = useId();
  const [terms, setTerms] = useState(() => load(history));
  // a term counts once it is finished: Enter, or leaving the field
  const remember = () => {
    const t = value.trim();
    if (t.length < 2) return;
    const next = [t, ...terms.filter((s) => s !== t)].slice(0, KEEP);
    setTerms(next);
    try {
      localStorage.setItem(`exact.search.${history}`, JSON.stringify(next));
    } catch {
      /* private mode: the history lasts for this page only */
    }
  };
  return (
    <>
      <input {...rest} list={listId} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} onBlur={remember} onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (e.key === "Enter") remember();
          // Esc empties the field, a second Esc leaves it
          if (e.key === "Escape") {
            e.stopPropagation();
            if (value) onChange("");
            else e.currentTarget.blur();
          }
        }}
        data-search
      />
      <datalist id={listId}>
        {terms.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </>
  );
}
