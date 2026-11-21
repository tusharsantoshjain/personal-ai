import type { Config } from '../config.ts';
import { strings, textHits } from './outgoing.ts';
import type { Hit, HookInput } from './types.ts';

export const MCP_IGNORE = /claude-in-chrome|playwright|claude_docs|computer-use|claude_browser|ide__/i;
export const WRITE_VERB =
  /(^|_)(create|update|delete|send|post|add|edit|remove|transition|share|trash|publish|upload|archive|merge|assign|set|write|put|patch|move|rename|invite|schedule|reply|forward|complete|label|unlabel|mark|untrash|unmark|apply|copy|append|insert|clear)(_|$)/;

export function classifyMcp(cfg: Config, input: HookInput): Hit[] {
  const name = input.tool_name;
  if (MCP_IGNORE.test(name)) return [];
  const tool = (name.split('__').pop() ?? '').toLowerCase();
  const server = name.toLowerCase();
  if (/authenticat/.test(tool)) return [];
  const hits: Hit[] = [];
  let prose = false;
  if (/atlassian|jira|confluence/.test(server)) {
    if (tool === 'addcommenttojiraissue') {
      hits.push({ cat: 'tracker_comment', why: 'Jira comment' });
      prose = true;
    } else if (tool === 'transitionjiraissue') hits.push({ cat: 'tracker_transition', why: 'Jira transition' });
    else if (tool === 'createjiraissue') {
      hits.push({ cat: 'tracker_create', why: 'Jira issue create' });
      prose = true;
    } else if (/^(editjiraissue|addworklogtojiraissue|createissuelink)$/.test(tool)) {
      hits.push({ cat: 'tracker_edit', why: `Jira ${tool}` });
      prose = true;
    } else if (/^(create|update)confluence/.test(tool)) {
      hits.push({ cat: 'wiki_write', why: `Confluence ${tool}` });
      prose = true;
    }
  } else if (/slack/.test(server)) {
    if (/draft/.test(tool)) return [];
    if (
      /send_message|schedule_message|canvas|create_conversation|list_record|create_list|update_list|complete_file_upload|add_reaction/.test(
        tool,
      )
    )
      hits.push({ cat: 'chat_send', why: `Slack ${tool}` });
  } else if (/gmail|mail/.test(server)) {
    if (/draft/.test(tool)) return [];
    if (/^(send_message|reply|forward)$/.test(tool)) hits.push({ cat: 'email_send', why: `email ${tool}` });
    else if (WRITE_VERB.test(tool)) hits.push({ cat: 'mail_edit', why: `mail ${tool}` });
  } else if (/drive|docs|sheets/.test(server) && WRITE_VERB.test(tool))
    hits.push({ cat: 'drive_write', why: `Drive ${tool}` });
  else if (/datadog|sentry/.test(server) && WRITE_VERB.test(tool))
    hits.push({ cat: 'error_tracker_write', why: `${tool}` });
  else if (WRITE_VERB.test(tool)) hits.push({ cat: 'connector_write', why: `connector write ${name}` });
  if (hits.length) {
    const text = strings(input.tool_input)
      .filter((s) => s.length > 2)
      .join('\n\n');
    hits.push(...textHits(cfg, text, 'outgoing text', prose));
  }
  return hits;
}
