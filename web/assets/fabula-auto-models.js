(() => {
  'use strict';

  let settings = null;
  let loading = null;

  const ipcHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (window.__WX_IPC_TOKEN__) headers['X-Fabula-Token'] = window.__WX_IPC_TOKEN__;
    return headers;
  };

  const ipc = async (command, args) => {
    const response = await fetch(`/ipc/${command}`, {
      method: 'POST',
      headers: ipcHeaders(),
      body: JSON.stringify({ args }),
    });
    const lines = (await response.text()).trim().split(/\r?\n/).filter(Boolean);
    const result = JSON.parse(lines.at(-1) || '{}');
    if (!response.ok || result.err) throw new Error(result.err?.message || '操作失败');
    return result.r;
  };

  const loadSettings = () => {
    if (!loading) {
      loading = ipc('get_settings', {}).then((value) => {
        settings = value;
        try { settings.channels = JSON.parse(value.channels || '[]'); } catch { settings.channels = []; }
        return settings;
      });
    }
    return loading;
  };

  const providerId = (heading) => ({
    '接入 DeepSeek': 'deepseek',
    '接入 智谱 GLM': 'zhipu',
    '接入 Kimi（月之暗面）': 'moonshot',
    '接入 通义千问（阿里）': 'qwen',
    '接入 硅基流动': 'siliconflow',
    '接入 火山方舟（豆包）': 'volcengine',
    '接入 MiniMax': 'minimax',
  }[heading] || 'custom');

  const inputFor = (view, labelStart) => Array.from(view.querySelectorAll('.field')).find((field) =>
    field.querySelector('.field__label')?.textContent.trim().startsWith(labelStart))?.querySelector('input');

  const addStyles = () => {
    if (document.getElementById('fabula-auto-model-style')) return;
    const style = document.createElement('style');
    style.id = 'fabula-auto-model-style';
    style.textContent = `
      .fabula-auto-models { display:grid; gap:8px; margin-top:10px; }
      .fabula-auto-models__label { font-size:var(--fs-ui-label); color:var(--c-text-main); }
      .fabula-auto-models__actions { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
      .fabula-auto-models__status { font-size:var(--fs-ui-caption); color:var(--c-text-secondary); }
      .fabula-auto-models__status.is-error { color:var(--c-danger-text); }
    `;
    document.head.appendChild(style);
  };

  const hideModelsUrl = (view) => {
    const field = Array.from(view.querySelectorAll('.field')).find((item) =>
      item.querySelector('.field__label')?.textContent.trim().startsWith('模型列表地址'));
    if (field && field.style.display !== 'none') field.style.display = 'none';
  };

  const showModels = (view, models, baseUrl, apiKey) => {
    view.querySelector('.fabula-auto-models')?.remove();
    addStyles();
    const heading = view.querySelector('.pp__heading')?.textContent.trim() || '';
    const note = inputFor(view, '备注')?.value.trim() || '';
    const panel = document.createElement('div');
    panel.className = 'fabula-auto-models';
    const label = document.createElement('div');
    label.className = 'fabula-auto-models__label';
    label.textContent = '选择模型';
    const select = document.createElement('select');
    select.className = 'set-input';
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    }
    const actions = document.createElement('div');
    actions.className = 'fabula-auto-models__actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'set-btn';
    save.textContent = '测试并保存';
    const status = document.createElement('span');
    status.className = 'fabula-auto-models__status';
    status.setAttribute('role', 'status');

    save.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const model = select.value;
      save.disabled = true;
      status.classList.remove('is-error');
      status.textContent = '测试中...';
      try {
        const tested = await ipc('test_chat_ex', { baseUrl, model, apiKey });
        if (!tested || tested.ok === false) throw new Error(tested?.output || '渠道测试失败');
        const current = await loadSettings();
        const id = `ch_${providerId(heading)}_${Date.now().toString(36)}`;
        const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
        const channel = {
          id,
          providerId: providerId(heading),
          label: note || heading.replace(/^接入\s+/, ''),
          baseUrl,
          modelsUrl,
          plan: 'api',
          models,
          model,
        };
        await ipc('set_channel_key', { id, key: apiKey });
        await ipc('set_settings', {
          channels: JSON.stringify([...current.channels, channel]),
          active_channel: id,
          base_url: baseUrl,
          models_url: modelsUrl,
          default_model: model,
        });
        window.location.reload();
      } catch (error) {
        status.classList.add('is-error');
        status.textContent = error instanceof Error ? error.message : '测试或保存失败';
        save.disabled = false;
      }
    });

    actions.append(save, status);
    panel.append(label, select, actions);
    view.querySelector('.pp__test')?.after(panel);
  };

  const fetchModels = async (view, button) => {
    const baseUrl = inputFor(view, '接口地址')?.value.trim() || '';
    const apiKey = inputFor(view, 'API Key')?.value.trim() || '';
    if (!baseUrl || !apiKey) return;
    button.disabled = true;
    button.dataset.fabulaBusy = '1';
    button.textContent = '正在获取模型...';
    try {
      const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
      const models = await ipc('list_models_ex', { baseUrl, modelsUrl, apiKey });
      if (!Array.isArray(models) || models.length === 0) throw new Error('未获取到可用模型');
      showModels(view, models, baseUrl, apiKey);
    } catch (error) {
      const previous = view.querySelector('.fabula-auto-models');
      if (previous) previous.remove();
      const status = document.createElement('div');
      status.className = 'fabula-auto-models__status is-error fabula-auto-models';
      status.textContent = error instanceof Error ? error.message : '获取模型失败';
      button.after(status);
    } finally {
      button.disabled = false;
      delete button.dataset.fabulaBusy;
      button.textContent = '自动获取模型';
    }
  };

  const prepare = (view) => {
    const heading = view.querySelector('.pp__heading')?.textContent.trim() || '';
    const button = view.querySelector('.pp__test');
    if (!heading.startsWith('接入 ') || !button) return;
    hideModelsUrl(view);
    if (button.dataset.fabulaBusy !== '1' && button.textContent !== '自动获取模型') {
      button.textContent = '自动获取模型';
    }
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest('.pp__test');
    const view = button?.closest('.pp');
    if (!view || !view.querySelector('.pp__heading')?.textContent.trim().startsWith('接入 ')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fetchModels(view, button);
  }, true);

  const inject = () => document.querySelectorAll('.pp').forEach(prepare);
  new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });
  inject();
})();
