export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}
export interface Edge {
  from: string;
  to: string;
  key: string;
  pts: Point[];
  start: Point;
  end: Point;
  head: Point | null;
}
export interface Node extends Rect {
  id: string;
  leaf: boolean;
}
export interface Label extends Rect {
  text: string;
}
export type Flow = "down" | "up" | "right" | "left";
export interface Figure {
  index: number;
  flow: Flow | null;
  edges: Edge[];
  nodes: Node[];
  labels: Label[];
}
export interface Finding {
  kind: string;
  figure: number;
  edges: number[];
  msg: string;
}

export const collectFigures = (): Figure[] => {
  const screen = (el: SVGGraphicsElement, p: DOMPoint) => {
    const m = el.getScreenCTM();
    return m
      ? { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
      : { x: p.x, y: p.y };
  };
  const sample = (el: SVGGeometryElement) => {
    const len = el.getTotalLength?.() ?? 0;
    const pts: { x: number; y: number }[] = [];
    for (let d = 0; d < len; d += 2)
      pts.push(screen(el, el.getPointAtLength(d)));
    if (len) pts.push(screen(el, el.getPointAtLength(len)));
    return pts;
  };
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const textRect = (el: Element) => {
    const range = globalThis.document.createRange();
    range.selectNodeContents(el);
    const rs = [...range.getClientRects()];
    return rs.length
      ? {
          l: Math.min(...rs.map((r) => r.left)),
          t: Math.min(...rs.map((r) => r.top)),
          r: Math.max(...rs.map((r) => r.right)),
          b: Math.max(...rs.map((r) => r.bottom)),
        }
      : rect(el);
  };
  const stroked = (el: Element) => {
    const cs = globalThis.getComputedStyle(el);
    return (
      cs.stroke !== "none" && (cs.fill === "none" || el.tagName === "line")
    );
  };
  const clean = (s: string | null) => (s ?? "").trim().replace(/\s+/g, " ");
  const containers = [
    ...globalThis.document.querySelectorAll("[data-figure]"),
    ...[...globalThis.document.querySelectorAll("svg")].filter(
      (s) => s.querySelector("[data-edge]") && !s.closest("[data-figure]"),
    ),
  ];
  return containers.map((box, index) => {
    box.setAttribute("data-figure-index", String(index));
    const edges: Edge[] = [];
    for (const el of box.querySelectorAll("[data-edge]")) {
      const [from = "", to = ""] = (el.getAttribute("data-edge") ?? "")
        .split("->")
        .map((x) => x.trim());
      const shapes = el.matches("path, line, polyline")
        ? [el]
        : [...el.querySelectorAll("path, line, polyline, polygon")];
      const line = shapes.find(stroked) as SVGGeometryElement | undefined;
      const pts = line ? sample(line) : [];
      const [start] = pts;
      const end = pts[pts.length - 1];
      if (!from || !to || !line || !start || !end || pts.length < 2) continue;
      const tip = shapes.find((s) => s !== line);
      const tr = tip && rect(tip);
      el.setAttribute("data-arrow-index", String(edges.length));
      edges.push({
        from,
        to,
        key: `${from}->${to}`,
        pts,
        start,
        end,
        head: tr ? { x: (tr.l + tr.r) / 2, y: (tr.t + tr.b) / 2 } : null,
      });
    }
    const raw = [...box.querySelectorAll("[data-node]")].map((el) => ({
      id: el.getAttribute("data-node") ?? "",
      ...rect(el),
    }));
    const inside = (a: Rect, b: Rect) =>
      a.l >= b.l - 1 && a.r <= b.r + 1 && a.t >= b.t - 1 && a.b <= b.b + 1;
    const area = (a: Rect) => (a.r - a.l) * (a.b - a.t);
    const nodes = raw.map((n) => ({
      ...n,
      leaf: !raw.some((o) => o !== n && inside(o, n) && area(o) < area(n)),
    }));
    const textEls = [...box.querySelectorAll("*")].filter(
      (el) =>
        el.tagName.toLowerCase() === "text" ||
        (!el.closest("svg") &&
          [...el.childNodes].some(
            (n) => n.nodeType === 3 && clean(n.textContent),
          )),
    );
    const labels = textEls
      .map((el) => ({
        text: clean(el.textContent).slice(0, 40),
        ...(el.closest("svg") ? rect(el) : textRect(el)),
      }))
      .filter((x) => x.text && x.r > x.l);
    const flow = box.getAttribute("data-flow") as Flow | null;
    return { index, flow, edges, nodes, labels };
  });
};

const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
const segments = (pts: Point[]) =>
  pts.slice(1).map((b, i) => ({ a: pts[i] ?? b, b }));
const length = (pts: Point[]) =>
  segments(pts).reduce((s, { a, b }) => s + dist(a, b), 0);
const within = (p: Point, r: Rect, pad: number) =>
  p.x >= r.l - pad && p.x <= r.r + pad && p.y >= r.t - pad && p.y <= r.b + pad;
const strictlyInside = (p: Point, r: Rect, pad: number) =>
  p.x > r.l + pad && p.x < r.r - pad && p.y > r.t + pad && p.y < r.b - pad;
const contains = (outer: Rect, inner: Rect) =>
  inner.l >= outer.l - 1 &&
  inner.r <= outer.r + 1 &&
  inner.t >= outer.t - 1 &&
  inner.b <= outer.b + 1;

const segCross = (p1: Point, p2: Point, p3: Point, p4: Point): Point | null => {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 0 && t < 1 && u > 0 && u < 1
    ? { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }
    : null;
};

const pairs = <T>(xs: T[]) =>
  xs.flatMap((a, i) =>
    xs.slice(i + 1).map((b, k) => [a, b, i, i + 1 + k] as const),
  );

const ownedBy = (e: Edge, id: string) =>
  id === e.from ||
  id === e.to ||
  e.from.startsWith(`${id}.`) ||
  e.to.startsWith(`${id}.`);

const finding = (
  kind: string,
  f: Figure,
  edges: number[],
  msg: string,
): Finding[] => [{ kind, figure: f.index, edges, msg }];

const detachedMessage = (e: Edge, from: Rect, to: Rect) => {
  if (within(e.start, from, 12) && within(e.end, to, 12)) return null;
  if (within(e.start, to, 12) && within(e.end, from, 12))
    return `${e.key} の線が逆向き（始点が "${e.to}"、終点が "${e.from}" の側）`;
  return `${e.key} の端点が箱に届いていない（始点・終点は箱から 12px 以内に置く）`;
};

const detached = (f: Figure): Finding[] =>
  f.edges.flatMap((e, i) => {
    const from = f.nodes.find((n) => n.id === e.from);
    const to = f.nodes.find((n) => n.id === e.to);
    if (!from || !to)
      return finding(
        "detached",
        f,
        [i],
        `${e.key}: data-node "${from ? e.to : e.from}" がない`,
      );
    const msg = detachedMessage(e, from, to);
    return msg ? finding("detached", f, [i], msg) : [];
  });

const arrowheadMessage = (e: Edge) => {
  if (!e.head)
    return `${e.key} に矢印の先端がない（線と同じ data-edge のグループに塗りの path を置く）`;
  if (dist(e.head, e.end) <= 14) return null;
  if (dist(e.head, e.start) <= 14)
    return `${e.key} の先端が始点側（"${e.from}" 側）を向いている`;
  return `${e.key} の先端が線の終点から離れている（${Math.round(dist(e.head, e.end))}px）`;
};

const arrowhead = (f: Figure): Finding[] =>
  f.edges.flatMap((e, i) => {
    const msg = arrowheadMessage(e);
    return msg ? finding("arrowhead", f, [i], msg) : [];
  });

const shared = (f: Figure): Finding[] =>
  pairs(f.edges).flatMap(([a, b, i, j]) => {
    const nearEnd = (p: Point) => dist(p, a.start) < 12 || dist(p, a.end) < 12;
    const run =
      a.pts.filter((p) => !nearEnd(p) && b.pts.some((q) => dist(p, q) <= 2))
        .length * 2;
    return run >= 40
      ? finding(
          "shared",
          f,
          [i, j],
          `${a.key} と ${b.key} が ${run}px 重なって走る。分かれ目が別の箱同士をつなぐ矢印に見える`,
        )
      : [];
  });

const through = (f: Figure): Finding[] =>
  f.edges.flatMap((e, i) => {
    const hit = f.nodes.filter(
      (n) =>
        n.leaf &&
        !ownedBy(e, n.id) &&
        e.pts.some((p) => strictlyInside(p, n, 3)),
    );
    return hit.length
      ? finding(
          "through",
          f,
          [i],
          `${e.key} が端点でない箱 ${hit.map((n) => `"${n.id}"`).join(", ")} の中を通る`,
        )
      : [];
  });

const overLabel = (f: Figure): Finding[] =>
  f.edges.flatMap((e, i) => {
    const free = f.labels.filter(
      (l) => !f.nodes.some((n) => n.leaf && contains(n, l)),
    );
    const hit = free.filter((l) => e.pts.some((p) => strictlyInside(p, l, 1)));
    return hit.length
      ? finding(
          "over-label",
          f,
          [i],
          `${e.key} が文字 ${hit
            .slice(0, 3)
            .map((l) => `"${l.text}"`)
            .join(", ")} の上を通る`,
        )
      : [];
  });

const crossPoints = (a: Edge, b: Edge) => {
  const ends = [a.start, a.end, b.start, b.end];
  const pts = segments(a.pts)
    .flatMap((s) => segments(b.pts).map((t) => segCross(s.a, s.b, t.a, t.b)))
    .filter((x): x is Point => !!x && !ends.some((q) => dist(q, x) < 10));
  return pts.filter((x, k) => !pts.slice(0, k).some((q) => dist(q, x) < 6));
};

const crosses = (f: Figure): Finding[] => {
  const found = pairs(f.edges)
    .map(([a, b, i, j]) => ({
      i,
      j,
      n: crossPoints(a, b).length,
      label: `${a.key} × ${b.key}`,
    }))
    .filter((c) => c.n > 0);
  return found.length
    ? finding(
        "cross",
        f,
        [...new Set(found.flatMap((c) => [c.i, c.j]))],
        `交差 ${found.reduce((s, c) => s + c.n, 0)} か所：${found
          .slice(0, 4)
          .map((c) => c.label)
          .join(", ")}`,
      )
    : [];
};

const detours = (f: Figure): Finding[] =>
  f.edges.flatMap((e, i) => {
    const manhattan =
      Math.abs(e.start.x - e.end.x) + Math.abs(e.start.y - e.end.y);
    const len = length(e.pts);
    return len > 1.8 * manhattan && len - manhattan > 120
      ? finding(
          "detour",
          f,
          [i],
          `${e.key} が遠回り（長さ ${Math.round(len)}px、端点の距離 ${Math.round(manhattan)}px）`,
        )
      : [];
  });

const AXIS = {
  down: ["y", 1],
  up: ["y", -1],
  right: ["x", 1],
  left: ["x", -1],
} as const;

const against = (f: Figure): Finding[] => {
  if (!f.flow) return [];
  const [axis, sign] = AXIS[f.flow];
  const back = f.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.end[axis] - e.start[axis]) * sign < -20);
  return back.length
    ? finding(
        "against",
        f,
        back.map(({ i }) => i),
        `流れ（${f.flow}）と逆向きの辺：${back.map(({ e }) => e.key).join(", ")}。戻る辺として意図したものか確かめる`,
      )
    : [];
};

export const judgeFigure = (f: Figure) => ({
  fail: [detached, arrowhead, shared, through, overLabel].flatMap((check) =>
    check(f),
  ),
  look: [crosses, detours, against].flatMap((check) => check(f)),
});
