/**
 * Faux-QR — a deterministic grid derived from the token, rendered as SVG.
 * NOT a scannable QR (REPLAN: use a real QR encoder, e.g. `qrcode`). It IS a
 * link to the signed verify URL, so clicking it opens the public validation
 * route — enough to demo the §9 "scan → verify" flow.
 */
import { Link } from "react-router-dom";

function bits(seed: string, n: number): boolean[] {
  // simple FNV-driven LCG to fill the grid deterministically from the token
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push((h & 0x80) !== 0);
  }
  return out;
}

export function Qr({
  data,
  to,
  size = 132,
  dark = "#15140f",
  light = "#fffefb",
}: {
  data: string;
  to?: string;
  size?: number;
  dark?: string;
  light?: string;
}) {
  const N = 21; // typical v1 QR module count
  const cells = bits(data, N * N);
  const cell = size / N;

  // finder-pattern squares in 3 corners for QR look
  const isFinder = (r: number, c: number) => {
    const inBox = (br: number, bc: number) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    const ring = (br: number, bc: number) => {
      const rr = r - br;
      const cc = c - bc;
      const edge = rr === 0 || rr === 6 || cc === 0 || cc === 6;
      const core = rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4;
      return edge || core;
    };
    if (inBox(0, 0)) return ring(0, 0);
    if (inBox(0, N - 7)) return ring(0, N - 7);
    if (inBox(N - 7, 0)) return ring(N - 7, 0);
    return null;
  };

  const svg = (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label="QR de validação">
      <rect width={size} height={size} fill={light} />
      {cells.map((on, i) => {
        const r = Math.floor(i / N);
        const c = i % N;
        const f = isFinder(r, c);
        const filled = f !== null ? f : on;
        if (!filled) return null;
        return <rect key={i} x={c * cell} y={r * cell} width={cell} height={cell} fill={dark} />;
      })}
    </svg>
  );

  if (to) {
    return (
      <Link to={to} title="Abrir validação pública" className="inline-block rounded-lg overflow-hidden">
        {svg}
      </Link>
    );
  }
  return <div className="inline-block rounded-lg overflow-hidden">{svg}</div>;
}
