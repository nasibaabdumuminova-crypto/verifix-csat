// Interactive star field — canvas particles that attract to cursor on hover,
// plus occasional shooting stars that streak diagonally across the sky.
(function () {
  const canvas = document.createElement('canvas');
  canvas.id = 'starfield';
  canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let W, H, stars = [], shootingStars = [], mouse = { x: -9999, y: -9999 };
  // Bumped per spec: more stars, brighter, with occasional shooting stars.
  const STAR_COUNT = 180;
  const ATTRACT_RADIUS = 260;
  const ATTRACT_FORCE = 0.12;
  // Shooting stars: spawn rate in ms (stochastic — not a fixed cadence).
  const SHOOT_MIN_INTERVAL = 1800;
  const SHOOT_MAX_INTERVAL = 4200;
  let nextShootAt = Date.now() + SHOOT_MIN_INTERVAL;

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
      // Slightly bigger on average — bumped from 0.4–2.2 to 0.6–2.6.
      r: Math.random() * 2.0 + 0.6,
      // Brighter baseline — bumped from 0.2–0.8 to 0.35–1.0.
      alpha: Math.random() * 0.65 + 0.35,
      // A touch more drift so the field feels alive.
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: Math.random() * 0.025 + 0.008,
    };
  }

  // Shooting star — diagonal streak that "falls" across the canvas.
  function spawnShootingStar() {
    // Start from the top half of the screen, random x; angle down-right or down-left.
    const fromLeft = Math.random() > 0.5;
    const startX = fromLeft ? -40 : W + 40;
    const startY = Math.random() * H * 0.55;
    const angle = fromLeft
      ? (Math.PI / 6) + Math.random() * (Math.PI / 5)   // 30°–66° (down-right)
      : Math.PI - ((Math.PI / 6) + Math.random() * (Math.PI / 5)); // mirror
    const speed = 8 + Math.random() * 6;  // 8–14 px/frame
    shootingStars.push({
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,           // fades from 1 → 0
      decay: 0.012,      // ~80 frames ≈ 1.3s
      trail: [],
    });
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
      const a = s.alpha + Math.sin(s.pulse) * 0.15;

      // Glow near mouse
      let glow = 0;
      const md = Math.sqrt((mouse.x - s.x) ** 2 + (mouse.y - s.y) ** 2);
      if (md < ATTRACT_RADIUS) {
        glow = (1 - md / ATTRACT_RADIUS) * 6;
      }

      ctx.save();
      if (glow > 0) {
        ctx.shadowColor = 'rgba(180, 140, 255, 0.8)';
        ctx.shadowBlur = glow;
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r + (glow > 0 ? glow * 0.1 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw lines between nearby stars — bright near cursor, faint elsewhere
    ctx.strokeStyle = '#b48cff';
    const LINE_DIST = 150;
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

        // Far from cursor: very faint (0.03). Near cursor: bright (up to 0.6)
        const alpha = fadeDist * (0.03 + proximity * 0.57);
        const width = 0.4 + proximity * 1.6;

        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Shooting stars — streak with a fading trail.
    const now = Date.now();
    if (now >= nextShootAt) {
      spawnShootingStar();
      nextShootAt = now + SHOOT_MIN_INTERVAL + Math.random() * (SHOOT_MAX_INTERVAL - SHOOT_MIN_INTERVAL);
    }
    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const s = shootingStars[i];
      s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > 14) s.trail.shift();
      s.x += s.vx;
      s.y += s.vy;
      s.life -= s.decay;

      // Draw the tapered trail (tail fading).
      for (let k = 0; k < s.trail.length; k++) {
        const t = s.trail[k];
        const p = k / s.trail.length;
        ctx.globalAlpha = p * s.life * 0.9;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(t.x, t.y, (0.6 + p * 1.8) * s.life, 0, Math.PI * 2);
        ctx.fill();
      }
      // Bright head with a soft halo.
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.shadowColor = 'rgba(220, 200, 255, 0.95)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.2 * s.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (s.life <= 0 || s.x < -60 || s.x > W + 60 || s.y > H + 60) {
        shootingStars.splice(i, 1);
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
