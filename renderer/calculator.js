(function () {
  function mountCalculator(root, opts = {}) {
    const captureGlobalKeys = !!opts.captureGlobalKeys;

    root.classList.add('calc-panel');
    root.innerHTML = `
      <div class="calc-display">
        <div class="calc-expr" data-expr></div>
        <input class="calc-screen" data-screen readonly value="0" tabindex="0" />
      </div>
      <div class="calc-presets">
        <button class="calc-pct" data-pct="0.7" type="button">70%</button>
        <button class="calc-pct" data-pct="0.8" type="button">80%</button>
        <button class="calc-pct" data-pct="0.9" type="button">90%</button>
      </div>
      <div class="calc-keys">
        <button class="calc-key fn" data-k="C" type="button">C</button>
        <button class="calc-key fn" data-k="back" type="button">←</button>
        <button class="calc-key fn" data-k="%" type="button">%</button>
        <button class="calc-key op" data-k="/" type="button">÷</button>
        <button class="calc-key" data-k="7" type="button">7</button>
        <button class="calc-key" data-k="8" type="button">8</button>
        <button class="calc-key" data-k="9" type="button">9</button>
        <button class="calc-key op" data-k="*" type="button">×</button>
        <button class="calc-key" data-k="4" type="button">4</button>
        <button class="calc-key" data-k="5" type="button">5</button>
        <button class="calc-key" data-k="6" type="button">6</button>
        <button class="calc-key op" data-k="-" type="button">−</button>
        <button class="calc-key" data-k="1" type="button">1</button>
        <button class="calc-key" data-k="2" type="button">2</button>
        <button class="calc-key" data-k="3" type="button">3</button>
        <button class="calc-key op" data-k="+" type="button">+</button>
        <button class="calc-key zero" data-k="0" type="button">0</button>
        <button class="calc-key" data-k="." type="button">.</button>
        <button class="calc-key eq" data-k="=" type="button">=</button>
      </div>
      <div class="calc-toast" data-toast hidden></div>
    `;

    const screen = root.querySelector('[data-screen]');
    const expr = root.querySelector('[data-expr]');
    const toast = root.querySelector('[data-toast]');

    let display = '0';
    let pending = null;
    let justEvaluated = false;
    let toastTimer = null;

    function fmt(n) {
      if (!isFinite(n)) return 'Err';
      if (Number.isInteger(n)) return n.toLocaleString('en-US');
      return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    }
    function clipboardValue(n) {
      if (!isFinite(n)) return '0';
      return Math.round(n).toString();
    }
    function opSym(o) {
      return { '+': '+', '-': '−', '*': '×', '/': '÷' }[o] || o;
    }
    function render() {
      const n = parseFloat(display);
      screen.value = isNaN(n) ? display : fmt(n);
      expr.textContent = pending ? `${fmt(pending.prev)} ${opSym(pending.op)}` : '';
    }

    function inputDigit(d) {
      if (justEvaluated) {
        display = d;
        justEvaluated = false;
      } else if (display === '0') {
        display = d;
      } else {
        display += d;
      }
      render();
    }
    function inputDot() {
      if (justEvaluated) {
        display = '0.';
        justEvaluated = false;
        return render();
      }
      if (!display.includes('.')) {
        display += '.';
        render();
      }
    }
    function compute(a, b, op) {
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? NaN : a / b;
      }
      return b;
    }
    function applyOp(op) {
      const cur = parseFloat(display);
      if (pending && !justEvaluated) {
        const r = compute(pending.prev, cur, pending.op);
        display = String(r);
      }
      pending = { op, prev: parseFloat(display) };
      justEvaluated = true;
      render();
    }
    function equals() {
      if (!pending) return;
      const cur = parseFloat(display);
      display = String(compute(pending.prev, cur, pending.op));
      pending = null;
      justEvaluated = true;
      render();
    }
    function backspace() {
      if (justEvaluated) return;
      display = display.length > 1 ? display.slice(0, -1) : '0';
      if (display === '-' || display === '') display = '0';
      render();
    }
    function clearAll() {
      display = '0';
      pending = null;
      justEvaluated = false;
      render();
    }
    function percent() {
      const cur = parseFloat(display);
      if (!isFinite(cur)) return;
      display = String(cur / 100);
      justEvaluated = true;
      render();
    }
    async function applyPreset(pct) {
      const cur = parseFloat(display);
      if (!isFinite(cur)) return;
      const result = cur * pct;
      const text = clipboardValue(result);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {}
      showToast(`${Math.round(pct * 100)}% = ${fmt(result)}${copied ? ' (copied)' : ''}`);
    }
    function showToast(msg) {
      toast.textContent = msg;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2000);
    }

    function handleKey(k) {
      if (/^[0-9]$/.test(k)) inputDigit(k);
      else if (k === '.') inputDot();
      else if (k === '+' || k === '-' || k === '*' || k === '/') applyOp(k);
      else if (k === '=') equals();
      else if (k === 'back') backspace();
      else if (k === 'C') clearAll();
      else if (k === '%') percent();
    }

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !root.contains(btn)) return;
      if (btn.dataset.pct) {
        applyPreset(parseFloat(btn.dataset.pct));
      } else if (btn.dataset.k) {
        handleKey(btn.dataset.k);
      }
      screen.focus();
    });

    screen.addEventListener('focus', () => root.classList.add('is-focused'));
    screen.addEventListener('blur', () => root.classList.remove('is-focused'));
    screen.addEventListener('click', () => screen.focus());

    function onKeydown(e) {
      if (!captureGlobalKeys) {
        const ae = document.activeElement;
        const focusedHere = ae === screen || (ae && root.contains(ae));
        if (!focusedHere) return;
      } else {
        const ae = document.activeElement;
        if (ae && ae !== document.body && ae !== screen && ae.tagName !== 'BUTTON') {
          if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') return;
        }
      }
      const k = e.key;
      if (/^[0-9]$/.test(k)) { e.preventDefault(); inputDigit(k); }
      else if (k === '.' || k === ',') { e.preventDefault(); inputDot(); }
      else if (k === '+' || k === '-' || k === '*' || k === '/') { e.preventDefault(); applyOp(k); }
      else if (k === 'Enter' || k === '=') { e.preventDefault(); equals(); }
      else if (k === 'Backspace') { e.preventDefault(); backspace(); }
      else if (k === 'Escape') { e.preventDefault(); clearAll(); }
      else if (k === '%') { e.preventDefault(); percent(); }
    }
    document.addEventListener('keydown', onKeydown);

    if (captureGlobalKeys) screen.focus();
    render();

    return {
      focus: () => screen.focus(),
      destroy: () => document.removeEventListener('keydown', onKeydown),
    };
  }

  if (typeof window !== 'undefined') window.mountCalculator = mountCalculator;
})();
