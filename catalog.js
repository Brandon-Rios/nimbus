// Marketplace catalog: ready-made bots (templates) and plugins (MCP connectors).

const ASK = ['Bash(git push*)', 'Bash(rm -rf*)', 'Bash(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*'];

// shape: the avatar look as "hat/glasses[/body/face/extra]" (see HATS, GLASSES, BODIES, FACES, EXTRAS in public/app.js)
export const TEMPLATES = [];
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
