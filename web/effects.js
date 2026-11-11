// Visual effects: scroll progress, the drifting background seal, the sliding nav indicator
// and the animated beams in "How it works". No dependencies.

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Where the background seal sits for each section (vw, vh, scale, opacity).
const SEAL_POSITIONS = {
  hero: { x: 84, y: 42, s: 1.3, o: 0.07 },
  left: { x: 6, y: 55, s: 1.0, o: 0.06 },
  right: { x: 94, y: 52, s: 1.1, o: 0.06 },
  center: { x: 50, y: 52, s: 1.9, o: 0.04 },
};

export function initEffects() {
  const bar = document.getElementById("progress-bar");
  const seal = document.getElementById("bg-seal");
  const nav = document.getElementById("nav-pill");
  const ind = document.getElementById("nav-ind");
  const links = [...nav.querySelectorAll("a[data-section]")];
  const sealSections = [...document.querySelectorAll("[data-seal-pos]")];

  let activeLink = null;
  let hoverLink = null;

  function moveIndicator(link) {
    if (!link) {
      ind.style.opacity = "0";
      return;
    }
    ind.style.opacity = "1";
    ind.style.width = `${link.offsetWidth}px`;
    ind.style.transform = `translateX(${link.offsetLeft}px)`;
  }

  function update() {
    // Progress bar
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;

    // Scrollspy for the nav
    const probe = innerHeight * 0.35;
    let current = links[0];
    for (const link of links) {
      const target = document.getElementById(link.dataset.section);
      if (target && target.getBoundingClientRect().top - probe <= 0) current = link;
    }
    if (current !== activeLink) {
      activeLink?.classList.remove("active");
      current.classList.add("active");
      activeLink = current;
    }
    if (!hoverLink) moveIndicator(activeLink);

    // Background seal follows the section nearest the middle of the screen
    let best = null;
    let bestDist = Infinity;
    for (const section of sealSections) {
      const r = section.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - innerHeight / 2);
      if (dist < bestDist) {
        bestDist = dist;
        best = section;
      }
    }
    const pos = SEAL_POSITIONS[best?.dataset.sealPos] ?? SEAL_POSITIONS.hero;
    seal.style.transform = `translate3d(${pos.x}vw, ${pos.y}vh, 0) translate(-50%, -50%) scale(${pos.s})`;
    seal.style.opacity = String(pos.o);
  }

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      update();
      ticking = false;
    });
  };

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  for (const link of links) {
    link.addEventListener("mouseenter", () => {
      hoverLink = link;
      moveIndicator(link);
    });
  }
  nav.addEventListener("mouseleave", () => {
    hoverLink = null;
    moveIndicator(activeLink);
  });
  document.fonts?.ready.then(update); // link widths change once the web font loads
  update();
}

// ---------------------------------------------------------------------------
// Beams: curved paths from each node to the hub, with a glowing pulse running along them
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
let beamsObserver;

export function renderBeams() {
  const wrap = document.getElementById("beams");
  const svg = document.getElementById("beams-svg");
  const hub = document.getElementById("beams-hub");
  if (!wrap || !svg || !hub) return;

  const draw = () => {
    const box = wrap.getBoundingClientRect();
    const center = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r: r.width / 2 };
    };
    const h = center(hub);
    const stacked = getComputedStyle(wrap).gridTemplateColumns.split(" ").length === 1;

    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    svg.replaceChildren();

    const nodes = [...wrap.querySelectorAll(".node")];
    nodes.forEach((node, i) => {
      const n = center(node.querySelector(".node-dot"));
      const into = node.dataset.beam === "in";
      const [a, b] = into ? [n, h] : [h, n];
      let d;
      if (stacked) {
        const my = (a.y + b.y) / 2;
        d = `M ${a.x},${a.y} C ${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
      } else {
        const mx = (a.x + b.x) / 2;
        d = `M ${a.x},${a.y} C ${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      }

      const base = document.createElementNS(SVG_NS, "path");
      base.setAttribute("d", d);
      base.setAttribute("class", "beam-base");
      svg.append(base);

      if (reduceMotion) return;
      const pulse = document.createElementNS(SVG_NS, "path");
      pulse.setAttribute("d", d);
      pulse.setAttribute("class", "beam-pulse");
      svg.append(pulse);
      const len = pulse.getTotalLength();
      pulse.style.setProperty("--len", `${len}px`);
      pulse.style.setProperty("--dur", `${2.6 + (i % 3) * 0.45}s`);
      pulse.style.setProperty("--delay", `${into ? i * 0.35 : 1.2 + i * 0.3}s`);
    });
  };

  beamsObserver?.disconnect();
  beamsObserver = new ResizeObserver(() => requestAnimationFrame(draw));
  beamsObserver.observe(wrap);
  document.fonts?.ready.then(draw);
  draw();
}
