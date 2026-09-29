/**
 * The elements a folded ghost stands for ("rest of <file>", "N more"), most referenced first, each with the
 * kinds and the number of references that lead to it. Picking one adds it to the view. Shown in the menu
 * of the ghost box (`menu`) and in the details panel of a stub that leads to it.
 */
import type { GhostTarget } from "@xpl/core";

export function GhostTargetList({
  targets,
  onPick,
  menu = false,
}: {
  targets: readonly GhostTarget[];
  onPick: (target: string) => void;
  menu?: boolean;
}) {
  return (
    <ul
      className="ghost-targets"
      role={menu ? "none" : undefined}
      data-testid={menu ? undefined : "ghost-targets"}
    >
      {targets.map((t) => (
        <li key={t.target} role={menu ? "none" : undefined}>
          <button
            type="button"
            role={menu ? "menuitem" : undefined}
            className="ghost-target"
            data-ghost-target={t.target}
            title={`Add ${t.label} (${t.target}) to the view`}
            onClick={() => onPick(t.target)}
          >
            <span className="ghost-target-label">{t.label}</span>
            <span className="ghost-target-badge">{t.symbolKind ?? t.kind}</span>
            <span className="ghost-target-count">
              {t.kinds.length === 1 ? `${t.kinds[0]} ` : ""}×{t.count}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
