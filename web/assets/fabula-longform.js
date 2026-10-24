(() => {
  'use strict';

  const options = [
    ['long', '超长篇 50-100万'],
    ['million', '百万级长篇 100万+'],
  ];
  let selectedLongform = '';
  let injectionQueued = false;

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || select.getAttribute('aria-label') !== '篇制') return;

    for (const [value, label] of options) {
      let option = Array.from(select.options).find((item) => item.value === value);
      if (!option) {
        option = document.createElement('option');
        option.value = value;
        const longOption = Array.from(select.options).find((item) => item.value === 'long');
        if (longOption && value === 'million') longOption.after(option);
        else select.append(option);
      }
      option.textContent = label;
    }

    if (selectedLongform && Array.from(select.options).some((item) => item.value === selectedLongform)) {
      select.value = selectedLongform;
    }
  }

  function inject() {
    document.querySelectorAll('select[aria-label="篇制"]').forEach(enhance);
  }

  function scheduleInject() {
    if (injectionQueued) return;
    injectionQueued = true;
    window.setTimeout(() => {
      injectionQueued = false;
      inject();
    }, 0);
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('.nbopt__toggle')) scheduleInject();
  }, true);
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLSelectElement && event.target.getAttribute('aria-label') === '篇制') {
      enhance(event.target);
    }
  }, true);
  document.addEventListener('change', (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement && select.getAttribute('aria-label') === '篇制' &&
      options.some(([value]) => value === select.value)) {
      selectedLongform = select.value;
      scheduleInject();
    }
  }, true);
})();
