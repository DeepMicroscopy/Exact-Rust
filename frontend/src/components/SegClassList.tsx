export interface SegClass {
  id: number;
  name: string;
  color: string;
  /** types of one group exclude each other: no voxel is in two of their masks */
  group: string | null;
  /** the volume has a mask of this type */
  hasMask: boolean;
}

interface Props {
  classes: SegClass[];
  /** the type being painted (always shown), or null */
  activeId: number | null;
  shown: Set<number>;
  onToggle(id: number): void;
  onActivate(id: number): void;
}

/** An eye, open or shut. */
function Eye({ on }: { on: boolean }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return on ? (
    <svg {...common}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6A16 16 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

/** A swatch in the colour of the type: filled for the mask being painted, striped for the others (as the planes draw them). */
function Swatch({ color, solid }: { color: string; solid: boolean }) {
  return <span className={`seg-swatch ${solid ? "" : "striped"}`} style={{ ["--c" as string]: color }} />;
}

/**
 * The segmentation types of a volume: the eye shows or hides the mask of a type on the planes (the one being painted is always
 * shown), the name makes a type the one that is painted. Types of a group are listed together under the name of the group.
 */
export function SegClassList({ classes, activeId, shown, onToggle, onActivate }: Props) {
  const groups = [...new Set(classes.map((c) => c.group).filter((g): g is string => !!g))];
  const row = (c: SegClass) => {
    const active = c.id === activeId;
    const on = active || shown.has(c.id);
    return (
      <li key={c.id} className={`seg-class ${active ? "active" : ""}`} data-testid="seg-class" data-type={c.id}>
        <button
          className={`seg-eye ${on ? "on" : ""}`}
          disabled={active}
          onClick={() => onToggle(c.id)}
          aria-pressed={on}
          aria-label={`${on ? "Hide" : "Show"} ${c.name}`}
          title={active ? "The mask being painted is always shown" : c.hasMask ? (on ? "Hide this mask" : "Show this mask (striped) next to the one being painted") : "This volume has no mask of this type yet"}
          data-testid="seg-eye"
        >
          <Eye on={on} />
        </button>
        <Swatch color={c.color} solid={active} />
        <button className="seg-name" onClick={() => onActivate(c.id)} title={active ? "Being painted" : "Paint this type"} data-testid="seg-name">
          {c.name}
        </button>
        {!c.hasMask && <span className="muted small">no mask</span>}
      </li>
    );
  };
  return (
    <div className="seg-classes" data-testid="seg-classes">
      <h3>Segmentation</h3>
      <ul>
        {classes.filter((c) => !c.group).map(row)}
        {groups.map((g) => (
          <li key={`g-${g}`} className="seg-group" data-testid="seg-group">
            <div className="seg-group-name" title="The masks of this group exclude each other: a voxel painted for one is taken from the others">
              ⛓ {g} <span className="muted small">exclusive</span>
            </div>
            <ul>{classes.filter((c) => c.group === g).map(row)}</ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
