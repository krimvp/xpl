/**
 * "Save image" (the zoom toolbar of a diagram): the whole diagram as a PNG, as it looks on screen. The diagram
 * is styled by the page's CSS (tokens in styles.css, the dark ones under `<html data-theme="dark">`), which an
 * SVG drawn as an image does not see. So each element of a copy of the diagram gets the computed values of the
 * properties that paint it, the copy is drawn at its own size (not the viewport's zoom or pan) on the pane's
 * background, and a canvas makes it a PNG at twice that size. Selection, trace and match marks are classes,
 * so their computed colours come along. Nothing is fetched: it works in an offline bundle.
 */

/** The properties that decide how an SVG element paints. */
const PAINT = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "visibility",
  "display",
  "filter",
  "paint-order",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "text-decoration",
] as const;

/** Room around the diagram, in its own units. */
const PAD = 16;
/** Pixels per diagram unit... */
const SCALE = 2;
/** ...unless a side would pass this many pixels (browsers refuse larger canvases). */
const MAX_SIDE = 16384;

/** The first opaque background colour at `el` or above it. */
function backgroundOf(el: Element | null): string {
  for (let at = el; at; at = at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour && colour !== "transparent" && colour !== "rgba(0, 0, 0, 0)") return colour;
  }
  return "#fff";
}

/** A file name for `title`: the characters file systems refuse become "-". */
function imageFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || "diagram"}.png`;
}

/**
 * The PNG of `content` (the diagram's group, drawn in its own coordinates from 0,0 to `width`,`height`),
 * on the background of the pane it sits in.
 */
async function diagramPng(content: SVGGElement, width: number, height: number): Promise<Blob> {
  const copy = content.cloneNode(true) as SVGGElement;
  const from = [content, ...content.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, i) => {
    const computed = getComputedStyle(el);
    const target = to[i] as SVGElement;
    target.setAttribute(
      "style",
      PAINT.map((name) => `${name}:${computed.getPropertyValue(name)}`).join(";"),
    );
  });
  copy.setAttribute("transform", `translate(${PAD} ${PAD})`);

  const w = width + 2 * PAD;
  const h = height + 2 * PAD;
  const scale = Math.min(SCALE, MAX_SIDE / Math.max(w, h));
  const px = Math.ceil(w * scale);
  const py = Math.ceil(h * scale);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("xmlns", ns);
  svg.setAttribute("width", String(px));
  svg.setAttribute("height", String(py));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const back = document.createElementNS(ns, "rect");
  back.setAttribute("width", "100%");
  back.setAttribute("height", "100%");
  back.setAttribute("fill", backgroundOf(content.ownerSVGElement));
  svg.append(back, copy);

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(svg),
  )}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = py;
  canvas.getContext("2d")!.drawImage(image, 0, 0, px, py);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"),
  );
}

/** Saves `content` as `<title>.png` (a download). */
export async function saveDiagramImage(
  content: SVGGElement,
  width: number,
  height: number,
  title: string,
): Promise<void> {
  const url = URL.createObjectURL(await diagramPng(content, width, height));
  const link = document.createElement("a");
  link.href = url;
  link.download = imageFileName(title);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
