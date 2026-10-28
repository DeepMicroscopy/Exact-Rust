/** One parameter of a plugin, as its `parameters_schema` describes it. */
export interface ParamSpec {
  name: string;
  type: "int" | "float" | "bool" | "text" | "choice";
  label?: string;
  help?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  choices?: (string | number)[];
}

export type ParamValues = Record<string, unknown>;

/** The values a schema starts with. */
export const defaultsOf = (schema: ParamSpec[]): ParamValues => Object.fromEntries(schema.map((p) => [p.name, p.default ?? (p.type === "bool" ? false : p.type === "text" ? "" : p.type === "choice" ? p.choices?.[0] : 0)]));

/** The values that differ from the defaults: what a job needs to carry. */
export const changedOf = (schema: ParamSpec[], values: ParamValues): ParamValues => {
  const base = defaultsOf(schema);
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== base[k]));
};

/** A form for the parameters of a plugin. */
export function ParamFields({ schema, values, onChange }: { schema: ParamSpec[]; values: ParamValues; onChange(values: ParamValues): void }) {
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <div className="params">
      {schema.map((p) => {
        const label = p.label ?? p.name;
        if (p.type === "bool")
          return (
            <label key={p.name} className="check" title={p.help}>
              <input type="checkbox" checked={!!values[p.name]} onChange={(e) => set(p.name, e.target.checked)} aria-label={label} /> {label}
            </label>
          );
        return (
          <label key={p.name} className="field" title={p.help}>
            <span>{label}</span>
            {p.type === "choice" ? (
              <select value={String(values[p.name] ?? "")} onChange={(e) => set(p.name, p.choices?.find((c) => String(c) === e.target.value) ?? e.target.value)} aria-label={label}>
                {p.choices?.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {String(c)}
                  </option>
                ))}
              </select>
            ) : p.type === "text" ? (
              <input value={String(values[p.name] ?? "")} onChange={(e) => set(p.name, e.target.value)} aria-label={label} />
            ) : (
              <input
                type="number"
                min={p.min}
                max={p.max}
                step={p.step ?? (p.type === "int" ? 1 : "any")}
                value={Number(values[p.name] ?? 0)}
                onChange={(e) => set(p.name, p.type === "int" ? Math.round(Number(e.target.value)) : Number(e.target.value))}
                aria-label={label}
              />
            )}
            {p.help && <span className="muted small">{p.help}</span>}
          </label>
        );
      })}
    </div>
  );
}
