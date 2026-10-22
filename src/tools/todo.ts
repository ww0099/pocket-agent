import { z } from 'zod';

import { type Tool, defineTool } from './base.js';

const TodoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().optional(),
});

const TodoInputSchema = z.object({
  todos: z.array(TodoItemSchema).max(100),
});

const ICONS = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
} as const;

export const todoTool: Tool = defineTool({
  name: 'TodoWrite',
  description: '维护当前任务的待办清单。用于规划多步骤工作、标记进度；完成后及时更新。',
  inputSchema: TodoInputSchema,
  // 只修改内存中的待办状态，不触碰文件系统；不触发写权限审批。
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = TodoInputSchema.parse(input);
    ctx.todos.splice(0, ctx.todos.length, ...args.todos);

    if (args.todos.length === 0) {
      return { output: '待办清单已清空', isError: false };
    }

    const lines = args.todos.map((todo) => `${ICONS[todo.status]} ${todo.content}`);
    return {
      output: `待办清单已更新（${args.todos.length} 项）：\n${lines.join('\n')}`,
      isError: false,
      metadata: { count: args.todos.length },
    };
  },
});
