export interface ToolCategory {
  id: string;
  label: string;
  description: string;
  tools: string[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'search',
    label: 'Search & State',
    description: 'Find entities, get current states, search devices',
    tools: [
      'ha_search_entities',
      'ha_deep_search',
      'ha_get_state',
      'ha_get_states',
      'ha_get_overview',
      'ha_get_entity',
      'ha_get_device',
      'ha_list_services',
    ],
  },
  {
    id: 'control',
    label: 'Device Control',
    description: 'Turn on/off lights, switches, call services, bulk control',
    tools: [
      'ha_call_service',
      'ha_bulk_control',
      'ha_get_operation_status',
      'ha_get_bulk_status',
    ],
  },
  {
    id: 'automation',
    label: 'Automations & Scripts',
    description: 'Create, edit, delete, debug automations and scripts',
    tools: [
      'ha_config_get_automation',
      'ha_config_set_automation',
      'ha_config_remove_automation',
      'ha_get_automation_traces',
      'ha_config_get_script',
      'ha_config_set_script',
      'ha_config_remove_script',
      'ha_get_blueprint',
      'ha_import_blueprint',
    ],
  },
  {
    id: 'config',
    label: 'Configuration',
    description: 'Areas, floors, groups, labels, helpers, zones, entities, integrations',
    tools: [
      'ha_config_list_areas',
      'ha_config_set_area',
      'ha_config_remove_area',
      'ha_config_list_floors',
      'ha_config_set_floor',
      'ha_config_remove_floor',
      'ha_config_list_groups',
      'ha_config_set_group',
      'ha_config_remove_group',
      'ha_config_get_label',
      'ha_config_set_label',
      'ha_config_remove_label',
      'ha_config_list_helpers',
      'ha_config_set_helper',
      'ha_config_remove_helper',
      'ha_get_helper_schema',
      'ha_get_zone',
      'ha_set_zone',
      'ha_remove_zone',
      'ha_set_entity',
      'ha_rename_entity',
      'ha_rename_entity_and_device',
      'ha_get_entity_exposure',
      'ha_set_config_entry_helper',
      'ha_get_integration',
      'ha_set_integration_enabled',
      'ha_delete_config_entry',
      'ha_config_info',
    ],
  },
  {
    id: 'dashboard',
    label: 'Dashboards',
    description: 'Create, edit dashboards and cards',
    tools: [
      'ha_config_get_dashboard',
      'ha_config_set_dashboard',
      'ha_config_delete_dashboard',
      'ha_config_list_dashboard_resources',
      'ha_config_set_dashboard_resource',
      'ha_config_delete_dashboard_resource',
      'ha_dashboard_find_card',
      'ha_get_dashboard_guide',
      'ha_get_card_documentation',
    ],
  },
  {
    id: 'history',
    label: 'History & Monitoring',
    description: 'Sensor history, statistics, logbook, camera snapshots',
    tools: [
      'ha_get_history',
      'ha_get_statistics',
      'ha_get_logbook',
      'ha_get_camera_image',
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar & Todos',
    description: 'Calendar events, todo lists',
    tools: [
      'ha_config_get_calendar_events',
      'ha_config_set_calendar_event',
      'ha_config_remove_calendar_event',
      'ha_get_todo',
      'ha_add_todo_item',
      'ha_update_todo_item',
      'ha_remove_todo_item',
    ],
  },
  {
    id: 'system',
    label: 'System & Maintenance',
    description: 'System info, updates, backups, add-ons, restart, reload',
    tools: [
      'ha_get_system_health',
      'ha_check_config',
      'ha_restart',
      'ha_reload_core',
      'ha_get_updates',
      'ha_get_addon',
      'ha_backup_create',
      'ha_backup_restore',
      'ha_eval_template',
      'ha_get_domain_docs',
      'ha_update_device',
      'ha_remove_device',
      'ha_report_issue',
    ],
  },
  {
    id: 'hacs',
    label: 'HACS',
    description: 'HACS integrations: search, install, update community add-ons',
    tools: [
      'ha_hacs_search',
      'ha_hacs_info',
      'ha_hacs_list_installed',
      'ha_hacs_repository_info',
      'ha_hacs_add_repository',
      'ha_hacs_download',
    ],
  },
  {
    id: 'shell',
    label: 'Shell & Files',
    description: 'Run shell commands: file read/write/edit, system info, network. Use async=true for long-running commands.',
    tools: ['shell_exec', 'shell_job_result'],
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Web browsing: navigate, snapshot, screenshot, screenshot_analyze (vision AI), click, type. Enable with BROWSER_ENABLED=true.',
    tools: ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_screenshot_analyze', 'browser_click', 'browser_type', 'browser_close'],
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Analyze images (e.g. photos sent by user). Use vision_analyze_image with file path.',
    tools: ['vision_analyze_image'],
  },
  {
    id: 'schedule',
    label: 'Reminders & scheduled tasks',
    description:
      'Schedule one-time reminders ("remind me in 1 hour") and daily recurring tasks ("weather every morning at 10").',
    tools: ['schedule_reminder', 'schedule_daily', 'schedule_weekly', 'schedule_list', 'schedule_cancel'],
  },
  {
    id: 'gemini_cli',
    label: 'Gemini CLI delegation',
    description:
      'Delegate larger coding tasks to Gemini CLI (runs in background, auto-approves). For multi-file refactors, complex features.',
    tools: ['gemini_cli_delegate', 'gemini_cli_status'],
  },
  {
    id: 'agent',
    label: 'Agent self-configuration',
    description: 'Read or change agent config (LLM provider, model) at runtime.',
    tools: ['agent_config_get', 'agent_config_set'],
  },
];

/** HA categories that are loaded on demand via triage (not in base). */
export const TRIAGE_HA_CATEGORY_IDS = [
  'automation',
  'config',
  'dashboard',
  'history',
  'calendar',
  'system',
  'hacs',
] as const;

/** Tools always loaded (no triage). Includes: shell, browser, vision, schedule, gemini_cli, agent, HA search + control. */
export function getAlwaysLoadedToolNames(): Set<string> {
  const tools = new Set<string>();
  for (const id of ['shell', 'browser', 'vision', 'schedule', 'gemini_cli', 'agent']) {
    const cat = TOOL_CATEGORIES.find((c) => c.id === id);
    if (cat) for (const t of cat.tools) tools.add(t);
  }
  for (const id of ['search', 'control']) {
    const cat = TOOL_CATEGORIES.find((c) => c.id === id);
    if (cat) for (const t of cat.tools) tools.add(t);
  }
  return tools;
}

export function getCategoryIds(): string[] {
  return TOOL_CATEGORIES.map((c) => c.id);
}

export function getToolsForCategories(categoryIds: string[]): Set<string> {
  const tools = new Set<string>();
  for (const id of categoryIds) {
    const cat = TOOL_CATEGORIES.find((c) => c.id === id);
    if (cat) {
      for (const tool of cat.tools) tools.add(tool);
    }
  }
  return tools;
}

export function buildCategoryListForPrompt(): string {
  return TOOL_CATEGORIES.map(
    (c) => `- "${c.id}": ${c.description}`
  ).join('\n');
}

/** Category list for triage: only on-demand HA categories. Base tools are always loaded. */
export function buildTriageCategoryListForPrompt(): string {
  return TRIAGE_HA_CATEGORY_IDS.map((id) => {
    const cat = TOOL_CATEGORIES.find((c) => c.id === id);
    return cat ? `- "${cat.id}": ${cat.description}` : null;
  })
    .filter(Boolean)
    .join('\n');
}
