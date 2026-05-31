// ─── State ────────────────────────────────────────────────
let currentTeamId = null;
let currentTeam = null;
let currentTheme = '';

const $ = id => document.getElementById(id);

// ─── API Key Management ───────────────────────────────────
function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem('agent-themes-keys') || '{}');
  } catch { return {}; }
}

function saveKeys(keys) {
  localStorage.setItem('agent-themes-keys', JSON.stringify(keys));
}

function getApiPayload() {
  const keys = loadKeys();
  const apiKeys = {};
  if (keys.llmProvider && keys.llmKey) {
    apiKeys.llm = { provider: keys.llmProvider, apiKey: keys.llmKey };
  }
  if (keys.imgProvider && keys.imgKey) {
    apiKeys.image = { provider: keys.imgProvider, apiKey: keys.imgKey };
  }
  return Object.keys(apiKeys).length > 0 ? apiKeys : undefined;
}

// Settings panel
$('settings-btn').addEventListener('click', () => {
  const panel = $('settings-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
  if (!visible) {
    const keys = loadKeys();
    $('llm-provider').value = keys.llmProvider || '';
    $('llm-key').value = keys.llmKey || '';
    $('img-provider').value = keys.imgProvider || '';
    $('img-key').value = keys.imgKey || '';
  }
});

$('settings-save').addEventListener('click', () => {
  saveKeys({
    llmProvider: $('llm-provider').value,
    llmKey: $('llm-key').value,
    imgProvider: $('img-provider').value,
    imgKey: $('img-key').value,
  });
  $('settings-panel').style.display = 'none';
});

// ─── Tab Navigation ───────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  $(`tab-${name}`).classList.add('active');
  $('step-loading').classList.remove('active');
  $('step-preview').classList.remove('active');
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ─── Gallery ──────────────────────────────────────────────
async function loadGallery() {
  try {
    const res = await fetch('/api/teams');
    renderGallery(await res.json());
  } catch (err) {
    console.error(err);
    renderGallery([]);
  }
}

function renderGallery(teams) {
  const grid = $('gallery-grid');
  const empty = $('gallery-empty');

  // Dedupe by theme name — keep latest only
  const seen = new Map();
  for (const t of teams) {
    const key = (t.team.name || t.theme).toLowerCase();
    seen.set(key, t);
  }
  const unique = [...seen.values()];

  if (!unique || unique.length === 0) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = '';

  unique.forEach(entry => {
    const team = entry.team;
    const count = team.agents ? team.agents.length : 0;

    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.innerHTML = `
      <div class="gallery-card-header">
        <div class="gallery-card-emoji">${team.agents?.[0]?.emoji || '🎭'}</div>
        <div>
          <div class="gallery-card-title">${team.name || entry.theme}</div>
        </div>
      </div>
      <div class="gallery-card-desc">${team.description || ''}</div>
      <div class="gallery-card-meta">
        <span class="gallery-card-count">${count} agent${count !== 1 ? 's' : ''}</span>
        <div class="gallery-card-members">
          ${(team.agents || []).slice(0, 5).map(a =>
            `<div class="gallery-card-avatar">${a.emoji || '🤖'}</div>`
          ).join('')}
        </div>
      </div>
      <div class="gallery-card-actions">
        <button class="btn-secondary view-btn">View Team</button>
        <button class="btn-secondary copy-btn-card">📋 Copy</button>
        <button class="btn-secondary dl-btn">⬇</button>
      </div>
    `;

    card.querySelector('.view-btn').addEventListener('click', e => {
      e.stopPropagation();
      openTeam(entry.id, team);
    });

    card.querySelector('.copy-btn-card').addEventListener('click', async e => {
      e.stopPropagation();
      await copyToAgent(entry.id);
    });

    card.querySelector('.dl-btn').addEventListener('click', e => {
      e.stopPropagation();
      window.location.href = `/api/download/${entry.id}`;
    });

    card.addEventListener('click', () => openTeam(entry.id, team));
    grid.appendChild(card);
  });
}

function openTeam(teamId, team) {
  currentTeamId = teamId;
  currentTeam = team;
  currentTheme = team.name || '';

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('step-preview').classList.add('active');
  renderTeam(team);
}

$('gallery-create-btn')?.addEventListener('click', () => switchTab('create'));

// ─── Theme Form ───────────────────────────────────────────
$('theme-form').addEventListener('submit', async e => {
  e.preventDefault();
  const theme = $('theme-input').value.trim();
  if (!theme) return;
  currentTheme = theme;
  await generateTeam(theme);
});

document.querySelectorAll('.pick').forEach(btn => {
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.theme;
    $('theme-input').value = theme;
    currentTheme = theme;
    await generateTeam(theme);
  });
});

// ─── Generate ─────────────────────────────────────────────
async function generateTeam(theme) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('step-loading').classList.add('active');
  $('loading-text').textContent = `Researching "${theme}"...`;
  $('loading-sub').textContent = 'Finding characters, mapping roles, building team';

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, apiKeys: getApiPayload() })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Generation failed');
    }

    const data = await res.json();
    currentTeamId = data.teamId;
    currentTeam = data.team;

    $('step-loading').classList.remove('active');
    renderTeam(currentTeam);
    $('step-preview').classList.add('active');
    loadGallery();
  } catch (err) {
    console.error(err);
    alert(`Error: ${err.message}`);
    $('step-loading').classList.remove('active');
    switchTab('create');
  }
}

// ─── Copy to Agent ────────────────────────────────────────
async function copyToAgent(teamId) {
  const id = teamId || currentTeamId;
  if (!id) return;

  try {
    const res = await fetch(`/api/copy-prompt/${id}`);
    if (!res.ok) throw new Error('Failed');
    const { prompt } = await res.json();

    // Fallback for non-secure contexts (tunnels, HTTP)
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(prompt);
    } else {
      const ta = document.createElement('textarea');
      ta.value = prompt;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('✓ Copied to clipboard — paste into any agent');
  } catch (err) {
    console.error(err);
    showToast('⚠ Copy failed — use Download instead');
  }
}

function showToast(msg) {
  const toast = $('copy-toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

$('copy-btn').addEventListener('click', () => copyToAgent());

// ─── Download ─────────────────────────────────────────────
$('download-btn').addEventListener('click', () => {
  if (currentTeamId) window.location.href = `/api/download/${currentTeamId}`;
});

// ─── Back ─────────────────────────────────────────────────
$('back-btn').addEventListener('click', () => {
  $('step-preview').classList.remove('active');
  switchTab('gallery');
  loadGallery();
});

// ─── Render Team (Org Tree) ───────────────────────────────
function renderTeam(team) {
  $('theme-title').textContent = team.name;
  $('theme-desc').textContent = team.description || '';

  // Sources
  const sourcesEl = $('theme-sources');
  sourcesEl.innerHTML = '';
  if (team.sources && team.sources.length > 0) {
    team.sources.forEach(s => {
      sourcesEl.innerHTML += `<a class="source-link" href="${s.url}" target="_blank" rel="noopener">
        ${s.title}
        <span class="source-type">${s.type}</span>
      </a>`;
    });
  }

  const container = $('org-tree');
  container.innerHTML = '';

  const agentMap = {};
  (team.agents || []).forEach(a => { agentMap[a.name] = a; });

  if (team.hierarchy && team.hierarchy.tree) {
    const rootUl = document.createElement('ul');
    const rootLi = document.createElement('li');
    rootLi.appendChild(buildOrgTree(team.hierarchy.root, team.hierarchy.tree, agentMap, true));
    rootUl.appendChild(rootLi);
    container.appendChild(rootUl);
  } else {
    const grid = document.createElement('div');
    grid.className = 'team-grid';
    (team.agents || []).forEach(agent => grid.appendChild(createCard(agent)));
    container.appendChild(grid);
  }
}

function buildOrgTree(name, tree, agentMap, isRoot) {
  const agent = agentMap[name];
  const node = document.createElement('div');
  node.className = 'org-node' + (isRoot ? ' root' : '');
  node.innerHTML = `
    <div class="org-node-avatar">
      ${agent?.avatarUrl ? `<img src="${agent.avatarUrl}" alt="${name}">` : `<span>${agent?.emoji || '🤖'}</span>`}
    </div>
    <div class="org-node-name">${name}</div>
    <div class="org-node-role">${agent?.role || ''}</div>
    <div class="org-node-desc">${agent?.oneLiner || agent?.vibe || ''}</div>
    ${agent?.responsibilities ? `<div class="org-node-tags">${agent.responsibilities.slice(0, 2).map(r => `<span class="org-node-tag">${r}</span>`).join('')}</div>` : ''}
  `;
  if (agent) node.addEventListener('click', () => openModal(agent));

  const children = tree[name];
  if (!children || children.length === 0) return node;

  // Node card + child <ul> all inside one element (the caller wraps in <li>)
  const frag = document.createDocumentFragment();
  frag.appendChild(node);
  const ul = document.createElement('ul');
  children.forEach(child => {
    const li = document.createElement('li');
    li.appendChild(buildOrgTree(child, tree, agentMap, false));
    ul.appendChild(li);
  });
  frag.appendChild(ul);
  return frag;
}

function createCard(agent) {
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.innerHTML = `
    <div class="agent-avatar">
      ${agent.avatarUrl ? `<img src="${agent.avatarUrl}" alt="${agent.name}">` : `<span>${agent.emoji || '🤖'}</span>`}
      <span class="agent-role-badge">${agent.role}</span>
    </div>
    <div class="agent-info">
      <div class="agent-name">${agent.name}</div>
      <div class="agent-role">${agent.vibe}</div>
      <div class="agent-one-liner">${agent.oneLiner}</div>
      ${agent.responsibilities ? `<div class="agent-tags">${agent.responsibilities.slice(0, 3).map(r => `<span class="agent-tag">${r}</span>`).join('')}</div>` : ''}
    </div>
  `;
  card.addEventListener('click', () => openModal(agent));
  return card;
}

// ─── Modal ────────────────────────────────────────────────
function openModal(agent) {
  $('modal-body').innerHTML = `
    <div class="modal-agent-header">
      <div class="modal-avatar">
        ${agent.avatarUrl ? `<img src="${agent.avatarUrl}" alt="${agent.name}">` : `<span>${agent.emoji || '🤖'}</span>`}
      </div>
      <div>
        <div class="modal-name">${agent.name}</div>
        <div class="modal-role">${agent.role}</div>
        <div class="modal-vibe">${agent.vibe}</div>
      </div>
    </div>
    <div class="modal-body-content">
      <div class="modal-section">
        <h3>Soul</h3>
        <p>${agent.soul}</p>
      </div>
      <div class="modal-section">
        <h3>Communication Style</h3>
        <p>${agent.style}</p>
      </div>
      <div class="modal-section">
        <h3>Role Description</h3>
        <p>${agent.roleDescription}</p>
      </div>
      <div class="modal-section">
        <h3>Responsibilities</h3>
        <ul>${agent.responsibilities.map(r => `<li>${r}</li>`).join('')}</ul>
      </div>
    </div>
  `;
  $('agent-modal').classList.add('active');
}

$('modal-close').addEventListener('click', () => $('agent-modal').classList.remove('active'));
$('agent-modal').addEventListener('click', e => { if (e.target === $('agent-modal')) $('agent-modal').classList.remove('active'); });

// ─── Init ─────────────────────────────────────────────────
loadGallery();
