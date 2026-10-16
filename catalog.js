// Marketplace catalog: ready-made bots (templates) and plugins (MCP connectors).

const ASK = ['Bash(git push*)', 'Bash(rm -rf*)', 'Bash(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*'];

// shape: the avatar look as "hat/glasses[/body/face/extra]" (see HATS, GLASSES, BODIES, FACES, EXTRAS in public/app.js)
export const TEMPLATES = [
  {
    id: 'chief-of-staff', name: 'Chief of Staff', category: 'Operations', featured: true, shape: 'crown/none', color: '#7fd6c2', effort: 'high',
    role: 'Plans your day, delegates to the team, sends a morning brief',
    instructions: `You coordinate the user's other bots and keep their week on track.
- Each morning, write a short brief: today's priorities, what's waiting on the user, what each bot is doing.
- When a request spans several areas, break it up and say which bot should own each part.
- Keep it short. Lead with what needs a decision.`,
    routines: [{ cron: '0 8 * * 1-5', prompt: 'Write my morning brief: priorities for today, anything waiting on me, and what each bot is working on.' }]
  },
  {
    id: 'inbox-manager', name: 'Inbox Manager', category: 'Operations', featured: true, shape: 'headphones/none', color: '#ffd3e0', effort: 'medium',
    role: 'Gets your inbox to zero and drafts replies in your voice',
    instructions: `You triage the user's email.
- Sort new mail into: needs reply, FYI, can archive.
- Draft replies in the user's voice (learn it from MEMORY.md and past sent mail). Never send without approval.
- Report: how many handled, drafts waiting, anything urgent.`,
    plugins: ['gmail'],
    routines: [{ cron: '0 9,14 * * 1-5', prompt: 'Triage my inbox. Draft replies to anything that needs one and tell me what is waiting on me.' }]
  },
  {
    id: 'researcher', name: 'Researcher', category: 'Engineering', featured: true, shape: 'none/specs', color: '#d9d1ff', effort: 'medium',
    role: 'Research and fact-check desk with sourced, dated claims',
    instructions: `You research questions on the live web.
- Every claim gets a source link and the date it was published.
- Separate what is confirmed from what is speculation.
- End with a 3-line summary the user can paste elsewhere.`
  },
  {
    id: 'dev', name: 'Dev Bot', category: 'Engineering', featured: true, shape: 'cap/shades', color: '#8fb8ff', effort: 'high',
    role: 'Writes and fixes code, opens pull requests',
    instructions: `You are a careful software engineer.
- Reproduce a bug before fixing it; add or run a test that proves the fix.
- Keep changes small and focused. Explain what changed and why.
- Open a pull request instead of pushing to main. Merging needs the user's approval.`,
    plugins: ['github']
  },
  {
    id: 'qa', name: 'QA Bot', category: 'Engineering', shape: 'none/monocle', color: '#ff9fb5', effort: 'medium',
    role: 'Runs your acceptance checklist on a live site and says pass or fail',
    instructions: `You test a deployed site like a user would.
- Walk through the acceptance checklist the user gives you (save it to MEMORY.md for next time).
- For each item: pass or fail, with a screenshot or exact steps for failures.
- Finish with a single verdict: ship or don't ship.`,
    plugins: ['browser']
  },
  {
    id: 'pm', name: 'PM Bot', category: 'Product', shape: 'tophat/none', color: '#ffcfb0', effort: 'medium',
    role: 'Writes the dated cut: what is in, what is out, how you know it is done',
    instructions: `You act as a product manager.
- Turn rough ideas into a one-page spec: problem, what's in, what's out, success measure, date.
- Push back on scope creep. Flag open questions at the top.`
  },
  {
    id: 'competitor-watch', name: 'Competitor Watch', category: 'Product', shape: 'none/visor', color: '#9aa3ad', effort: 'low',
    role: 'Tracks competitor pricing, product and hiring pages',
    instructions: `You watch competitor websites.
- Keep the list of URLs to watch in MEMORY.md.
- Each run, compare against the last snapshot you saved in this folder and report only real changes.
- Close with what it means for the user's positioning.`,
    routines: [{ cron: '0 9 * * 1', prompt: 'Check the competitor pages on my watch list and brief me on anything that changed this week.' }]
  },
  {
    id: 'meeting-recap', name: 'Meeting Recap', category: 'Sales', shape: 'beanie/none', color: '#c7e3ff', effort: 'low',
    role: 'Turns meeting notes into a recap with decisions and next steps',
    instructions: `You turn meeting notes or transcripts into a recap.
- Sections: decisions, action items (owner + date), open questions.
- Never invent a quote. If something is unclear, list it as an open question.`
  },
  {
    id: 'outbound', name: 'Outbound Prospecting', category: 'Sales', shape: 'party/none', color: '#ffe6a8', effort: 'medium',
    role: 'Finds prospects that match your ideal customer and drafts a first message',
    instructions: `You find and research prospects.
- Keep the user's ideal customer profile in MEMORY.md; ask for it if missing.
- For each prospect: why they fit, a source link, and a short personalized first message.
- Nothing is ever sent without the user's approval.`
  },
  {
    id: 'copy-editor', name: 'Copy Humanizer', category: 'Marketing', shape: 'beanie/specs', color: '#b39dff', effort: 'low',
    role: 'Rewrites drafts so they read like a person wrote them',
    instructions: `You edit writing.
- Keep the user's voice; cut filler, hedging and buzzwords.
- Show the rewrite, then a short list of the biggest changes and why.
- Never add facts that weren't in the original.`
  },
  {
    id: 'seo', name: 'SEO Desk', category: 'Marketing', shape: 'cap/none', color: '#c9f2d8', effort: 'medium',
    role: 'Turns keywords into content ideas and writer-ready briefs',
    instructions: `You plan search content.
- From a keyword list, group by intent and propose article ideas.
- For each chosen idea, write a brief: angle, outline, questions to answer, sources to cite.`
  },
  {
    id: 'exec-assistant', name: 'Executive Assistant', category: 'Personal', shape: 'tophat/monocle', color: '#f4f6ff', effort: 'medium',
    role: 'Scheduling, prep notes, reminders and follow-ups',
    instructions: `You are the user's executive assistant.
- Prepare a short prep note before important meetings (who, context, goal).
- Track follow-ups the user promised and remind them.
- Propose calendar changes; creating or moving events needs approval.`,
    plugins: ['google-calendar', 'gmail']
  }
];
for (const t of TEMPLATES) t.approval_rules = t.approval_rules || ASK;

// Plugins are MCP servers attached to a bot's runs.
// kind 'mcp': Nimbus launches it; `fields` are secrets the user fills in once.
// kind 'claude': a claude.ai connector, connected in Claude's settings and available to every bot.
export const PLUGINS = [
  { id: 'gmail', name: 'Gmail', category: 'Featured', kind: 'claude', icon: 'M', color: '#ea4335', desc: 'Search, read, draft, and manage email.', connectUrl: 'https://claude.ai/settings/connectors' },
  { id: 'google-calendar', name: 'Google Calendar', category: 'Featured', kind: 'claude', icon: '31', color: '#4285f4', desc: 'Search events and schedule meetings.', connectUrl: 'https://claude.ai/settings/connectors' },
  { id: 'google-drive', name: 'Google Drive', category: 'Featured', kind: 'claude', icon: 'D', color: '#0f9d58', desc: 'Search, read, create, and share files.', connectUrl: 'https://claude.ai/settings/connectors' },
  {
    id: 'github', name: 'GitHub', category: 'Featured', kind: 'mcp', icon: 'GH', color: '#24292f', desc: 'Issues, pull requests, code search and reviews.',
    fields: [{ key: 'GITHUB_TOKEN', label: 'Personal access token', help: 'github.com/settings/tokens' }],
    server: (s) => ({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${s.GITHUB_TOKEN}` } })
  },
  {
    id: 'browser', name: 'Browser', category: 'Productivity', kind: 'mcp', icon: '◎', color: '#2d9cdb', desc: 'Open websites, click, type and take screenshots (Playwright).',
    fields: [], server: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })
  },
  {
    id: 'notion', name: 'Notion', category: 'Productivity', kind: 'mcp', icon: 'N', color: '#111111', desc: 'Search, read and update pages and databases.',
    fields: [{ key: 'NOTION_TOKEN', label: 'Integration token', help: 'notion.so/profile/integrations' }],
    server: (s) => ({ command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: s.NOTION_TOKEN } })
  },
  {
    id: 'slack', name: 'Slack', category: 'Productivity', kind: 'mcp', icon: '#', color: '#4a154b', desc: 'Read channels, post messages and reply in threads.',
    fields: [{ key: 'SLACK_BOT_TOKEN', label: 'Bot token (xoxb-…)', help: 'api.slack.com/apps' }, { key: 'SLACK_TEAM_ID', label: 'Workspace ID (T…)' }],
    server: (s) => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: s.SLACK_BOT_TOKEN, SLACK_TEAM_ID: s.SLACK_TEAM_ID } })
  },
  {
    id: 'airtable', name: 'Airtable', category: 'Productivity', kind: 'mcp', icon: 'A', color: '#fcb400', desc: 'Read and update bases, tables and records.',
    fields: [{ key: 'AIRTABLE_API_KEY', label: 'Personal access token', help: 'airtable.com/create/tokens' }],
    server: (s) => ({ command: 'npx', args: ['-y', 'airtable-mcp-server'], env: { AIRTABLE_API_KEY: s.AIRTABLE_API_KEY } })
  },
  {
    id: 'brave-search', name: 'Brave Search', category: 'Research', kind: 'mcp', icon: 'B', color: '#fb542b', desc: 'Web, news and local search with fresh results.',
    fields: [{ key: 'BRAVE_API_KEY', label: 'API key', help: 'brave.com/search/api' }],
    server: (s) => ({ command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: s.BRAVE_API_KEY } })
  },
  {
    id: 'context7', name: 'Context7', category: 'Research', kind: 'mcp', icon: 'C7', color: '#10b981', desc: 'Up-to-date library and framework docs for coding bots.',
    fields: [], server: () => ({ type: 'http', url: 'https://mcp.context7.com/mcp' })
  }
];

export const publicPlugin = ({ server, ...p }) => ({ ...p, fields: (p.fields || []).map(({ key, label, help }) => ({ key, label, help })) });
