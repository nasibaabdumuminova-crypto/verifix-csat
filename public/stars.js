// Interactive star field — canvas particles that attract to cursor on hover
(function () {
  const canvas = document.createElement('canvas');
  canvas.id = 'starfield';
  canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let W, H, stars = [], mouse = { x: -9999, y: -9999 };
  const STAR_COUNT = 160;
  const ATTRACT_RADIUS = 340;
  const ATTRACT_FORCE = 0.18;

  function resize() {
    W = canvas.width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth || 1280;
    H = canvas.height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 800;
  }

  function createStar() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      baseX: 0,
      baseY: 0,
      r: Math.random() * 2.4 + 0.7,
      alpha: Math.random() * 0.55 + 0.45,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: Math.random() * 0.025 + 0.008,
    };
  }

  function init() {
    resize();
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      const s = createStar();
      s.baseX = s.x;
      s.baseY = s.y;
      stars.push(s);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    for (const s of stars) {
      // Drift
      s.baseX += s.vx;
      s.baseY += s.vy;
      if (s.baseX < -10) s.baseX = W + 10;
      if (s.baseX > W + 10) s.baseX = -10;
      if (s.baseY < -10) s.baseY = H + 10;
      if (s.baseY > H + 10) s.baseY = -10;

      // Attract towards mouse
      const dx = mouse.x - s.baseX;
      const dy = mouse.y - s.baseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let tx = s.baseX, ty = s.baseY;
      if (dist < ATTRACT_RADIUS && dist > 0) {
        const force = (1 - dist / ATTRACT_RADIUS) * ATTRACT_FORCE * ATTRACT_RADIUS;
        tx = s.baseX + (dx / dist) * force;
        ty = s.baseY + (dy / dist) * force;
      }

      // Smooth lerp
      s.x += (tx - s.x) * 0.08;
      s.y += (ty - s.y) * 0.08;

      // Pulse
      s.pulse += s.pulseSpeed;
      const a = s.alpha + Math.sin(s.pulse) * 0.25;

      // Glow near mouse — stronger near cursor, proximity-based size lift
      let glow = 0;
      const md = Math.sqrt((mouse.x - s.x) ** 2 + (mouse.y - s.y) ** 2);
      if (md < ATTRACT_RADIUS) {
        const prox = 1 - md / ATTRACT_RADIUS; // 1 = on cursor, 0 = edge
        glow = prox * 14;
      }

      ctx.save();
      if (glow > 0) {
        ctx.shadowColor = 'rgba(200, 170, 255, 0.95)';
        ctx.shadowBlur = glow;
      }
      const glowBoost = glow > 0 ? Math.min(0.3, glow * 0.03) : 0;
      ctx.globalAlpha = Math.max(0, Math.min(1, a + glowBoost));
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r + (glow > 0 ? glow * 0.18 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw lines between nearby stars — bright near cursor, faint elsewhere
    ctx.strokeStyle = '#c8a8ff';
    const LINE_DIST = 180;
    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j];
        const d = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
        if (d >= LINE_DIST) continue;

        // How close is the midpoint of this line to the mouse?
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dm = Math.sqrt((mouse.x - mx) ** 2 + (mouse.y - my) ** 2);
        const proximity = Math.max(0, 1 - dm / ATTRACT_RADIUS); // 1 = on cursor, 0 = far away
        const fadeDist = 1 - d / LINE_DIST;

        // Ambient bright baseline + strong boost near cursor
        const alpha = fadeDist * (0.07 + proximity * 0.75);
        const width = 0.6 + proximity * 2.0;

        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    requestAnimationFrame(draw);
  }

  document.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  document.addEventListener('mouseleave', () => {
    mouse.x = -9999;
    mouse.y = -9999;
  });
  window.addEventListener('resize', () => {
    resize();
    // re-spread stars that fell outside
    for (const s of stars) {
      if (s.baseX > W) s.baseX = Math.random() * W;
      if (s.baseY > H) s.baseY = Math.random() * H;
    }
  });

  init();
  draw();
})();
