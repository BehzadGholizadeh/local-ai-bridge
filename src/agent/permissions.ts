import { isInside, type Risk, type Tool, type ToolArgs, type ToolContext } from './tools';

/**
 * - ask (default): reads inside the workspace run automatically; writes, shell commands and
 *   anything outside the workspace ask first.
 * - auto-edit: also file writes inside the workspace run automatically; shell and outside still ask.
 * - full-auto: nothing asks. Only for trusted tasks: the model's instructions can be influenced by
 *   the files and command output it reads.
 */
export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto';
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'full-auto'];

/** allow once, deny, or allow this kind of call for the rest of the session. */
export type Decision = 'allow' | 'deny' | 'always';

export interface ApprovalRequest {
  tool: string;
  args: ToolArgs;
  summary: string;
  risk: Risk;
  /** The call touches paths outside the workspace. */
  outside: boolean;
}

export type Approver = (req: ApprovalRequest) => Promise<Decision>;

export class Permissions {
  private always = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private approver: Approver,
  ) {}

  /** Whether the call may run, asking the user when the mode requires it. */
  async check(tool: Tool, args: ToolArgs, ctx: ToolContext): Promise<boolean> {
    if (this.mode === 'full-auto') return true;
    const outside = tool.paths(args, ctx).some((p) => !isInside(ctx.root, p));
    const automatic = !outside && (tool.risk === 'read' || (tool.risk === 'write' && this.mode === 'auto-edit'));
    if (automatic) return true;
    const key = `${tool.name}${outside ? ':outside' : ''}`;
    if (this.always.has(key)) return true;
    const decision = await this.approver({ tool: tool.name, args, summary: tool.summarize(args), risk: tool.risk, outside });
    if (decision === 'always') this.always.add(key);
    return decision !== 'deny';
  }
}
