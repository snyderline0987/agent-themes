const express = require('express');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store
const teams = new Map();

// ─── Route: List teams ────────────────────────────────────
app.get('/api/teams', (req, res) => {
  const list = [];
  teams.forEach((data, id) => {
    list.push({
      id,
      theme: data.theme,
      team: {
        name: data.team.name,
        description: data.team.description,
        sources: data.team.sources || [],
        hierarchy: data.team.hierarchy || null,
        agents: (data.team.agents || []).map(a => ({
          name: a.name, role: a.role, emoji: a.emoji,
          vibe: a.vibe, oneLiner: a.oneLiner,
          soul: a.soul, style: a.style,
          roleDescription: a.roleDescription,
          responsibilities: a.responsibilities
        }))
      },
      createdAt: data.createdAt
    });
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// ─── Route: Generate team via LLM ─────────────────────────
app.post('/api/generate', async (req, res) => {
  const { theme, apiKeys } = req.body;
  if (!theme || !theme.trim()) return res.status(400).json({ error: 'Theme is required' });

  const teamId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const team = await generateTeam(theme.trim(), apiKeys);
    // Remove any existing team with the same theme name
    for (const [id, data] of teams) {
      if ((data.team.name || data.theme).toLowerCase() === (team.name || theme).toLowerCase()) {
        teams.delete(id);
      }
    }
    teams.set(teamId, { theme: theme.trim(), team, createdAt: new Date().toISOString() });
    res.json({ teamId, team });
  } catch (err) {
    console.error('Generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Generate avatar via image API ─────────────────
app.post('/api/avatar', async (req, res) => {
  const { name, description, apiKeys } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const result = await generateAvatar(name, description, apiKeys);
    res.json(result);
  } catch (err) {
    console.error('Avatar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Copy-to-agent prompt ──────────────────────────
app.get('/api/copy-prompt/:teamId', (req, res) => {
  const data = teams.get(req.params.teamId);
  if (!data) return res.status(404).json({ error: 'Team not found' });

  const prompt = buildCopyPrompt(data);
  res.json({ prompt });
});

// ─── Route: Update team ───────────────────────────────────
app.put('/api/team/:teamId', (req, res) => {
  const existing = teams.get(req.params.teamId);
  if (!existing) return res.status(404).json({ error: 'Team not found' });
  existing.team = req.body.team;
  teams.set(req.params.teamId, existing);
  res.json({ ok: true });
});

// ─── Route: Delete team ────────────────────────────────────
app.delete('/api/team/:teamId', (req, res) => {
  const existed = teams.delete(req.params.teamId);
  if (!existed) return res.status(404).json({ error: 'Team not found' });
  res.json({ ok: true });
});

// ─── Route: Download zip ──────────────────────────────────
app.get('/api/download/:teamId', (req, res) => {
  const data = teams.get(req.params.teamId);
  if (!data) return res.status(404).json({ error: 'Team not found' });

  const zip = archiver('zip', { zlib: { level: 9 } });
  const zipName = `agent-team-${data.theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  res.attachment(`${zipName}.zip`);
  zip.pipe(res);

  // Per-agent files
  data.team.agents.forEach(agent => {
    const folder = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const teammates = data.team.agents.filter(a => a.name !== agent.name);
    const reportsTo = getReportsTo(agent.name, data.team.hierarchy);
    const directs = getDirects(agent.name, data.team.hierarchy);

    zip.append(renderIdentityMd(agent), { name: `${folder}/IDENTITY.md` });
    zip.append(renderSoulMd(agent), { name: `${folder}/SOUL.md` });
    zip.append(renderAgentsMd(agent, data.theme, teammates, reportsTo, directs), { name: `${folder}/AGENTS.md` });
    zip.append(renderAgentJson(agent, data.theme, teammates, reportsTo, directs), { name: `${folder}/agent.json` });
    zip.append(renderUserMd(), { name: `${folder}/USER.md` });
  });

  // Team-level files
  zip.append(renderReadme(data), { name: 'README.md' });
  zip.append(renderTeamJson(data), { name: 'team.json' });
  zip.append(renderDockerCompose(data), { name: 'docker-compose.yml' });
  zip.append(renderOpenClawExample(), { name: 'openclaw.example.json' });
  zip.append(renderEnvExample(), { name: '.env.example' });

  zip.finalize();
});

// ═══════════════════════════════════════════════════════════
// TEAM GENERATION
// ═══════════════════════════════════════════════════════════

async function generateTeam(themeName, apiKeys) {
  // 1. Check pre-built themes
  const prebuilt = findPrebuiltTheme(themeName);
  if (prebuilt) return prebuilt;

  // 2. Use LLM to research
  if (apiKeys && apiKeys.llm) {
    return await researchWithLLM(themeName, apiKeys.llm);
  }

  // 3. Fallback — generic template
  return {
    name: themeName,
    description: `Agent team themed after "${themeName}"`,
    sources: [],
    needsResearch: true,
    agents: buildGenericTeam(themeName)
  };
}

function findPrebuiltTheme(themeName) {
  const normalized = themeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const themesDir = path.join(__dirname, 'themes');
  if (!fs.existsSync(themesDir)) return null;

  for (const file of fs.readdirSync(themesDir).filter(f => f.endsWith('.json'))) {
    const themeData = JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8'));
    const themeNorm = themeData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (themeNorm === normalized) return themeData;
  }
  return null;
}

async function researchWithLLM(themeName, llmConfig) {
  const { provider, apiKey, model } = llmConfig;
  if (!apiKey) throw new Error('LLM API key required');

  const prompt = `You are a team building assistant. Research the fictional universe "${themeName}" and create an AI agent team based on its characters.

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks, no explanation.

Return this exact structure:
{
  "name": "Team Name",
  "description": "One line team description",
  "sources": [
    {"title": "Source Name", "url": "https://...", "type": "wiki|official|fan"},
    {"title": "Source Name", "url": "https://...", "type": "wiki|official|fan"}
  ],
  "hierarchy": {
    "root": "Character Name",
    "tree": {
      "Character Name": ["Report 1", "Report 2"],
      "Report 1": ["Sub-report"]
    }
  },
  "agents": [
    {
      "name": "Character Name",
      "role": "Team Role (e.g. Leader, Specialist, Operator, Communicator)",
      "emoji": "single emoji",
      "vibe": "short vibe descriptor",
      "oneLiner": "One-line personality summary",
      "soul": "2-3 sentence personality description capturing their essence",
      "style": "How they communicate - mannerisms, tone, catchphrases",
      "roleDescription": "How their fictional role maps to agent responsibilities",
      "responsibilities": ["resp1", "resp2", "resp3", "resp4"]
    }
  ]
}

Pick 4-6 characters that form a well-rounded team. Include at least 2-3 reference sources (Wikipedia, official site, fan wiki). The hierarchy should reflect the character dynamics from the source material.`;

  let url, headers, body;

  if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agent-themes.dev',
    };
    body = JSON.stringify({
      model: model || 'google/gemini-2.5-flash-preview-05-20',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 4000,
    });
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash-preview-05-20'}:generateContent?key=${apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4000 },
    });
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    body = JSON.stringify({
      model: model || 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 4000,
    });
  } else {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(url, { method: 'POST', headers, body });
  const raw = await resp.text();

  if (!resp.ok) {
    throw new Error(`LLM API error ${resp.status}: ${raw.slice(0, 200)}`);
  }

  // Extract text from response
  let text;
  const respJson = JSON.parse(raw);

  if (provider === 'gemini') {
    text = respJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    text = respJson.choices?.[0]?.message?.content || '';
  }

  // Strip markdown code blocks if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

  const team = JSON.parse(text);

  // Validate minimum structure
  if (!team.agents || !Array.isArray(team.agents) || team.agents.length === 0) {
    throw new Error('LLM returned invalid team structure');
  }

  // Ensure each agent has required fields
  team.agents = team.agents.map(a => ({
    name: a.name || 'Agent',
    role: a.role || 'Member',
    emoji: a.emoji || '🤖',
    vibe: a.vibe || 'Versatile',
    oneLiner: a.oneLiner || `The ${a.role || 'team member'}`,
    soul: a.soul || 'A capable team member.',
    style: a.style || 'Clear and direct.',
    roleDescription: a.roleDescription || 'Handles assigned tasks.',
    responsibilities: a.responsibilities || ['Task execution'],
    ...a,
  }));

  return team;
}

// ─── Avatar Generation ────────────────────────────────────
async function generateAvatar(name, description, apiKeys) {
  if (!apiKeys || !apiKeys.image) {
    return { needsGeneration: true };
  }

  const { provider, apiKey, model } = apiKeys.image;
  const prompt = `Portrait photo of "${name}" from ${description || 'a fictional universe'}, professional headshot style, dramatic lighting, dark background, high quality`;

  if (provider === 'openrouter' || provider === 'openai') {
    const url = provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/images/generations'
      : 'https://api.openai.com/v1/images/generations';
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({
      model: model || 'openai/dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
    });

    const fetch = (await import('node-fetch')).default;
    const resp = await fetch(url, { method: 'POST', headers, body });
    const data = await resp.json();
    return { url: data.data?.[0]?.url };
  }

  return { needsGeneration: true };
}

// ─── Copy Prompt Builder ──────────────────────────────────
function buildCopyPrompt(data) {
  const { team, theme } = data;
  const parts = [];

  parts.push(`# Agent Team: ${team.name || theme}`);
  parts.push('');
  parts.push(team.description || '');
  parts.push('');

  // Sources
  if (team.sources && team.sources.length > 0) {
    parts.push('## Reference Sources');
    parts.push('');
    team.sources.forEach(s => {
      parts.push(`- [${s.title}](${s.url}) (${s.type})`);
    });
    parts.push('');
  }

  // Hierarchy overview
  if (team.hierarchy) {
    parts.push('## Team Hierarchy');
    parts.push('```');
    renderHierarchyLines(team.hierarchy).forEach(l => parts.push(l));
    parts.push('```');
    parts.push('');
  }

  // Each agent
  team.agents.forEach(agent => {
    const reportsTo = getReportsTo(agent.name, team.hierarchy);
    const directs = getDirects(agent.name, team.hierarchy);

    parts.push(`---`);
    parts.push('');
    parts.push(`## ${agent.emoji || '🤖'} ${agent.name} — ${agent.role}`);
    parts.push('');
    parts.push(`**Vibe:** ${agent.vibe}`);
    parts.push(`**Summary:** ${agent.oneLiner}`);
    if (reportsTo) parts.push(`**Reports to:** ${reportsTo}`);
    if (directs.length > 0) parts.push(`**Manages:** ${directs.join(', ')}`);
    parts.push('');
    parts.push('### Personality');
    parts.push(agent.soul);
    parts.push('');
    parts.push('### Communication Style');
    parts.push(agent.style);
    parts.push('');
    parts.push('### Role');
    parts.push(agent.roleDescription);
    parts.push('');
    parts.push('### Responsibilities');
    agent.responsibilities.forEach(r => parts.push(`- ${r}`));
    parts.push('');
  });

  // System prompt for each agent
  parts.push('---');
  parts.push('');
  parts.push('## System Prompts (drop-in)');
  parts.push('');
  team.agents.forEach(agent => {
    const teammates = team.agents.filter(a => a.name !== agent.name);
    const reportsTo = getReportsTo(agent.name, team.hierarchy);
    const directs = getDirects(agent.name, team.hierarchy);
    const sys = buildSystemPrompt(agent, theme, teammates, reportsTo, directs);
    parts.push(`### ${agent.name}`);
    parts.push('```');
    parts.push(sys);
    parts.push('```');
    parts.push('');
  });

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════════

function getReportsTo(name, hierarchy) {
  if (!hierarchy || !hierarchy.tree) return null;
  for (const [parent, children] of Object.entries(hierarchy.tree)) {
    if (children.includes(name)) return parent;
  }
  return null;
}

function getDirects(name, hierarchy) {
  if (!hierarchy || !hierarchy.tree) return [];
  return hierarchy.tree[name] || [];
}

function buildSystemPrompt(agent, theme, teammates, reportsTo, directs) {
  const parts = [
    `You are ${agent.name}, the ${agent.role} of the "${theme}" agent team.`,
    '',
    agent.soul,
    '',
    '## Your Role',
    '',
    agent.roleDescription,
    '',
    '## How You Communicate',
    '',
    agent.style,
    '',
    '## Your Responsibilities',
    '',
    ...agent.responsibilities.map(r => `- ${r}`),
    '',
    '## Team',
    '',
    `You are part of the "${theme}" team.`,
  ];
  if (reportsTo) parts.push(`You report to ${reportsTo}.`);
  if (directs && directs.length > 0) parts.push(`You manage: ${directs.join(', ')}.`);
  parts.push('', 'Other team members:');
  teammates.forEach(a => parts.push(`- ${a.name} (${a.role}): ${a.oneLiner}`));
  parts.push('', `Stay in character. Be helpful, be ${agent.vibe.split(',')[0].trim().toLowerCase()}, and bring your unique personality to every interaction.`);
  return parts.join('\n');
}

function renderHierarchyLines(hierarchy) {
  const lines = [];
  function walk(name, tree, indent) {
    lines.push(`${indent}${name}`);
    (tree[name] || []).forEach(c => walk(c, tree, indent + '  ↳ '));
  }
  walk(hierarchy.root, hierarchy.tree, '');
  return lines;
}

function buildGenericTeam(theme) {
  return [
    { role: 'Leader', emoji: '👑', vibe: 'Commanding, strategic', soul: `You are the leader of the ${theme} team.`, style: 'Authoritative and clear.', responsibilities: ['Coordination', 'Strategy', 'Priority management', 'Decision making'], roleDescription: 'Team lead.', oneLiner: `The leader of the ${theme} team` },
    { role: 'Specialist', emoji: '🔬', vibe: 'Analytical, precise', soul: `You are the specialist of the ${theme} team.`, style: 'Clear and precise.', responsibilities: ['Research', 'Analysis', 'Quality assurance', 'Technical work'], roleDescription: 'Technical specialist.', oneLiner: `The specialist of the ${theme} team` },
    { role: 'Operator', emoji: '⚡', vibe: 'Fast, resourceful', soul: `You are the operator of the ${theme} team.`, style: 'Direct and efficient.', responsibilities: ['Execution', 'Operations', 'Deployment', 'Monitoring'], roleDescription: 'Operations lead.', oneLiner: `The operator of the ${theme} team` },
    { role: 'Communicator', emoji: '💬', vibe: 'Charismatic, social', soul: `You are the communicator of the ${theme} team.`, style: 'Engaging and adaptive.', responsibilities: ['Communication', 'Documentation', 'User interaction', 'Reporting'], roleDescription: 'Communications lead.', oneLiner: `The communicator of the ${theme} team` },
  ].map((t, i) => ({ ...t, name: `Agent ${i + 1}` }));
}

// ─── File Renderers for Zip ───────────────────────────────

function renderIdentityMd(a) {
  return [
    '# IDENTITY.md', '',
    `- **Name:** ${a.name}`,
    `- **Role:** ${a.role}`,
    `- **Vibe:** ${a.vibe}`,
    `- **Emoji:** ${a.emoji}`,
    `- **Avatar:** avatars/${a.avatarFile || 'avatar.png'}`,
  ].join('\n');
}

function renderSoulMd(a) {
  return [
    `# SOUL.md — ${a.name}`, '',
    '## Core Persona', '',
    a.soul, '',
    '## Communication Style', '',
    a.style, '',
    '## Boundaries', '',
    `- Stay in character as ${a.name}`,
    '- Never break the theme immersion',
    '- Be helpful first, entertaining second',
    '- Know when to be serious vs playful',
  ].join('\n');
}

function renderAgentsMd(agent, theme, teammates, reportsTo, directs) {
  return [
    `# AGENTS.md — ${agent.name}`, '',
    `## Role: ${agent.role}`, '',
    agent.roleDescription, '',
    '## Responsibilities', '',
    ...agent.responsibilities.map(r => `- ${r}`),
    '', '## Team Context', '',
    `Part of the "${theme}" team.`,
    reportsTo ? `- **Reports to:** ${reportsTo}` : '- **Reports to:** nobody (team lead)',
    directs.length > 0 ? `- **Directs:** ${directs.join(', ')}` : null,
    '', '### Team Members', '',
    ...teammates.map(a => `- **${a.name}** — ${a.role}`),
  ].filter(Boolean).join('\n');
}

function renderAgentJson(agent, theme, teammates, reportsTo, directs) {
  return JSON.stringify({
    "$schema": "https://agent-themes.dev/schema/agent.json",
    "version": "1.0",
    "name": agent.name,
    "role": agent.role,
    "team": theme,
    "emoji": agent.emoji,
    "vibe": agent.vibe,
    "identity": { name: agent.name, role: agent.role, vibe: agent.vibe, emoji: agent.emoji, avatar: `avatars/${agent.avatarFile || 'avatar.png'}` },
    "systemPrompt": buildSystemPrompt(agent, theme, teammates, reportsTo, directs),
    "responsibilities": agent.responsibilities,
    "hierarchy": { ...(reportsTo ? { reportsTo } : { isLead: true }), ...(directs.length > 0 ? { directs } : {}) },
    "files": { identity: "IDENTITY.md", soul: "SOUL.md", agents: "AGENTS.md" }
  }, null, 2);
}

function renderUserMd() {
  return ['# USER.md — About Your Human', '', '<!-- Fill this in -->', '', '- **Name:**', '- **Timezone:**', '- **Notes:**'].join('\n');
}

function renderReadme(data) {
  return [
    `# Agent Team: ${data.theme}`, '',
    `Generated by Agent Themes — ${data.createdAt}`, '',
    '## Team Members', '',
    ...data.team.agents.map(a => `- **${a.name}** (${a.emoji} ${a.role}) — ${a.oneLiner}`),
    '', '## Sources', '',
    ...(data.team.sources || []).map(s => `- [${s.title}](${s.url}) (${s.type})`),
    '', '## Hierarchy', '',
    ...(data.team.hierarchy ? renderHierarchyLines(data.team.hierarchy) : ['Flat team']),
    '', '## Quick Start', '',
    '### OpenClaw',
    '1. Copy an agent folder as workspace',
    '2. Place SOUL.md, IDENTITY.md, AGENTS.md, USER.md in root',
    '3. Add openclaw.json (see openclaw.example.json)',
    '4. Add API keys to .env (see .env.example)',
    '5. Run `openclaw gateway start`', '',
    '### Any Agent System',
    '1. Read agent.json for machine-readable config',
    '2. Use systemPrompt field as your system prompt',
    '3. Parse responsibilities and hierarchy for routing', '',
    `Generated: ${data.createdAt}`,
  ].join('\n');
}

function renderTeamJson(data) {
  return JSON.stringify({
    "$schema": "https://agent-themes.dev/schema/team.json",
    "version": "1.0",
    "theme": data.theme,
    "createdAt": data.createdAt,
    "sources": data.team.sources || [],
    "hierarchy": data.team.hierarchy || null,
    "agents": data.team.agents.map(a => ({
      name: a.name, role: a.role, vibe: a.vibe, emoji: a.emoji, oneLiner: a.oneLiner,
      soul: a.soul, style: a.style, roleDescription: a.roleDescription,
      responsibilities: a.responsibilities,
      folder: a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      reportsTo: getReportsTo(a.name, data.team.hierarchy),
      directs: getDirects(a.name, data.team.hierarchy),
    }))
  }, null, 2);
}

function renderDockerCompose(data) {
  const blocks = data.team.agents.map(a => {
    const f = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return [
      `  ${f}:`,
      `    image: openclaw/openclaw:latest`,
      `    volumes:`,
      `      - ./${f}:/workspace`,
      `      - ./${f}/openclaw.json:/root/.openclaw/openclaw.json`,
      `    env_file: .env`,
      `    restart: unless-stopped`,
    ].join('\n');
  }).join('\n\n');
  return [`# Agent Team: ${data.theme}`, `# ${data.createdAt}`, '', 'services:', blocks].join('\n');
}

function renderOpenClawExample() {
  return JSON.stringify({
    "//": "Copy into each agent folder. Add your API keys.",
    "agents": { "defaults": { "model": { "primary": "gemini/gemini-3.1-flash-lite" } } },
    "auth": { "profiles": { "gemini:default": { "provider": "gemini", "mode": "api_key" } } },
    "plugins": { "entries": { "telegram": { "enabled": true, "config": { "botToken": "YOUR_BOT_TOKEN", "allowFrom": ["YOUR_USER_ID"], "dmPolicy": "pairing" } } } },
    "gateway": { "port": 18790, "mode": "local" }
  }, null, 2);
}

function renderEnvExample() {
  return [
    '# API Keys — fill in your own',
    '',
    '# LLM Providers (uncomment what you use)',
    '# GEMINI_API_KEY=your-key-here',
    '# OPENROUTER_API_KEY=your-key-here',
    '# OPENAI_API_KEY=your-key-here',
  ].join('\n');
}

app.listen(PORT, () => {
  console.log(`🎭 Agent Themes running on http://localhost:${PORT}`);
});
