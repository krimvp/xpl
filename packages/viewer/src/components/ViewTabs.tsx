/**
 * The view switcher of the header. A tab per view, in a strip that takes the room the header leaves it and
 * scrolls sideways when the tabs do not fit, so that a dozen views never push the controls beside it off
 * the screen: the ends that have more tabs get an arrow and a fade, the mouse wheel, touch and the keyboard
 * move the strip too, and switching view (a click, the menu, a key, a tour, `?view=`) brings the tab of the
 * new view into sight. Next to the strip, a "Views" menu lists every view under its full title and jumps to
 * the one you pick.
 */
import type { View } from "@xpl/core";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useStore, useViewerState } from "../hooks.js";
import { revealOffset, stepIndex, stripEdges, wheelTravel, type StripEdges } from "../tabStrip.js";

/**
 * How far the arrows and fades reach into the strip: a tab that is brought into sight is put this far from
 * the edge, clear of them.
 */
const EDGE_ROOM = 44;

/** What hovering a tab or a menu entry says: the full title (a tab shows only the start of it), then the question the view answers. */
export function viewHint(view: View): string {
  const question = view.scope?.question;
  return question ? `${view.title}\n${question}` : view.title;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls the strip, and nothing else on the page, so that `tab` is in sight. */
function reveal(strip: HTMLElement, tab: HTMLElement): void {
  const box = strip.getBoundingClientRect();
  const at = tab.getBoundingClientRect();
  const left = at.left - box.left + strip.scrollLeft;
  const next = revealOffset(
    { scrollLeft: strip.scrollLeft, width: strip.clientWidth, scrollWidth: strip.scrollWidth },
    { left, right: left + at.width },
    EDGE_ROOM,
  );
  if (Math.abs(next - strip.scrollLeft) >= 0.5) strip.scrollLeft = next;
}

export function ViewTabs({ onMenuOpen }: { onMenuOpen?: () => void }) {
  const store = useStore();
  const { model, viewId } = useViewerState();
  const views = model.views;
  // Which tabs there are (the effects below start over when it changes), not the objects of the views.
  const tabsKey = views.map((v) => v.id).join("\n");
  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<StripEdges>({ start: false, end: false });
  // Only the tab of the current view is in the tab order; the arrow keys move between the others.
  const stop = views.some((v) => v.id === viewId) ? viewId : views[0]?.id;

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const next = stripEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
    setMore((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // The arrows and fades follow the scroll position, the size of the strip and the size of the tabs.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    for (const tab of el.children) resize.observe(tab);
    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [tabsKey, measure]);

  // A new view brings its tab into sight (before the first paint, so that it is there when the page opens).
  useLayoutEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (el && tab) reveal(el, tab);
    measure();
  }, [viewId, tabsKey, measure]);

  // The mouse wheel turns up and down: over the strip it scrolls it sideways. (A native listener, because
  // React's wheel listeners are passive and cannot keep the page from scrolling.)
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented) return;
      const travel = wheelTravel(event, el.clientWidth);
      if (travel === undefined) return;
      const before = el.scrollLeft;
      el.scrollLeft = before + travel;
      // At the end of the strip the wheel is not the strip's any more.
      if (el.scrollLeft !== before) event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const page = (direction: -1 | 1) => {
    const el = strip.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.7),
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };

  // ← → move the focus along the tabs, Home and End to the first and last; Enter or Space picks one.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // (Alt + ← is the browser's Back, not ours.)
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = stepIndex(event.key, at, tabs.length, { prev: "ArrowLeft", next: "ArrowRight" });
    const tab = to === undefined ? undefined : tabs[to];
    if (!tab) return;
    event.preventDefault();
    tab.focus({ preventScroll: true });
    reveal(event.currentTarget, tab);
  };

  return (
    <div className="view-strip" data-testid="view-strip">
      <div
        className="view-tabs-frame"
        data-testid="view-tabs-frame"
        data-more-start={more.start}
        data-more-end={more.end}
      >
        <button
          type="button"
          className="strip-arrow is-start"
          data-testid="strip-arrow-start"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => page(-1)}
        />
        <div
          ref={strip}
          className="view-tabs"
          role="tablist"
          aria-label="Views"
          onKeyDown={onKeyDown}
        >
          {views.map((v) => {
            const active = v.id === viewId;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                className={"tab" + (active ? " is-active" : "")}
                aria-selected={active}
                tabIndex={v.id === stop ? 0 : -1}
                data-view-id={v.id}
                title={viewHint(v)}
                onClick={() => store.setView(v.id)}
              >
                <span className={`tab-icon is-${v.type}`} aria-hidden="true" />
                <span className="tab-title">{v.title}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="strip-arrow is-end"
          data-testid="strip-arrow-end"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => page(1)}
        />
      </div>
      {views.length > 1 && (
        <ViewsMenu
          views={views}
          current={viewId}
          onOpen={onMenuOpen}
          onPick={(id) => store.setView(id)}
        />
      )}
    </div>
  );
}

/**
 * "Views (N)": every view under its full title, with the icon of its type, in a menu under the button. It
 * opens on the current view; ↑ ↓ Home and End move along it, Enter or a click jumps to the view, Escape or
 * a press outside closes it.
 */
function ViewsMenu({
  views,
  current,
  onOpen,
  onPick,
}: {
  views: readonly View[];
  current: string | undefined;
  onOpen?: () => void;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const show = () => {
    onOpen?.();
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // A press outside the button and the menu closes it.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [open]);

  // It opens inside the window and with the current view at hand (and focused, for the keys).
  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el) return;
    const room = 8;
    const box = el.getBoundingClientRect();
    let dx = Math.min(0, document.documentElement.clientWidth - room - box.right);
    if (box.left + dx < room) dx = room - box.left;
    if (dx !== 0) el.style.left = `${dx}px`;
    const item =
      el.querySelector<HTMLElement>('[aria-checked="true"]') ??
      el.querySelector<HTMLElement>('[role="menuitemradio"]');
    item?.focus({ preventScroll: true });
    if (item) el.scrollTop = item.offsetTop - (el.clientHeight - item.offsetHeight) / 2;
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      // Not the selection's Escape: this one closes the menu.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // Focus goes on from the button; the menu is left behind.
      close(true);
    } else {
      const items = [
        ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const to = stepIndex(event.key, at, items.length, { prev: "ArrowUp", next: "ArrowDown" });
      if (to === undefined) return;
      event.preventDefault();
      items[to]?.focus();
    }
  };

  return (
    <div ref={root} className="views-menu">
      <button
        ref={button}
        type="button"
        className={"btn views-btn" + (open ? " is-active" : "")}
        data-testid="views-button"
        aria-label={`Views (${views.length})`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Every view of this explainer: pick one to jump to it"
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (open || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          show();
        }}
      >
        Views
        <span className="views-caret" aria-hidden="true" />
        <span className="count" aria-hidden="true">
          {views.length}
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="views-list"
          role="menu"
          aria-label="Views"
          data-testid="views-menu"
          onKeyDown={onMenuKeyDown}
        >
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              className={"views-item" + (v.id === current ? " is-active" : "")}
              aria-checked={v.id === current}
              tabIndex={-1}
              data-view-id={v.id}
              title={viewHint(v)}
              onClick={() => {
                onPick(v.id);
                close(true);
              }}
            >
              <span className={`tab-icon is-${v.type}`} aria-hidden="true" />
              <span className="views-item-title">{v.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
